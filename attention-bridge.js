/**
 * attention-bridge.js — kannaka-eye NATS publisher.
 *
 * Emits `KANNAKA.attention.eye` messages on every classified glyph so the
 * kannaka-attention beam (and any other downstream subscriber) sees a fresh
 * gravity event each time the eye processes input.
 *
 * Plural chiral mirror: each eye process declares a hemisphere — "left" or
 * "right" — via the KANNAKA_EYE_HEMISPHERE env var. Run two instances
 * (KANNAKA_EYE_HEMISPHERE=left on port 3333, =right on 3334) to get the
 * mirror pair. Subscribers can fold both into the same beam, or treat them
 * as separate attention sources.
 *
 * No npm deps — uses raw NATS TCP protocol (PING/PONG + PUB), the same
 * pattern kannaka-radio's nats-client.js uses. Connection is best-effort:
 * a missing NATS server doesn't break HTTP glyph serving.
 */

"use strict";

const net = require("net");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_TOKEN = process.env.NATS_TOKEN || null;
// Oracle NATS uses user/password authz (the kannaka_internal account). The
// KANNAKA.attention.eye subject is not in anon's publish allow-list, so the
// eye must authenticate to emit glyphs.
const NATS_USER = process.env.NATS_USER || null;
const NATS_PASSWORD = process.env.NATS_PASSWORD || null;
const HEMISPHERE = (process.env.KANNAKA_EYE_HEMISPHERE || "left").toLowerCase();
const SUBJECT = "KANNAKA.attention.eye";
const SOURCE_NAME = `kannaka-eye:${HEMISPHERE}`;

function parseNatsUrl(u) {
  // nats://[user:pass@ | token@]host[:port]
  // A credential containing ':' is username/password (NATS authz — the
  // kannaka_internal account uses this); a bare credential is a token.
  // Pre-fix the whole credential was returned as `token`, so a standard
  // `nats://user:pass@host` URL was sent as auth_token and never authed. (#22)
  const m = u.match(/^nats:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/i);
  if (!m) return { host: "localhost", port: 4222, user: null, pass: null, token: null };
  const cred = m[1] || null;
  let user = null, pass = null, token = null;
  if (cred != null) {
    const ci = cred.indexOf(":");
    if (ci >= 0) { user = cred.slice(0, ci); pass = cred.slice(ci + 1); }
    else { token = cred; }
  }
  return {
    host: m[2] || "localhost",
    port: m[3] ? parseInt(m[3], 10) : 4222,
    user,
    pass,
    token,
  };
}

class AttentionBridge {
  constructor() {
    this._client = null;
    this._connected = false;
    this._buffer = "";
    this._reconnectTimer = null;
    this._published = 0;
    this._dropped = 0;
  }

  connect() {
    const parsed = parseNatsUrl(NATS_URL);
    const { host, port } = parsed;
    // Auth precedence (#22): explicit env vars win, then credentials embedded
    // in NATS_URL. user/pass (if present) takes precedence over a token so a
    // `nats://user:pass@host` URL authenticates instead of being sent as a
    // bare token.
    let user = null, pass = null, authToken = null;
    if (NATS_USER) { user = NATS_USER; pass = NATS_PASSWORD || ""; }
    else if (parsed.user) { user = parsed.user; pass = parsed.pass || ""; }
    if (NATS_TOKEN) authToken = NATS_TOKEN;
    else if (!user && parsed.token) authToken = parsed.token;
    const authMode = user ? "user" : authToken ? "token" : "none";
    const sock = net.createConnection({ host, port }, () => {
      // Wait for INFO before sending CONNECT (per NATS protocol).
    });
    sock.setEncoding("utf-8");
    sock.on("data", (chunk) => {
      this._buffer += chunk;
      const lines = this._buffer.split("\r\n");
      this._buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("INFO ")) {
          // Send CONNECT — minimal, no subscriptions needed (publish-only).
          const connect = { verbose: false, pedantic: false, lang: "node-raw", name: SOURCE_NAME, protocol: 1 };
          // user/pass and token are mutually exclusive auth modes; prefer
          // user/pass when we have it.
          if (user) { connect.user = user; connect.pass = pass; }
          else if (authToken) connect.auth_token = authToken;
          sock.write(`CONNECT ${JSON.stringify(connect)}\r\n`);
          // Send PING to test the connection.
          sock.write("PING\r\n");
        } else if (line === "PONG") {
          if (!this._connected) {
            this._connected = true;
            console.log(`[attention-bridge] connected to ${host}:${port} (hemisphere=${HEMISPHERE}, auth=${authMode})`);
          }
        } else if (line === "PING") {
          sock.write("PONG\r\n");
        } else if (line.startsWith("-ERR")) {
          console.warn(`[attention-bridge] NATS error: ${line}`);
        }
      }
    });
    sock.on("error", (e) => {
      if (this._connected) console.warn(`[attention-bridge] socket error: ${e.message}`);
      this._connected = false;
    });
    sock.on("close", () => {
      this._connected = false;
      this._client = null;
      this._scheduleReconnect();
    });
    this._client = sock;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  /**
   * Publish a glyph event. Best-effort: returns true on send, false if
   * disconnected. The HTTP path keeps working regardless.
   *
   * @param {object} glyph  Output of /api/process (foldSequence, amplitudes, ...)
   * @param {string} sourceType "text" | "bytes" | "numbers"
   */
  publishGlyph(glyph, sourceType) {
    if (!this._connected || !this._client) {
      this._dropped++;
      return false;
    }
    // Canonical envelope per consciousness-core/docs/nats-contract.yaml:
    //   schema_version: "1.0" (string)
    //   ts:             unix-ms (number)
    //   agent_id:       publisher identity
    // Pre-fix the eye emitted schema_version: 1 + ISO ts, forcing every
    // downstream consumer to special-case the eye instead of treating
    // it as a normal constellation producer. (#5)
    const envelope = {
      schema_version: "1.0",
      ts: Date.now(),
      agent_id: process.env.EYE_AGENT_ID || "kannaka-eye",
      source: SOURCE_NAME,
      hemisphere: HEMISPHERE,
      source_type: sourceType || glyph.sourceType || "unknown",
      glyph: {
        fold_sequence: glyph.foldSequence,
        amplitudes: glyph.amplitudes,
        phases: glyph.phases,
        fano_signature: glyph.fanoSignature,
        centroid: glyph.centroid,
        dominant_class: glyph.dominantClass,
        classes_used: glyph.classesUsed,
        total_energy: glyph.totalEnergy,
        compression_ratio: glyph.compressionRatio,
        classifier: glyph.classifier,
      },
    };
    const payload = JSON.stringify(envelope);
    const payloadBytes = Buffer.byteLength(payload, "utf-8");
    try {
      this._client.write(`PUB ${SUBJECT} ${payloadBytes}\r\n${payload}\r\n`);
      this._published++;
      return true;
    } catch (e) {
      console.warn(`[attention-bridge] publish failed: ${e.message}`);
      return false;
    }
  }

  stats() {
    return { connected: this._connected, hemisphere: HEMISPHERE, published: this._published, dropped: this._dropped };
  }
}

module.exports = { AttentionBridge, HEMISPHERE, SUBJECT, parseNatsUrl };
