#!/usr/bin/env node
/**
 * SGA self-consistency tests for kannaka-eye.
 *
 * CONTRACT — what this test checks (and, importantly, what it does NOT):
 *
 *   This is a GOLDEN / self-consistency test of the eye's OWN JavaScript SGA
 *   decode. It spawns the real server, forces the JS classifier (the native
 *   kannaka binary is deliberately disabled), sends each reference input
 *   through /api/process, and asserts the response matches the committed
 *   golden vectors in tests/sga_reference_vectors.json. Its job is to catch
 *   *drift in the eye's JS classifier* — if someone changes classifyData /
 *   classifyText / createFoldSequence / computeFanoSignature and the emitted
 *   glyph moves, this test goes red.
 *
 *   It does NOT check alignment with the canonical Rust GlyphEncoder. The eye's
 *   JS decode intentionally diverges from canonical: JS is an 84-class scheme
 *   (21*h2 + 7*d + l, l in 0..6, the l=0 origin point contributes no Fano line
 *   by design), while canonical Rust is a 96-class scheme (%8). That divergence
 *   is by design, not a bug — do not "fix" it here. Canonical alignment is
 *   verified separately by kannaka-memory's Rust suite
 *   (tests/sga_consistency.rs against its own copy of the reference vectors).
 *
 *   Because canonical alignment requires the native binary (absent in CI) and
 *   the vectors live in a sibling repo (not checked out in CI), the only
 *   contract that can genuinely gate in kannaka-eye CI is JS self-consistency —
 *   which is what this file now enforces, hermetically, with no external deps.
 *
 * To regenerate the golden vectors after an INTENTIONAL classifier change,
 * re-run the generator that produced them (POST each canonical input through a
 * JS-forced /api/process and record dominant_class / centroid / fano_signature
 * / classes_used).
 *
 * Usage:
 *   node tests/sga_consistency.mjs
 *
 * Exit code 0 iff every reference vector matches; 1 otherwise.
 */

import { readFileSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EYE_DIR = join(__dirname, "..");
const VECTORS_PATH = join(__dirname, "sga_reference_vectors.json");

// A path that cannot exist. server.js resolves KANNAKA_BIN from this env var
// first (truthy short-circuits its auto-detect), then execFile fails with
// ENOENT, so classifyNative() returns null and /api/process uses the JS
// fallback. This makes the test deterministic on every host — including Nick's
// box where the real kannaka.exe is present two dirs over.
const FORCE_JS_BIN = join(__dirname, "__no_native_classifier__", "kannaka");

const FLOAT_TOL = 1e-10;

// Load golden vectors
let vectors;
try {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8"));
} catch (e) {
  console.error(`Failed to load reference vectors from ${VECTORS_PATH}: ${e.message}`);
  process.exit(1);
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

function request(port, path, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : {},
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/api/attention/stats", "GET", null);
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready in ${timeoutMs}ms (last: ${lastErr})`);
}

/**
 * Prepare the /api/process payload for a reference vector.
 *   text         -> { data: <string>, type: "text" }
 *   bytes / file -> { data: <number[]>, type: "bytes" }
 */
function buildPayload(vec) {
  if (vec.input_type === "text") return { data: vec.input, type: "text" };
  return { data: vec.input_bytes, type: "bytes" };
}

async function main() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js", "--port", String(port)], {
    cwd: EYE_DIR,
    // Force JS fallback; keep the server off any real NATS by pointing it at a
    // dead port (the attention bridge is best-effort and stays silent).
    env: { ...process.env, KANNAKA_BIN: FORCE_JS_BIN, EYE_PORT: "", NATS_URL: "nats://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  let passed = 0;
  let failed = 0;

  try {
    await waitReady(port);

    console.log(`SGA Self-Consistency Tests — eye JS classifier @ 127.0.0.1:${port}`);
    console.log(`Loaded ${vectors.length} golden vectors from ${VECTORS_PATH}`);
    console.log("---");

    for (const vec of vectors) {
      let result;
      try {
        const res = await request(port, "/api/process", "POST", buildPayload(vec));
        if (res.status !== 200) {
          console.log(`FAIL  ${vec.id}: HTTP ${res.status} — ${res.body.slice(0, 200)}`);
          failed++;
          continue;
        }
        result = JSON.parse(res.body);
      } catch (e) {
        console.log(`FAIL  ${vec.id}: request error — ${e.message}`);
        failed++;
        continue;
      }

      const problems = [];

      // Guard: this test only certifies the JS decode. If the server somehow
      // answered from the native classifier, the comparison is meaningless.
      if (result.classifier !== "fallback") {
        problems.push(`classifier: got "${result.classifier}" expected "fallback" (native must be disabled)`);
      }

      const gotDominant = result.dominantClass ?? result.dominant_class;
      if (gotDominant !== vec.expected.dominant_class) {
        problems.push(`dominant_class: got ${gotDominant} expected ${vec.expected.dominant_class}`);
      }

      const gotCentroid = result.centroid;
      const expCentroid = vec.expected.centroid;
      if (gotCentroid) {
        for (const k of ["h2", "d", "l"]) {
          if (gotCentroid[k] !== expCentroid[k]) {
            problems.push(`centroid.${k}: got ${gotCentroid[k]} expected ${expCentroid[k]}`);
          }
        }
      } else {
        problems.push("centroid: missing from response");
      }

      const gotFano = result.fanoSignature ?? result.fano_signature;
      if (Array.isArray(gotFano)) {
        for (let i = 0; i < 7; i++) {
          const diff = Math.abs((gotFano[i] || 0) - (vec.expected.fano_signature[i] || 0));
          if (diff > FLOAT_TOL) {
            problems.push(`fano_signature[${i}]: got ${gotFano[i]} expected ${vec.expected.fano_signature[i]}`);
          }
        }
      } else {
        problems.push("fano_signature: missing or not an array");
      }

      const gotClasses = result.classesUsed ?? result.classes_used;
      if (gotClasses !== vec.expected.classes_used) {
        problems.push(`classes_used: got ${gotClasses} expected ${vec.expected.classes_used}`);
      }

      if (problems.length === 0) {
        console.log(`PASS  ${vec.id}: ${vec.description}`);
        passed++;
      } else {
        console.log(`FAIL  ${vec.id}: ${vec.description}`);
        for (const p of problems) console.log(`        ${p}`);
        failed++;
      }
    }
  } catch (e) {
    console.error(`Fatal: ${e.message}`);
    console.error("--- server log ---\n" + serverLog);
    child.kill();
    process.exit(1);
  } finally {
    child.kill();
  }

  console.log("---");
  console.log(`Results: ${passed} passed, ${failed} failed, ${vectors.length} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
