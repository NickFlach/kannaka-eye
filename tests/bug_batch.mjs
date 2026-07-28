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
 *   #48  startup does not announce "Native classifier: <path>" for a path it
 *        never checked; an explicit-but-missing KANNAKA_BIN warns instead.
 *   #35  the attention bridge honours the constellation-wide
 *        KANNAKA_NATS_URL (pre-fix: only the generic NATS_URL was read, so a
 *        correctly-configured box silently published to localhost:4222).
 *   #37  a fallback-classified /api/radio glyph still carries
 *        levelDistribution (pre-fix: buildGlyphFromBytes omitted it, so the
 *        viewer's resonance-ring layer silently did not render).
 *   #38  the Radio preset renders the glyph /api/radio already returned
 *        instead of re-POSTing to /api/process (pre-fix: one radio click
 *        published the same listening event to attention twice, the second
 *        time mislabelled "bytes" instead of "audio").
 *   #41  /api/constellation exposes a `memory` object instead of forcing
 *        callers to infer memory status from the `classifier` string.
 *   #43  the viewer renders dominantClass 0 as "0", not an em dash (pre-fix:
 *        `|| '—'` treated a legitimate class 0 as "no data").
 *   #46  /api/constellation and constellation.svg report attention-bridge
 *        state (pre-fix: a dead Eye->Attention link left every surface
 *        looking healthy while glyphs were silently dropped).
 *   #47  a fatal NATS -ERR drops the socket so the 5s reconnect fires
 *        (pre-fix: -ERR only logged, and _scheduleReconnect() is reachable
 *        only from 'close' — a broker that rejected auth without closing left
 *        the bridge permanently dead).
 *
 * Usage: node tests/bug_batch.mjs   (exit 0 iff all pass)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import http from "http";

import { AttentionBridge, parseNatsUrl, isFatalNatsError, resolveNatsUrl, DEFAULT_NATS_URL } from "../attention-bridge.js";

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

  // ── #35: KANNAKA_NATS_URL is the constellation-wide setting ──
  //
  // The bridge read only the generic NATS_URL, so a box configured the
  // constellation way silently fell back to localhost:4222 and published
  // attention into a broker nobody was listening to.
  {
    check("#35 KANNAKA_NATS_URL is honoured",
      resolveNatsUrl({ KANNAKA_NATS_URL: "nats://broker:4222" }) === "nats://broker:4222");
    check("#35 KANNAKA_NATS_URL outranks the generic NATS_URL",
      resolveNatsUrl({ KANNAKA_NATS_URL: "nats://specific:4222", NATS_URL: "nats://generic:4222" }) === "nats://specific:4222",
      "the constellation-specific name must win, same rule as RADIO_PORT over PORT");
    check("#35 NATS_URL still works when KANNAKA_NATS_URL is unset",
      resolveNatsUrl({ NATS_URL: "nats://legacy:4222" }) === "nats://legacy:4222",
      "existing deployments must not break");
    check("#35 falls back to localhost when neither is set",
      resolveNatsUrl({}) === DEFAULT_NATS_URL);
    check("#35 blank/whitespace values do not shadow the next source",
      resolveNatsUrl({ KANNAKA_NATS_URL: "   ", NATS_URL: "nats://real:4222" }) === "nats://real:4222",
      "an empty env var is not a configured broker");
  }

  // ── #47: a fatal -ERR must drop the socket so a reconnect is scheduled ──
  //
  // Pre-fix, `-ERR` only logged. `_scheduleReconnect()` is reachable ONLY from
  // the socket 'close' handler, so a broker that rejected auth WITHOUT closing
  // the TCP connection stranded the bridge permanently: `_connected` never
  // went true, every later glyph was dropped, and nothing ever retried.
  {
    check("#47 authorization violation is classified fatal",
      isFatalNatsError("-ERR 'Authorization Violation'") === true);
    check("#47 permissions violation is classified NON-fatal",
      isFatalNatsError("-ERR 'Permissions Violation for Publish to KANNAKA.attention.eye'") === false,
      "tearing down on a per-subject permissions error would just reconnect-loop");

    // Fake broker that sends INFO then -ERR and then deliberately HOLDS the
    // socket open — the exact condition the bug needs.
    const held = [];
    const broker = net.createServer((sock) => {
      held.push(sock);
      sock.write("INFO {\"server_id\":\"fake\"}\r\n");
      sock.on("data", () => {});
      setTimeout(() => { try { sock.write("-ERR 'Authorization Violation'\r\n"); } catch { /* gone */ } }, 30);
      sock.on("error", () => {});
    });
    const bport = await new Promise((res) => broker.listen(0, "127.0.0.1", () => res(broker.address().port)));

    // Point this instance at the fake broker explicitly. attention-bridge.js
    // is CommonJS and reads NATS_URL once at module load, so setting the env
    // here and re-importing with a cache-busting query does NOT work: the CJS
    // require cache keys on the resolved path and ignores the query, handing
    // back the already-evaluated module still aimed at localhost:4222.
    const bridge = new AttentionBridge({ url: `nats://127.0.0.1:${bport}` });
    bridge.connect();

    await new Promise((r) => setTimeout(r, 400));

    const st = bridge.stats();
    check("#47 bridge is not left believing it is connected",
      st.connected === false, `stats=${JSON.stringify(st)}`);
    check("#47 a reconnect is actually scheduled after a fatal -ERR",
      st.reconnectPending === true,
      `nothing is retrying, so the link is permanently dead; stats=${JSON.stringify(st)}`);
    check("#47 the reason is reported, not just 'disconnected'",
      typeof st.lastError === "string" && st.lastError.includes("Authorization Violation"),
      `got lastError=${JSON.stringify(st.lastError)}`);
    check("#47 glyphs published while down are counted as dropped",
      bridge.publishGlyph({ foldSequence: [1], amplitudes: [1] }, "text") === false &&
      bridge.stats().dropped >= 1,
      `stats=${JSON.stringify(bridge.stats())}`);

    // Stop the 5s retry so the test process can exit promptly.
    if (bridge._reconnectTimer) clearTimeout(bridge._reconnectTimer);
    for (const s of held) { try { s.destroy(); } catch { /* ignore */ } }
    broker.close();
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

    // ── #48: the startup line must not claim a classifier it never checked ──
    //
    // This server was spawned with KANNAKA_BIN pointed at FAKE_BIN, which does
    // not exist — exactly the condition in the report. Pre-fix it printed
    // "[eye] Native classifier: <path>" unconditionally, so a typo'd env var
    // read as a working native setup in the logs.
    {
      check("#48 startup does not announce a native classifier that is absent",
        !/\[eye\] Native classifier: /.test(serverLog),
        `serverLog claimed a native classifier:\n${serverLog.slice(0, 300)}`);
      check("#48 startup warns that KANNAKA_BIN points at nothing",
        /KANNAKA_BIN is set to .* but no file exists there/.test(serverLog),
        `expected an explicit warning; got:\n${serverLog.slice(0, 300)}`);
      check("#48 the warning says why auto-detection did not rescue it",
        /Auto-detection is skipped/.test(serverLog),
        `the operator needs to know the explicit setting suppressed auto-detect`);
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

      // #37: a fallback-classified radio glyph must still carry the
      // resonance-ring layer. The test server has no usable native classifier,
      // so /api/radio necessarily takes the fallback branch — exactly the path
      // that used to return a glyph with no levelDistribution at all.
      {
        const r = await request(port, "/api/radio");
        if (r.status === 200) {
          const rb = JSON.parse(r.body);
          // Read defensively: when this regresses, levelDistribution is
          // ABSENT, and a test that throws on the missing field would abort
          // the whole suite instead of reporting a clean failure.
          const ld = rb.glyph && Array.isArray(rb.glyph.levelDistribution)
            ? rb.glyph.levelDistribution
            : null;
          check("#37 fallback radio glyph carries levelDistribution",
            ld !== null,
            `glyph keys=${JSON.stringify(rb.glyph && Object.keys(rb.glyph))}`);
          check("#37 levelDistribution has the 8 buckets the viewer renders",
            ld !== null && ld.length === 8,
            `len=${ld === null ? "absent" : ld.length}`);
          check("#37 levelDistribution is normalised to sum ~1",
            ld !== null && Math.abs(ld.reduce((s, v) => s + v, 0) - 1) < 1e-9,
            `sum=${ld === null ? "absent" : ld.reduce((s, v) => s + v, 0)}`);
          check("#37 the fallback branch is genuinely the one under test",
            rb.glyph && rb.glyph.classifier === "fallback",
            `classifier=${rb.glyph && rb.glyph.classifier}`);
        } else {
          check("#37 /api/radio reachable for levelDistribution check", false,
            `status=${r.status} body=${r.body.slice(0, 120)}`);
        }
      }

      // #38: one radio click must produce ONE attention publish. /api/radio
      // already classifies and publishes as "audio"; re-POSTing to
      // /api/process published the same listening event again as "bytes".
      check("#38 radio preset renders the glyph it was already given",
        html.includes("displayGlyph(radio.glyph)"),
        "radio preset should reuse the returned glyph, not re-classify");
      check("#38 radio preset does not unconditionally re-POST to /api/process",
        !/radio\.track \+ ' \(' \+ radio\.featureCount \+ ' features\)';\s*processInput\(/.test(html),
        "an unconditional processInput() after /api/radio double-publishes");
      check("#38 a null glyph still falls back to classifying locally",
        html.includes("processInput(radio.features, 'bytes')"),
        "the fallback must survive for when buildGlyphFromBytes returns null");

      // #43: class 0 is a real SGA class. `|| '—'` rendered it as "no data".
      // Asserted against served page source, same approach as #26 — there is
      // no browser harness in this repo.
      check("#43 dominantClass uses ?? so class 0 is not masked",
        html.includes("glyph.dominantClass ?? '—'"),
        "expected nullish coalescing for dominantClass");
      check("#43 dominantClass no longer uses || for its placeholder",
        !html.includes("glyph.dominantClass || '—'"),
        "|| masks a legitimate class 0 as an em dash");
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

    // ── #46: constellation surfaces must include the attention bridge ──
    //
    // The server under test has no NATS broker, so its bridge is down and
    // every glyph is being dropped. Pre-fix all three surfaces still looked
    // healthy, because none of them mentioned the bridge at all.
    {
      const res = await request(port, "/api/constellation");
      const body = JSON.parse(res.body);
      check("#46 /api/constellation includes attention state",
        body.attention !== undefined, `keys=${Object.keys(body).join(",")}`);
      check("#46 attention reports disconnected with no broker",
        body.attention && body.attention.connected === false,
        `attention=${JSON.stringify(body.attention)}`);
      check("#46 attention exposes the dropped counter",
        body.attention && typeof body.attention.dropped === "number",
        `attention=${JSON.stringify(body.attention)}`);
      check("#46 attention exposes retry state so a dead link is diagnosable",
        body.attention && "reconnectPending" in body.attention && "lastError" in body.attention,
        `attention=${JSON.stringify(body.attention)}`);

      // ── #41: memory gets its own object, not an inferred `classifier` ──
      check("#41 /api/constellation includes a memory object",
        body.memory !== undefined && typeof body.memory === "object",
        `keys=${Object.keys(body).join(",")}`);
      check("#41 memory reports unverified when a binary is set but unusable",
        body.memory && body.memory.status === "unverified" && body.memory.available === false,
        `memory=${JSON.stringify(body.memory)}`);
      check("#41 memory distinguishes 'configured' from 'usable'",
        body.memory && body.memory.binaryConfigured === true,
        `the test server sets KANNAKA_BIN to an unusable path; memory=${JSON.stringify(body.memory)}`);
      check("#41 classifier is retained for backwards compatibility",
        body.classifier === "fallback", `got classifier=${JSON.stringify(body.classifier)}`);

      const svg = await request(port, "/api/constellation.svg");
      check("#46 SVG status line reports attention",
        /attention:(ON|OFF)/.test(svg.body), `status line missing attention`);
      check("#46 SVG reports attention OFF when the bridge is down",
        /attention:OFF/.test(svg.body), `expected attention:OFF`);
      check("#46 SVG does not light an Attention node while disconnected",
        !svg.body.includes(">Attention<"),
        "a dark bridge must not render as an active constellation node");
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
