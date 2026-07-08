#!/usr/bin/env node
/**
 * Regression tests for the May bug batch (issues #21, #22, #24, #26) plus a
 * guard for the already-fixed #27. Hermetic: spawns the real server on a free
 * port with the native classifier forced to an unusable path, and drives the
 * affected endpoints. No external deps, no network beyond localhost.
 *
 *   #21  /api/constellation reports classifier from an ACTUAL native probe,
 *        not from KANNAKA_BIN file presence. With a binary path that can't
 *        classify, it must report "fallback" (pre-fix: lied "native").
 *   #24  /api/constellation.svg must NOT light the Memory node unless the
 *        native classifier is verified (pre-fix: Memory hardcoded active).
 *   #26  the served page must route large-file progress to #canvasInfo, not a
 *        nonexistent #info-text node (pre-fix: null deref on >1 MB uploads).
 *   #27  /api/radio must preserve an explicit tempo_bpm: 0 as a feature byte
 *        (pre-fix: 0 was treated as falsy/absent and dropped).
 *   #22  attention-bridge parses nats://user:pass@host into user/pass, and a
 *        bare nats://token@host into a token (pre-fix: user:pass sent as one
 *        auth_token).
 *
 * Usage: node tests/bug_batch.mjs   (exit 0 iff all pass)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import http from "http";

import { parseNatsUrl } from "../attention-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EYE_DIR = join(__dirname, "..");

// A path that cannot exist: server.js short-circuits KANNAKA_BIN auto-detect
// on this truthy value, then execFile fails with ENOENT so the native probe
// resolves false. This makes "binary configured but unusable" deterministic
// on every host — the exact condition #21 is about.
const FAKE_BIN = join(__dirname, "__no_native_classifier__", "kannaka");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, timeout: 10000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.end();
  });
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/api/attention/stats", "GET");
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready in ${timeoutMs}ms (last: ${lastErr})`);
}

// Minimal stub of kannaka-radio: answers /api/perception with an explicit
// tempo_bpm of 0 (the #27 edge case) and no other perception fields beyond
// valence/energy.
function startStubRadio() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/perception") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tempo_bpm: 0, valence: 0.5, rms_energy: 0.25 }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function main() {
  // ── #22: pure parser unit tests (no server needed) ──
  {
    const up = parseNatsUrl("nats://alice:secret@127.0.0.1:45229");
    check("#22 user:pass URL → user field", up.user === "alice", `got user=${JSON.stringify(up.user)}`);
    check("#22 user:pass URL → pass field", up.pass === "secret", `got pass=${JSON.stringify(up.pass)}`);
    check("#22 user:pass URL → no token", up.token === null, `got token=${JSON.stringify(up.token)}`);
    check("#22 user:pass URL → host/port", up.host === "127.0.0.1" && up.port === 45229, `got ${up.host}:${up.port}`);

    const tk = parseNatsUrl("nats://sometoken@host:4222");
    check("#22 token URL → token field", tk.token === "sometoken", `got token=${JSON.stringify(tk.token)}`);
    check("#22 token URL → no user/pass", tk.user === null && tk.pass === null, `got user=${tk.user} pass=${tk.pass}`);

    const plain = parseNatsUrl("nats://localhost:4222");
    check("#22 plain URL → no creds", plain.user === null && plain.token === null, `got user=${plain.user} token=${plain.token}`);
  }

  const stub = await startStubRadio();
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js", "--port", String(port)], {
    cwd: EYE_DIR,
    env: {
      ...process.env,
      KANNAKA_BIN: FAKE_BIN,           // native classifier configured but unusable
      EYE_PORT: "",
      NATS_URL: "nats://127.0.0.1:1",  // dead NATS; bridge stays silent
      RADIO_URL: `http://127.0.0.1:${stub.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  try {
    await waitReady(port);

    // ── #21: constellation classifier is honest ──
    {
      const res = await request(port, "/api/constellation", "GET");
      const body = JSON.parse(res.body);
      check("#21 /api/constellation classifier is 'fallback' when native unusable",
        body.classifier === "fallback", `got ${JSON.stringify(body.classifier)}`);
    }

    // ── #24: SVG does not light Memory without a verified probe ──
    {
      const res = await request(port, "/api/constellation.svg", "GET");
      const svg = res.body;
      check("#24 SVG omits Memory node label when native unverified",
        !svg.includes(">Memory<"), "SVG still contains a Memory label");
      check("#24 SVG status text marks memory UNVERIFIED (binary set, probe failed)",
        svg.includes("memory:UNVERIFIED"), `status text: ${(svg.match(/eye:ON[^<]*/) || [""])[0]}`);
    }

    // ── #26: large-file progress targets #canvasInfo, not #info-text ──
    {
      const res = await request(port, "/", "GET");
      const html = res.body;
      check("#26 page routes large-file progress to #canvasInfo",
        html.includes("getElementById('canvasInfo').textContent"),
        "no canvasInfo progress write found");
      check("#26 page has no active #info-text null-deref call",
        !html.includes("getElementById('info-text').textContent"),
        "page still writes to a nonexistent #info-text element");
    }

    // ── #27: explicit tempo_bpm: 0 is preserved ──
    {
      const res = await request(port, "/api/radio", "GET");
      const body = JSON.parse(res.body);
      // features = [tempo(0), valence, rms] — tempo must be present.
      check("#27 /api/radio preserves tempo_bpm:0 (featureCount includes tempo)",
        body.featureCount === 3, `got featureCount=${body.featureCount}, features=${JSON.stringify(body.features)}`);
      check("#27 /api/radio emits the 0 tempo byte first",
        Array.isArray(body.features) && body.features[0] === 0,
        `features=${JSON.stringify(body.features)}`);
    }
  } catch (e) {
    console.error(`Fatal: ${e.message}`);
    console.error("--- server log ---\n" + serverLog);
    failed++;
  } finally {
    child.kill();
    stub.srv.close();
  }

  console.log("---");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
