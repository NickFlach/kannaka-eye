#!/usr/bin/env node
/**
 * SGA consistency tests for kannaka-eye.
 *
 * Reads the reference vectors from kannaka-memory/tests/sga_reference_vectors.json,
 * sends each input through the eye /api/process endpoint, and verifies that
 * dominant_class and centroid match the expected values.
 *
 * Prerequisites:
 *   - kannaka-eye server running on localhost:3333
 *     (start with: node server.js --port 3333)
 *
 * Usage:
 *   node tests/sga_consistency.mjs [--port 3333]
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse port from args
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3333 : 3333;

// Load reference vectors
const vectorsPath = join(__dirname, "..", "..", "kannaka-memory", "tests", "sga_reference_vectors.json");
let vectors;
try {
  vectors = JSON.parse(readFileSync(vectorsPath, "utf-8"));
} catch (e) {
  console.error(`Failed to load reference vectors from ${vectorsPath}: ${e.message}`);
  process.exit(1);
}

/**
 * POST JSON to the eye /api/process endpoint.
 * Returns a Promise resolving to the parsed JSON response.
 */
function callProcess(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/api/process",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Prepare the /api/process payload for a reference vector.
 * The eye server accepts { data, type } where:
 *   type "text"  -> data is a string
 *   type "bytes" -> data is an array of byte values
 */
function buildPayload(vec) {
  if (vec.input_type === "text") {
    return { data: vec.input, type: "text" };
  }
  // For bytes and file_pattern, send as byte array
  return { data: vec.input_bytes, type: "bytes" };
}

async function main() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(`SGA Consistency Tests — eye @ localhost:${PORT}`);
  console.log(`Loaded ${vectors.length} reference vectors from ${vectorsPath}`);
  console.log("---");

  for (const vec of vectors) {
    const payload = buildPayload(vec);
    let result;

    try {
      result = await callProcess(payload);
    } catch (e) {
      console.log(`FAIL  ${vec.id}: request error — ${e.message}`);
      failed++;
      failures.push({ id: vec.id, reason: e.message });
      continue;
    }

    if (result.error) {
      console.log(`FAIL  ${vec.id}: server error — ${result.error}`);
      failed++;
      failures.push({ id: vec.id, reason: result.error });
      continue;
    }

    const problems = [];

    // Check dominant_class
    // Eye returns dominantClass (camelCase) from native classifier
    const gotDominant = result.dominantClass ?? result.dominant_class;
    if (gotDominant !== vec.expected.dominant_class) {
      problems.push(
        `dominant_class: got ${gotDominant} expected ${vec.expected.dominant_class}`
      );
    }

    // Check centroid
    const gotCentroid = result.centroid;
    const expCentroid = vec.expected.centroid;
    if (gotCentroid) {
      if (gotCentroid.h2 !== expCentroid.h2) {
        problems.push(`centroid.h2: got ${gotCentroid.h2} expected ${expCentroid.h2}`);
      }
      if (gotCentroid.d !== expCentroid.d) {
        problems.push(`centroid.d: got ${gotCentroid.d} expected ${expCentroid.d}`);
      }
      if (gotCentroid.l !== expCentroid.l) {
        problems.push(`centroid.l: got ${gotCentroid.l} expected ${expCentroid.l}`);
      }
    } else {
      problems.push("centroid: missing from response");
    }

    // Check fano_signature (loose tolerance for float comparison)
    const gotFano = result.fanoSignature ?? result.fano_signature;
    if (gotFano && Array.isArray(gotFano)) {
      for (let i = 0; i < 7; i++) {
        const diff = Math.abs((gotFano[i] || 0) - (vec.expected.fano_signature[i] || 0));
        if (diff > 1e-10) {
          problems.push(
            `fano_signature[${i}]: got ${gotFano[i]} expected ${vec.expected.fano_signature[i]}`
          );
        }
      }
    }

    if (problems.length === 0) {
      console.log(`PASS  ${vec.id}: ${vec.description}`);
      passed++;
    } else {
      console.log(`FAIL  ${vec.id}: ${vec.description}`);
      for (const p of problems) {
        console.log(`        ${p}`);
      }
      failed++;
      failures.push({ id: vec.id, problems });
    }
  }

  console.log("---");
  console.log(`Results: ${passed} passed, ${failed} failed, ${vectors.length} total`);

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
