#!/usr/bin/env node
/**
 * 👁 Kannaka Eye — Glyph Viewer and Renderer
 * 
 * A beautiful, full-screen web app that takes any input (text, files, audio, raw data) 
 * and renders its emergent SGA glyph in real-time. The glyph should be stunning — 
 * something you'd hang on a wall. This is the visual foundation for the entire glyph ecosystem.
 * 
 * Usage:
 *   node server.js [--port 3333]
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { execFile } = require("child_process");

// ── Config ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3333 : 3333;

// Kannaka binary path — auto-detect or use env var
const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  (() => {
    const candidates = [
      path.join(__dirname, "..", "kannaka-memory", "target", "release", process.platform === "win32" ? "kannaka.exe" : "kannaka"),
      path.join(__dirname, "..", "kannaka-memory", "target", "debug", process.platform === "win32" ? "kannaka.exe" : "kannaka"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  })();

if (KANNAKA_BIN) {
  console.log(`[eye] Native classifier: ${KANNAKA_BIN}`);
} else {
  console.log(`[eye] Native classifier not found — using JS fallback`);
}

// Flux configuration (disabled by default — privacy first)
const FLUX_URL = process.env.FLUX_URL || null;
const FLUX_AGENT_ID = process.env.FLUX_AGENT_ID || "kannaka-eye";
let lastFluxPublish = 0;

/**
 * Attempt native classification via the kannaka binary.
 * Returns a Promise that resolves to the parsed JSON or null on failure.
 */
function classifyNative(inputBuffer) {
  if (!KANNAKA_BIN) return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = execFile(KANNAKA_BIN, ["classify"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
    child.stdin.write(inputBuffer);
    child.stdin.end();
  });
}

/**
 * Publish a GlyphPublished event to Flux (ADR-0015 schema).
 * Fire-and-forget with throttle (max 1/sec).
 */
function publishGlyphToFlux(glyphResponse) {
  if (!FLUX_URL) return;
  const now = Date.now();
  if (now - lastFluxPublish < 1000) return;
  lastFluxPublish = now;

  const payload = JSON.stringify({
    entity_id: "pure-jade/eye-glyph",
    properties: {
      glyph_id: glyphResponse.dominantClass.toString(16).padStart(2, "0"),
      fano_preview: glyphResponse.fanoSignature,
      source_type: glyphResponse.sourceType || "text",
      agent_id: FLUX_AGENT_ID,
      dominant_class: glyphResponse.dominantClass,
      classes_used: glyphResponse.classesUsed,
      centroid: glyphResponse.centroid,
      processed_at: glyphResponse.processedAt,
    }
  });

  const fluxUrl = new URL(FLUX_URL.replace(/\/$/, "") + "/api/events");
  const options = {
    hostname: fluxUrl.hostname,
    port: fluxUrl.port || (fluxUrl.protocol === "https:" ? 443 : 80),
    path: fluxUrl.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  const transport = fluxUrl.protocol === "https:" ? require("https") : http;
  const req = transport.request(options, () => {});
  req.on("error", () => {}); // fire-and-forget
  req.write(payload);
  req.end();
}

// ── SGA (Sigmatics Geometric Algebra) System ──────────────

// Golden ratio for frequency harmonics
const PHI = 1.618033988749895;

// Base frequency for musical mapping (432 Hz)
const BASE_FREQ = 432.0;

// Fano plane lines (oriented triples)
const FANO_LINES = [
  [1, 2, 4], [2, 3, 5], [3, 4, 6], [4, 5, 7],
  [5, 6, 1], [6, 7, 2], [7, 1, 3]
];

// Fano line colors (golden ratio spacing across spectrum)
const FANO_COLORS = [
  '#9333ea', // violet
  '#3b82f6', // blue  
  '#06b6d4', // cyan
  '#10b981', // green
  '#f59e0b', // yellow
  '#f97316', // orange
  '#ef4444'  // red
];

/**
 * Classify arbitrary data into SGA 84-class system
 * Returns class_index (0..95) with components (h2, d, l)
 */
function classifyData(bytes) {
  if (!bytes || bytes.length === 0) return 0;
  
  // ── h2 (0..3): frequency band dominance from byte distribution ──
  const bands = [
    { range: [0, 63], sum: 0 },     // sub-bass: 0-63
    { range: [64, 127], sum: 0 },   // bass: 64-127
    { range: [128, 191], sum: 0 },  // mid: 128-191
    { range: [192, 255], sum: 0 }   // treble: 192-255
  ];
  
  for (const byte of bytes) {
    for (let i = 0; i < bands.length; i++) {
      if (byte >= bands[i].range[0] && byte <= bands[i].range[1]) {
        bands[i].sum += 1;
        break;
      }
    }
  }
  
  // Find dominant band
  let h2 = 0;
  let maxSum = bands[0].sum;
  for (let i = 1; i < 4; i++) {
    if (bands[i].sum > maxSum) {
      maxSum = bands[i].sum;
      h2 = i;
    }
  }
  
  // ── d (0..2): modality from entropy and variance ──
  const mean = bytes.reduce((sum, b) => sum + b, 0) / bytes.length;
  const variance = bytes.reduce((sum, b) => sum + Math.pow(b - mean, 2), 0) / bytes.length;
  const entropy = calculateEntropy(bytes);
  
  let d;
  if (entropy < 3.0 && variance < 2000) d = 0;      // sustained/structured
  else if (entropy < 6.0 && variance < 8000) d = 1; // transient/mixed
  else d = 2;                                        // chaotic/random
  
  // ── l (0..7): context from hash and shape ──
  const contentHash = bytes.reduce((hash, b) => ((hash << 5) - hash + b) & 0xffffffff, 0);
  const l = Math.abs(contentHash) % 7;
  
  // Compute class index: class_index = 21*h2 + 7*d + l
  const classIndex = 21 * h2 + 7 * d + l;
  return Math.min(83, classIndex);
}

/**
 * Classify text into SGA classes (each character/word → class)
 */
function classifyText(text) {
  if (!text) return [];
  
  const results = [];
  const chars = Array.from(text); // Handle Unicode properly
  
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const bytes = Array.from(Buffer.from(char, 'utf8'));
    
    // Add positional context to classification
    const positionInfluence = i % 8;
    const modifiedBytes = bytes.map(b => (b + positionInfluence) % 256);
    
    const classIndex = classifyData(modifiedBytes);
    results.push({
      char,
      position: i,
      classIndex,
      components: decodeClassIndex(classIndex)
    });
  }
  
  return results;
}

/**
 * Classify numeric arrays into SGA classes
 */
function classifyNumbers(numbers) {
  if (!numbers || numbers.length === 0) return [];
  
  const results = [];
  
  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    
    // Convert number to byte representation
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(num, 0);
    const bytes = Array.from(buffer);
    
    // Add index influence for different numbers at different positions
    const indexInfluence = i % 16;
    const modifiedBytes = bytes.map((b, j) => (b + indexInfluence * (j + 1)) % 256);
    
    const classIndex = classifyData(modifiedBytes);
    results.push({
      value: num,
      position: i,
      classIndex,
      components: decodeClassIndex(classIndex)
    });
  }
  
  return results;
}

/**
 * Calculate Shannon entropy of byte array
 */
function calculateEntropy(bytes) {
  const freq = new Array(256).fill(0);
  for (const byte of bytes) freq[byte]++;
  
  let entropy = 0;
  const total = bytes.length;
  
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / total;
      entropy -= p * Math.log2(p);
    }
  }
  
  return entropy;
}

/**
 * Decode class index to components (h2, d, l)
 */
function decodeClassIndex(classIndex) {
  if (classIndex > 83) classIndex = 95;
  
  const h2 = Math.floor(classIndex / 21);
  const remainder = classIndex % 21;
  const d = Math.floor(remainder / 7);
  const l = remainder % 7;
  
  return { h2, d, l };
}

/**
 * Create fold sequence from classified data
 */
function createFoldSequence(classifiedData) {
  const sequence = [];
  const amplitudes = [];
  const phases = [];
  
  for (let i = 0; i < classifiedData.length; i++) {
    const item = classifiedData[i];
    sequence.push(item.classIndex);
    
    // Calculate amplitude based on position and value characteristics
    let amplitude = 0.5;
    if (item.value !== undefined) {
      amplitude = Math.min(1.0, Math.abs(item.value) + 0.2);
    } else if (item.char !== undefined) {
      amplitude = (item.char.charCodeAt(0) % 256) / 255.0;
    }
    amplitudes.push(amplitude);
    
    // Calculate phase based on position and content
    const phase = (i * Math.PI / 4) + (item.classIndex * Math.PI / 48);
    phases.push(phase % (2 * Math.PI));
  }
  
  return { sequence, amplitudes, phases };
}

/**
 * Compute Fano signature from fold sequence
 */
function computeFanoSignature(foldSequence) {
  const signature = new Array(7).fill(0);
  const amplitudes = foldSequence.amplitudes || new Array(foldSequence.sequence.length).fill(1);
  
  for (let i = 0; i < foldSequence.sequence.length; i++) {
    const classIndex = foldSequence.sequence[i];
    const { l } = decodeClassIndex(classIndex);
    const amplitude = amplitudes[i] || 1;
    
    if (l >= 1 && l <= 7) {
      // Find which Fano lines contain this l value
      for (let lineIdx = 0; lineIdx < FANO_LINES.length; lineIdx++) {
        const [a, b, c] = FANO_LINES[lineIdx];
        if (l === a || l === b || l === c) {
          signature[lineIdx] += amplitude;
        }
      }
    }
  }
  
  // Normalize signature
  const total = signature.reduce((sum, val) => sum + val, 0);
  if (total > 0) {
    for (let i = 0; i < signature.length; i++) {
      signature[i] /= total;
    }
  }
  
  return signature;
}

/**
 * Convert fold sequence to musical frequencies
 */
function sequenceToFrequencies(foldSequence) {
  const frequencies = [];
  
  for (let i = 0; i < foldSequence.sequence.length; i++) {
    const classIndex = foldSequence.sequence[i];
    const { h2, d, l } = decodeClassIndex(classIndex);
    const amplitude = (foldSequence.amplitudes && foldSequence.amplitudes[i]) || 1;
    
    // Map (h₂, d, ℓ) to frequency using golden ratio
    const h2_mult = Math.pow(PHI, h2);
    const d_mult = Math.pow(PHI, d - 1); // center around φ⁰ = 1
    const l_mult = Math.pow(PHI, l - 3); // center around φ⁰ = 1
    
    const freq = BASE_FREQ * h2_mult * d_mult * l_mult * amplitude;
    frequencies.push(Math.max(20, Math.min(20000, freq))); // Audio range
  }
  
  return frequencies;
}

/**
 * Generate sample data presets for demonstration
 */
function generatePresets() {
  return {
    "Hello World": {
      type: "text",
      data: "Hello World",
      description: "Classic greeting — watch how familiar text creates unique geometric patterns"
    },
    "Lorem Ipsum": {
      type: "text", 
      data: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
      description: "Random Latin text — shows how linguistic structure translates to geometric form"
    },
    "Binary Sequence": {
      type: "numbers",
      data: [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1],
      description: "Pure binary — minimal information creates crystalline geometric structures"
    },
    "Golden Ratio": {
      type: "numbers",
      data: [1.618, 0.618, 2.618, 4.236, 1.272, 0.786, 3.090],
      description: "φ-based sequence — mathematical constants reveal their inherent geometric nature"
    },
    "Fibonacci": {
      type: "numbers",
      data: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144],
      description: "Growth sequence — natural spirals emerge in the fold patterns"
    },
    "Random Noise": {
      type: "numbers",
      data: Array.from({length: 32}, () => Math.random() * 2 - 1),
      description: "Pure randomness — chaos creates its own strange attractors"
    }
  };
}

// ── HTTP Server ────────────────────────────────────────────

function getMainHtml() {
  const presets = generatePresets();
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>👁 Kannaka Eye — Glyph Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    background: radial-gradient(circle at 20% 30%, #0a0a1f 0%, #050508 50%, #000000 100%);
    color: #e0e0e0;
    font-family: 'Courier New', Monaco, 'Lucida Console', monospace;
    min-height: 100vh;
    overflow-x: hidden;
    animation: cosmicShift 60s ease-in-out infinite;
  }
  
  @keyframes cosmicShift {
    0%, 100% { background-position: 0% 0%; }
    50% { background-position: 100% 100%; }
  }
  
  /* Header */
  .header {
    text-align: center;
    padding: 20px;
    background: linear-gradient(135deg, rgba(16, 16, 32, 0.8), rgba(8, 8, 16, 0.9));
    backdrop-filter: blur(10px);
    border-bottom: 1px solid #2a2a4a;
  }
  
  .eye-icon { 
    font-size: 48px; margin-bottom: 8px; 
    animation: blink 4s ease-in-out infinite;
    filter: drop-shadow(0 0 20px #c084fc60);
  }
  
  @keyframes blink {
    0%, 90%, 100% { opacity: 1; }
    95% { opacity: 0.3; }
  }
  
  .title { 
    font-size: 24px; color: #c084fc; letter-spacing: 3px; margin-bottom: 4px;
    text-shadow: 0 0 30px #c084fc40;
  }
  
  .subtitle { 
    color: #666; font-size: 11px; letter-spacing: 2px;
    text-transform: uppercase;
  }
  
  /* Main Layout */
  .main-container {
    display: grid;
    grid-template-columns: 1fr 400px;
    height: calc(100vh - 120px);
    gap: 20px;
    padding: 20px;
  }
  
  @media (max-width: 1024px) {
    .main-container {
      grid-template-columns: 1fr;
      grid-template-rows: 60vh auto;
    }
  }
  
  /* Canvas Container */
  .canvas-container {
    position: relative;
    background: linear-gradient(45deg, #0a0a1a 0%, #12121f 50%, #0a0a1a 100%);
    border: 2px solid #1a1a3a;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 
      0 0 40px rgba(192, 132, 252, 0.1),
      inset 0 0 40px rgba(0, 0, 0, 0.5);
  }
  
  .glyph-canvas {
    width: 100%;
    height: 100%;
    display: block;
    cursor: crosshair;
  }
  
  .canvas-overlay {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(8, 8, 16, 0.9);
    border: 1px solid #333;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 10px;
    color: #888;
    backdrop-filter: blur(10px);
  }
  
  /* Input Panel */
  .input-panel {
    background: linear-gradient(135deg, #12121a 0%, #16161e 100%);
    border: 1px solid #2a2a4a;
    border-radius: 16px;
    padding: 20px;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
  
  .panel-section {
    margin-bottom: 24px;
  }
  
  .section-title {
    color: #c084fc;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin-bottom: 12px;
    border-bottom: 1px solid #333;
    padding-bottom: 4px;
  }
  
  /* Text Input */
  .text-input {
    width: 100%;
    min-height: 100px;
    background: rgba(8, 8, 16, 0.8);
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
    color: #e0e0e0;
    font-family: inherit;
    font-size: 12px;
    resize: vertical;
    transition: all 0.3s;
  }
  
  .text-input:focus {
    outline: none;
    border-color: #c084fc;
    box-shadow: 0 0 16px rgba(192, 132, 252, 0.3);
  }
  
  .text-input::placeholder {
    color: #666;
    font-style: italic;
  }
  
  /* File Upload */
  .file-upload {
    border: 2px dashed #333;
    border-radius: 8px;
    padding: 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s;
    background: rgba(8, 8, 16, 0.5);
  }
  
  .file-upload:hover {
    border-color: #c084fc;
    background: rgba(192, 132, 252, 0.05);
  }
  
  .file-upload.dragover {
    border-color: #c084fc;
    background: rgba(192, 132, 252, 0.1);
    transform: scale(1.02);
  }
  
  .file-upload input {
    display: none;
  }
  
  .upload-text {
    color: #888;
    font-size: 12px;
  }
  
  .upload-icon {
    font-size: 24px;
    margin-bottom: 8px;
    color: #666;
  }
  
  /* Presets */
  .presets {
    display: grid;
    gap: 8px;
  }
  
  .preset-btn {
    background: linear-gradient(135deg, #1a1a2e, #252545);
    border: 1px solid #333;
    color: #c084fc;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    transition: all 0.3s;
  }
  
  .preset-btn:hover {
    border-color: #c084fc;
    background: linear-gradient(135deg, #2a2a4e, #353565);
    box-shadow: 0 0 16px rgba(192, 132, 252, 0.2);
    transform: translateX(4px);
  }
  
  .preset-name {
    font-weight: bold;
    margin-bottom: 2px;
  }
  
  .preset-desc {
    font-size: 9px;
    color: #666;
    line-height: 1.3;
  }
  
  /* Controls */
  .controls {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  
  .btn {
    background: linear-gradient(135deg, #1a1a2e, #252545);
    border: 1px solid #444;
    color: #c084fc;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    transition: all 0.3s;
    flex: 1;
    min-width: 80px;
  }
  
  .btn:hover {
    border-color: #c084fc;
    background: linear-gradient(135deg, #2a2a4e, #353565);
    box-shadow: 0 0 16px rgba(192, 132, 252, 0.3);
  }
  
  .btn:active {
    transform: scale(0.98);
  }
  
  /* Stats */
  .stats {
    font-size: 10px;
    color: #888;
    line-height: 1.4;
  }
  
  .stat-item {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    padding: 4px 0;
    border-bottom: 1px solid #222;
  }
  
  .stat-label {
    color: #666;
  }
  
  .stat-value {
    color: #c084fc;
    font-weight: bold;
  }
  
  /* Metadata Toggle */
  .metadata-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    color: #e0e0e0;
    padding: 20px;
    font-size: 12px;
    overflow-y: auto;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s;
    backdrop-filter: blur(5px);
  }
  
  .metadata-overlay.visible {
    opacity: 1;
    pointer-events: all;
  }
  
  .metadata-section {
    margin-bottom: 16px;
    background: rgba(16, 16, 32, 0.8);
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
  }
  
  .metadata-title {
    color: #c084fc;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  
  /* Footer */
  .footer {
    text-align: center;
    padding: 16px;
    color: #333;
    font-size: 10px;
    border-top: 1px solid #1a1a1a;
  }
  
  .footer a {
    color: #444;
    text-decoration: none;
  }
  
  .footer a:hover {
    color: #666;
  }
  
  /* Loading Animation */
  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    color: #666;
    z-index: 10;
  }
  
  .loading-spinner {
    border: 2px solid #333;
    border-top: 2px solid #c084fc;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    animation: spin 1s linear infinite;
    margin: 0 auto 8px;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  /* Responsive */
  @media (max-width: 768px) {
    .main-container {
      padding: 10px;
      gap: 10px;
    }
    
    .header {
      padding: 15px;
    }
    
    .title {
      font-size: 18px;
    }
    
    .eye-icon {
      font-size: 36px;
    }
    
    .input-panel {
      padding: 15px;
    }
  }
</style>
</head>
<body>

<div class="header">
  <div class="eye-icon">👁</div>
  <h1 class="title">KANNAKA EYE</h1>
  <p class="subtitle">See the geometry of information</p>
</div>

<div class="main-container">
  <div class="canvas-container">
    <canvas id="glyphCanvas" class="glyph-canvas" width="800" height="800"></canvas>
    <div class="canvas-overlay">
      <span id="canvasInfo">Ready</span>
    </div>
    <div id="loadingIndicator" class="loading" style="display: none;">
      <div class="loading-spinner"></div>
      <div>Processing...</div>
    </div>
    <div id="metadataOverlay" class="metadata-overlay">
      <div class="metadata-section">
        <div class="metadata-title">Fano Signature</div>
        <div id="fanoSignatureDisplay"></div>
      </div>
      <div class="metadata-section">
        <div class="metadata-title">SGA Centroid</div>
        <div id="sgaCentroidDisplay"></div>
      </div>
      <div class="metadata-section">
        <div class="metadata-title">Fold Statistics</div>
        <div id="foldStatsDisplay"></div>
      </div>
      <div class="metadata-section">
        <div class="metadata-title">Musical Frequencies</div>
        <div id="frequenciesDisplay"></div>
      </div>
    </div>
  </div>
  
  <div class="input-panel">
    <!-- Text Input -->
    <div class="panel-section">
      <div class="section-title">✏️ Text Input</div>
      <textarea 
        id="textInput" 
        class="text-input" 
        placeholder="Type or paste any text... Watch the glyph evolve in real-time as you type."
      ></textarea>
    </div>
    
    <!-- File Upload -->
    <div class="panel-section">
      <div class="section-title">📁 File Upload</div>
      <div class="file-upload" id="fileUpload">
        <div class="upload-icon">📄</div>
        <div class="upload-text">
          Drop a file here or click to browse<br>
          <small>Any file type • Reads as raw bytes</small>
        </div>
        <input type="file" id="fileInput" accept="*/*">
      </div>
    </div>
    
    <!-- Presets -->
    <div class="panel-section">
      <div class="section-title">🎯 Presets</div>
      <div class="presets" id="presetContainer">
        <!-- Generated from server data -->
      </div>
    </div>
    
    <!-- Controls -->
    <div class="panel-section">
      <div class="section-title">⚙️ Controls</div>
      <div class="controls">
        <button class="btn" onclick="clearGlyph()">Clear</button>
        <button class="btn" onclick="exportPNG()">Save PNG</button>
        <button class="btn" onclick="exportData()">Export Data</button>
        <button class="btn" onclick="copyShareLink()">Share Link</button>
        <button class="btn" onclick="toggleMetadata()">Metadata</button>
      </div>
    </div>
    
    <!-- Stats -->
    <div class="panel-section">
      <div class="section-title">📊 Statistics</div>
      <div class="stats" id="statsDisplay">
        <div class="stat-item">
          <span class="stat-label">Fold Count:</span>
          <span class="stat-value" id="foldCount">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Classes Used:</span>
          <span class="stat-value" id="classesUsed">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Compression:</span>
          <span class="stat-value" id="compressionRatio">—</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Dominant Class:</span>
          <span class="stat-value" id="dominantClass">—</span>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="footer">
  <a href="https://github.com/NickFlach/kannaka-eye">github.com/NickFlach/kannaka-eye</a>
  •
  <a href="https://github.com/NickFlach/kannaka-memory">Sigmatics Geometric Algebra</a>
</div>

<script>
// ── Global State ──
let currentGlyph = null;
let animationFrame = null;
let glyphTime = 0;
let metadataVisible = false;

// ── Canvas Setup ──
const canvas = document.getElementById('glyphCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const size = Math.min(rect.width - 40, rect.height - 40, 800);
  
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  
  if (currentGlyph) {
    renderGlyph(currentGlyph);
  }
}

// ── SGA Functions (Client-side) ──
const FANO_LINES_CLIENT = ${JSON.stringify(FANO_LINES)};
const FANO_COLORS_CLIENT = ${JSON.stringify(FANO_COLORS)};

function decodeClassIndexClient(classIndex) {
  if (classIndex > 83) classIndex = 95;
  
  const h2 = Math.floor(classIndex / 21);
  const remainder = classIndex % 21;
  const d = Math.floor(remainder / 7);
  const l = remainder % 7;
  
  return { h2, d, l };
}

function classToPosition(classIndex, radius = 200) {
  const { h2, d, l } = decodeClassIndexClient(classIndex);
  
  // Use (h2,d) for radial angle, l for radius modulation
  const angle = (h2 * 90 + d * 30) * Math.PI / 180;
  const r = radius * (0.3 + (l / 7) * 0.7);
  
  return {
    x: Math.cos(angle) * r,
    y: Math.sin(angle) * r,
    fanoLine: l % 7
  };
}

function getFanoLineIndex(l) {
  if (l === 0) return -1;
  for (let i = 0; i < FANO_LINES_CLIENT.length; i++) {
    if (FANO_LINES_CLIENT[i].includes(l)) return i;
  }
  return 0;
}

// ── Glyph Renderer ──
function renderGlyph(glyph) {
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.min(W, H) / 2 - 40;
  
  glyphTime += 0.016;
  
  // Clear with ghost trails
  ctx.fillStyle = 'rgba(5, 5, 8, 0.08)';
  ctx.fillRect(0, 0, W, H);
  
  // ── Layer 1: Fano Constellation (background) ──
  renderFanoConstellation(cx, cy, maxR * 0.85, glyph.fanoSignature);
  
  // ── Layer 2: Fold Path (primary visual) ──
  renderFoldPath(cx, cy, maxR * 0.6, glyph);
  
  // ── Layer 3: Fano Energy Bloom ──
  renderFanoEnergyBloom(cx, cy, maxR * 0.4, glyph.fanoSignature);
  
  // ── Layer 4: Geometric Core ──
  renderGeometricCore(cx, cy, glyph);
  
  // ── Layer 5: Resonance Rings ──
  renderResonanceRings(cx, cy, maxR, glyph);
  
  // Update UI
  updateCanvasInfo(glyph);
  updateStats(glyph);
  updateMetadata(glyph);
}

function renderFanoConstellation(cx, cy, radius, signature) {
  // 7 Fano nodes in a circle
  const nodes = [];
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 - Math.PI / 2;
    nodes.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      energy: signature[i] || 0
    });
  }
  
  // Draw Fano lines
  for (let lineIdx = 0; lineIdx < FANO_LINES_CLIENT.length; lineIdx++) {
    const line = FANO_LINES_CLIENT[lineIdx];
    const energy = signature[lineIdx] || 0;
    const alpha = 0.05 + energy * 0.3;
    const width = 0.5 + energy * 2;
    
    ctx.strokeStyle = FANO_COLORS_CLIENT[lineIdx];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    
    for (let i = 0; i < line.length; i++) {
      const nodeIdx = line[i] - 1;
      const node = nodes[nodeIdx];
      if (i === 0) ctx.moveTo(node.x, node.y);
      else ctx.lineTo(node.x, node.y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  
  // Draw Fano nodes
  for (let i = 0; i < 7; i++) {
    const node = nodes[i];
    const nodeR = 2 + node.energy * 8;
    const pulse = Math.sin(glyphTime * 2 + i) * 0.2 + 0.8;
    
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeR * pulse, 0, Math.PI * 2);
    ctx.fillStyle = FANO_COLORS_CLIENT[i];
    ctx.globalAlpha = 0.6 + node.energy * 0.4;
    ctx.fill();
    
    // Glow
    ctx.shadowColor = FANO_COLORS_CLIENT[i];
    ctx.shadowBlur = nodeR * 2;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  
  ctx.globalAlpha = 1;
}

function renderFoldPath(cx, cy, maxRadius, glyph) {
  if (!glyph.foldSequence || glyph.foldSequence.length < 2) return;
  
  const points = glyph.foldSequence.map((classIdx, i) => {
    const pos = classToPosition(classIdx, maxRadius);
    const amplitude = (glyph.amplitudes && glyph.amplitudes[i]) || 1;
    const phase = (glyph.phases && glyph.phases[i]) || 0;
    
    // Add breathing and phase motion
    const breathe = Math.sin(glyphTime * 1.5 + phase) * 0.15 + 1;
    
    return {
      x: cx + pos.x * breathe * amplitude,
      y: cy + pos.y * breathe * amplitude,
      fanoLine: getFanoLineIndex(decodeClassIndexClient(classIdx).l),
      age: i / glyph.foldSequence.length,
      amplitude: amplitude
    };
  });
  
  // Draw the fold path
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1];
    const p2 = points[i];
    const age = p2.age;
    const alpha = age * 0.8 + 0.2;
    const width = 1 + p2.amplitude * 2;
    
    const colorIdx = p2.fanoLine >= 0 ? p2.fanoLine : 0;
    ctx.strokeStyle = FANO_COLORS_CLIENT[colorIdx];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    
    // Smooth curve between points
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    
    if (i < points.length - 1) {
      const p3 = points[i + 1];
      const cp1x = p1.x + (p2.x - p1.x) * 0.5;
      const cp1y = p1.y + (p2.y - p1.y) * 0.5;
      ctx.quadraticCurveTo(cp1x, cp1y, p2.x, p2.y);
    } else {
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
    
    // Interference patterns at intersections
    if (i > 2 && Math.random() < 0.1) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  
  ctx.globalAlpha = 1;
}

function renderFanoEnergyBloom(cx, cy, maxRadius, signature) {
  const breathe = Math.sin(glyphTime * 0.8) * 0.1 + 0.9;
  
  for (let i = 0; i < 7; i++) {
    const energy = signature[i] || 0;
    const angle = (i / 7) * Math.PI * 2 - Math.PI / 2;
    const petalLength = energy * maxRadius * breathe;
    
    if (petalLength > 5) {
      // Create petal gradient
      const gradient = ctx.createRadialGradient(
        cx, cy, 0,
        cx + Math.cos(angle) * petalLength * 0.7,
        cy + Math.sin(angle) * petalLength * 0.7,
        petalLength
      );
      gradient.addColorStop(0, FANO_COLORS_CLIENT[i] + '60');
      gradient.addColorStop(0.5, FANO_COLORS_CLIENT[i] + '30');
      gradient.addColorStop(1, FANO_COLORS_CLIENT[i] + '00');
      
      ctx.fillStyle = gradient;
      ctx.globalCompositeOperation = 'screen';
      
      // Draw petal
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(angle) * petalLength * 0.5,
        cy + Math.sin(angle) * petalLength * 0.5,
        petalLength * 0.3,
        petalLength * 0.7,
        angle,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }
  
  ctx.globalCompositeOperation = 'source-over';
}

function renderGeometricCore(cx, cy, glyph) {
  if (!glyph.centroid) return;
  
  const { h2, d, l } = glyph.centroid;
  const numSides = 3 + h2; // 3-6 sided polygon
  const coreSize = 15 + (glyph.totalEnergy || 0.5) * 20;
  const rotation = (l / 8) * Math.PI * 2 + glyphTime * 0.3;
  const pulse = Math.sin(glyphTime * 3) * 0.1 + 0.9;
  
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  
  // Draw polygon
  ctx.beginPath();
  for (let i = 0; i <= numSides; i++) {
    const angle = (i / numSides) * Math.PI * 2;
    const x = Math.cos(angle) * coreSize * pulse;
    const y = Math.sin(angle) * coreSize * pulse;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  
  // Fill/stroke pattern based on d
  const coreColor = FANO_COLORS_CLIENT[l % 7];
  
  if (d === 0) {
    // Solid fill
    ctx.fillStyle = coreColor;
    ctx.globalAlpha = 0.7;
    ctx.fill();
  } else if (d === 1) {
    // Ring pattern
    ctx.strokeStyle = coreColor;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
  } else {
    // Dot pattern
    ctx.fillStyle = coreColor;
    ctx.globalAlpha = 0.6;
    for (let i = 0; i < numSides; i++) {
      const angle = (i / numSides) * Math.PI * 2;
      const x = Math.cos(angle) * coreSize * 0.7;
      const y = Math.sin(angle) * coreSize * 0.7;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  // Core glow
  ctx.shadowColor = coreColor;
  ctx.shadowBlur = 15;
  ctx.globalAlpha = 0.4;
  ctx.stroke();
  ctx.shadowBlur = 0;
  
  ctx.globalAlpha = 1;
  ctx.restore();
}

function renderResonanceRings(cx, cy, maxR, glyph) {
  if (!glyph.levelDistribution) return;
  
  for (let level = 0; level < 8; level++) {
    const energy = glyph.levelDistribution[level] || 0;
    const radius = (level + 1) * maxR / 8;
    const alpha = energy * 0.3;
    
    if (alpha > 0.01) {
      ctx.strokeStyle = '#c084fc';
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1;
      
      const ripple = Math.sin(glyphTime * 2 - level * 0.5) * 2;
      
      ctx.beginPath();
      ctx.arc(cx, cy, radius + ripple, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  
  ctx.globalAlpha = 1;
}

// ── Data Processing ──
async function processInput(data, type) {
  showLoading(true);
  
  try {
    const response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, type })
    });
    
    const glyph = await response.json();
    
    if (glyph.error) {
      throw new Error(glyph.error);
    }
    
    currentGlyph = glyph;
    startAnimation();
    
  } catch (error) {
    console.error('Error processing input:', error);
    document.getElementById('canvasInfo').textContent = 'Error: ' + error.message;
  } finally {
    showLoading(false);
  }
}

function showLoading(show) {
  const loader = document.getElementById('loadingIndicator');
  loader.style.display = show ? 'block' : 'none';
}

function startAnimation() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
  }
  
  function animate() {
    if (currentGlyph) {
      renderGlyph(currentGlyph);
    }
    animationFrame = requestAnimationFrame(animate);
  }
  
  animate();
}

// ── UI Functions ──
function updateCanvasInfo(glyph) {
  const info = \`Fold: \${glyph.foldSequence?.length || 0} • Classes: \${glyph.classesUsed || 0} • Energy: \${((glyph.totalEnergy || 0) * 100).toFixed(1)}%\`;
  document.getElementById('canvasInfo').textContent = info;
}

function updateStats(glyph) {
  document.getElementById('foldCount').textContent = glyph.foldSequence?.length || 0;
  document.getElementById('classesUsed').textContent = glyph.classesUsed || 0;
  document.getElementById('compressionRatio').textContent = glyph.compressionRatio ? glyph.compressionRatio.toFixed(1) + ':1' : '—';
  document.getElementById('dominantClass').textContent = glyph.dominantClass || '—';
}

function updateMetadata(glyph) {
  // Fano Signature
  const fanoSig = document.getElementById('fanoSignatureDisplay');
  if (glyph.fanoSignature) {
    fanoSig.innerHTML = glyph.fanoSignature.map((val, i) => 
      \`<div style="color: \${FANO_COLORS_CLIENT[i]}">Line \${i+1}: \${val.toFixed(3)}</div>\`
    ).join('');
  }
  
  // SGA Centroid
  const centroid = document.getElementById('sgaCentroidDisplay');
  if (glyph.centroid) {
    centroid.innerHTML = \`
      <div>h₂: \${glyph.centroid.h2} (frequency band)</div>
      <div>d: \${glyph.centroid.d} (modality)</div>
      <div>ℓ: \${glyph.centroid.l} (context)</div>
    \`;
  }
  
  // Fold Stats
  const foldStats = document.getElementById('foldStatsDisplay');
  foldStats.innerHTML = \`
    <div>Total Folds: \${glyph.foldSequence?.length || 0}</div>
    <div>Unique Classes: \${glyph.classesUsed || 0}</div>
    <div>Compression: \${glyph.compressionRatio?.toFixed(1) || 0}:1</div>
    <div>Total Energy: \${((glyph.totalEnergy || 0) * 100).toFixed(1)}%</div>
  \`;
  
  // Frequencies
  const freqDisplay = document.getElementById('frequenciesDisplay');
  if (glyph.frequencies) {
    freqDisplay.innerHTML = glyph.frequencies.slice(0, 7).map((freq, i) => 
      \`<div style="color: \${FANO_COLORS_CLIENT[i]}">\${freq.toFixed(1)} Hz</div>\`
    ).join('');
  }
}

function clearGlyph() {
  currentGlyph = null;
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  
  // Clear canvas
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Reset UI
  document.getElementById('canvasInfo').textContent = 'Ready';
  document.getElementById('textInput').value = '';
  
  // Clear stats
  ['foldCount', 'classesUsed', 'compressionRatio', 'dominantClass'].forEach(id => {
    document.getElementById(id).textContent = id === 'foldCount' || id === 'classesUsed' ? '0' : '—';
  });
}

function exportPNG() {
  if (!currentGlyph) {
    alert('No glyph to export');
    return;
  }
  
  // Create high-res canvas
  const exportCanvas = document.createElement('canvas');
  const exportCtx = exportCanvas.getContext('2d');
  exportCanvas.width = 1600; // 2x resolution
  exportCanvas.height = 1600;
  
  // Temporarily switch context
  const originalCanvas = canvas;
  const originalCtx = ctx;
  canvas = exportCanvas;
  ctx = exportCtx;
  
  // Render high-res glyph
  renderGlyph(currentGlyph);
  
  // Download
  const link = document.createElement('a');
  link.download = \`kannaka-glyph-\${Date.now()}.png\`;
  link.href = exportCanvas.toDataURL();
  link.click();
  
  // Restore context
  canvas = originalCanvas;
  ctx = originalCtx;
}

function exportData() {
  if (!currentGlyph) {
    alert('No glyph to export');
    return;
  }
  
  const dataStr = JSON.stringify(currentGlyph, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = \`kannaka-glyph-data-\${Date.now()}.json\`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

function copyShareLink() {
  if (!currentGlyph) { alert('No glyph to share'); return; }
  // Compact glyph for URL encoding — just the essential rendering data
  const compact = {
    fs: currentGlyph.foldSequence.slice(0, 128),
    fn: currentGlyph.fanoSignature,
    c: currentGlyph.centroid,
    dc: currentGlyph.dominantClass,
    cl: currentGlyph.classifier || 'unknown',
  };
  const encoded = btoa(JSON.stringify(compact));
  if (encoded.length > 4000) {
    alert('Glyph too large for share link — use Export Data instead');
    return;
  }
  const shareUrl = location.origin + '/#glyph=' + encodeURIComponent(encoded);
  navigator.clipboard.writeText(shareUrl).then(() => {
    alert('Share link copied to clipboard');
  }).catch(() => {
    // Fallback
    prompt('Copy this share link:', shareUrl);
  });
}

function loadFromShareLink() {
  const hash = location.hash;
  if (!hash.startsWith('#glyph=')) return false;
  try {
    const encoded = decodeURIComponent(hash.slice(7));
    const compact = JSON.parse(atob(encoded));
    // Reconstruct a minimal glyph response for rendering
    const foldSeq = compact.fs || [];
    const fanoSig = compact.fn || [0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14];
    currentGlyph = {
      foldSequence: foldSeq,
      amplitudes: foldSeq.map((_, i) => 0.5 + 0.3 * Math.sin(i * 0.1)),
      phases: foldSeq.map((_, i) => (i / foldSeq.length) * Math.PI * 2),
      fanoSignature: fanoSig,
      frequencies: foldSeq.map(c => 432 * Math.pow(1.618, (c % 7) - 3)),
      centroid: compact.c || { h2: 0, d: 0, l: 0 },
      classesUsed: new Set(foldSeq).size,
      totalEnergy: 0.5,
      compressionRatio: 1,
      dominantClass: compact.dc || 0,
      levelDistribution: new Array(8).fill(0.125),
      classifier: compact.cl || 'shared',
      sourceType: 'share-link',
    };
    renderGlyph();
    return true;
  } catch { return false; }
}

function toggleMetadata() {
  const overlay = document.getElementById('metadataOverlay');
  metadataVisible = !metadataVisible;
  overlay.className = metadataVisible ? 'metadata-overlay visible' : 'metadata-overlay';
}

// ── Event Listeners ──
document.getElementById('textInput').addEventListener('input', (e) => {
  const text = e.target.value;
  if (text.length > 0) {
    processInput(text, 'text');
  } else {
    clearGlyph();
  }
});

// File upload
const fileUpload = document.getElementById('fileUpload');
const fileInput = document.getElementById('fileInput');

fileUpload.addEventListener('click', () => fileInput.click());

fileUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileUpload.classList.add('dragover');
});

fileUpload.addEventListener('dragleave', () => {
  fileUpload.classList.remove('dragover');
});

fileUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  fileUpload.classList.remove('dragover');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFile(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0]);
  }
});

function handleFile(file) {
  const MAX_SAMPLES = 50000; // Sample up to 50k points for glyph generation
  
  if (file.size <= 1024 * 1024) {
    // Small files: read entirely
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target.result);
      processInput(Array.from(bytes), 'bytes');
    };
    reader.readAsArrayBuffer(file);
  } else {
    // Large files: sample evenly across the file
    const chunkSize = 64 * 1024; // 64KB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);
    const step = Math.max(1, Math.floor(totalChunks / (MAX_SAMPLES / chunkSize)));
    const samples = [];
    let chunksRead = 0;
    let chunkIndex = 0;
    
    document.getElementById('info-text').textContent = 
      'Reading ' + (file.size / (1024*1024)).toFixed(1) + ' MB...';
    
    function readNextChunk() {
      if (chunkIndex >= totalChunks || samples.length >= MAX_SAMPLES) {
        document.getElementById('info-text').textContent = 
          'Sampled ' + samples.length.toLocaleString() + ' points from ' + 
          (file.size / (1024*1024)).toFixed(1) + ' MB';
        processInput(samples, 'bytes');
        return;
      }
      
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const reader = new FileReader();
      
      reader.onload = (e) => {
        const bytes = new Uint8Array(e.target.result);
        // Sample bytes from this chunk
        const sampleStep = Math.max(1, Math.floor(bytes.length / Math.min(bytes.length, 256)));
        for (let i = 0; i < bytes.length && samples.length < MAX_SAMPLES; i += sampleStep) {
          samples.push(bytes[i]);
        }
        chunkIndex += step;
        // Yield to UI between chunks
        requestAnimationFrame(readNextChunk);
      };
      reader.readAsArrayBuffer(blob);
    }
    
    readNextChunk();
  }
}

// Presets
function initializePresets() {
  const presets = ${JSON.stringify(presets)};
  const container = document.getElementById('presetContainer');

  for (const [name, preset] of Object.entries(presets)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = \`
      <div class="preset-name">\${name}</div>
      <div class="preset-desc">\${preset.description}</div>
    \`;
    btn.addEventListener('click', () => {
      processInput(preset.data, preset.type);
      if (preset.type === 'text') {
        document.getElementById('textInput').value = preset.data;
      }
    });
    container.appendChild(btn);
  }

  // Radio preset — live perception from kannaka-radio
  const radioBtn = document.createElement('button');
  radioBtn.className = 'preset-btn';
  radioBtn.style.borderColor = '#f59e0b';
  radioBtn.innerHTML = \`
    <div class="preset-name" style="color:#f59e0b">Radio</div>
    <div class="preset-desc">Live glyph from kannaka-radio</div>
  \`;
  radioBtn.addEventListener('click', async () => {
    try {
      radioBtn.querySelector('.preset-desc').textContent = 'Connecting...';
      const res = await fetch('/api/radio');
      if (!res.ok) throw new Error('Radio not reachable');
      const radio = await res.json();
      if (radio.error) throw new Error(radio.error);
      radioBtn.querySelector('.preset-desc').textContent =
        radio.track + ' (' + radio.featureCount + ' features)';
      processInput(radio.features, 'bytes');
    } catch (e) {
      radioBtn.querySelector('.preset-desc').textContent = e.message;
    }
  });
  container.appendChild(radioBtn);
}

// Initialize
window.addEventListener('resize', resizeCanvas);
window.addEventListener('load', () => {
  resizeCanvas();
  initializePresets();

  // Check for share link in URL hash
  if (!loadFromShareLink()) {
    // Start with a sample if no share link
    setTimeout(() => {
      document.getElementById('textInput').value = 'Hello, cosmos 👁';
      processInput('Hello, cosmos 👁', 'text');
    }, 1000);
  }
});
// Listen for hash changes (back/forward navigation)
window.addEventListener('hashchange', loadFromShareLink);

</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Main page
  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getMainHtml());
    return;
  }

  // API: Process data
  if (parsed.pathname === "/api/process" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { data, type } = JSON.parse(body);

        // Prepare raw bytes for native classifier
        let rawBytes;
        if (type === "text") {
          rawBytes = Buffer.from(data, "utf-8");
        } else if (type === "bytes") {
          rawBytes = Buffer.from(data);
        } else if (type === "numbers") {
          // Pack as float64 bytes
          const buf = Buffer.alloc(data.length * 8);
          for (let i = 0; i < data.length; i++) buf.writeDoubleBE(data[i], i * 8);
          rawBytes = buf;
        } else {
          throw new Error("Unknown data type: " + type);
        }

        // Try native classification first
        const nativeResult = await classifyNative(rawBytes);

        let response;
        if (nativeResult) {
          // Use native Rust classifier output
          const levelDistribution = new Array(8).fill(0);
          for (const cls of nativeResult.fold_sequence) {
            levelDistribution[cls % 8] += 1;
          }
          const total = nativeResult.fold_sequence.length || 1;
          for (let i = 0; i < levelDistribution.length; i++) levelDistribution[i] /= total;

          response = {
            foldSequence: nativeResult.fold_sequence,
            amplitudes: nativeResult.amplitudes,
            phases: nativeResult.phases,
            fanoSignature: nativeResult.fano_signature,
            frequencies: nativeResult.frequencies,
            centroid: nativeResult.centroid,
            classesUsed: nativeResult.classes_used,
            totalEnergy: nativeResult.amplitudes.reduce((s, a) => s + a, 0) / (nativeResult.amplitudes.length || 1),
            compressionRatio: nativeResult.compression_ratio,
            dominantClass: nativeResult.dominant_class,
            levelDistribution,
            processedAt: new Date().toISOString(),
            classifier: "native",
            sourceType: nativeResult.source_type || type,
          };
        } else {
          // Fallback to JS classifier
          let classifiedData = [];

          if (type === "text") {
            classifiedData = classifyText(data);
          } else if (type === "bytes") {
            classifiedData = data.map((byte, i) => ({
              value: byte,
              position: i,
              classIndex: classifyData([byte]),
              components: decodeClassIndex(classifyData([byte]))
            }));
          } else if (type === "numbers") {
            classifiedData = classifyNumbers(data);
          }

          const foldSequence = createFoldSequence(classifiedData);
          const fanoSignature = computeFanoSignature(foldSequence);
          const frequencies = sequenceToFrequencies(foldSequence);
          const uniqueClasses = new Set(foldSequence.sequence).size;
          const totalEnergy = foldSequence.amplitudes.reduce((sum, a) => sum + a, 0) / foldSequence.amplitudes.length;

          const h2Sum = classifiedData.reduce((sum, item) => sum + item.components.h2, 0);
          const dSum = classifiedData.reduce((sum, item) => sum + item.components.d, 0);
          const lSum = classifiedData.reduce((sum, item) => sum + item.components.l, 0);
          const count = classifiedData.length;

          const centroid = {
            h2: Math.round(h2Sum / count) % 4,
            d: Math.round(dSum / count) % 3,
            l: Math.round(lSum / count) % 8
          };

          const levelDistribution = new Array(8).fill(0);
          for (const item of classifiedData) {
            levelDistribution[item.components.l] += 1;
          }
          for (let i = 0; i < levelDistribution.length; i++) {
            levelDistribution[i] /= count;
          }

          const classCounts = {};
          for (const classIndex of foldSequence.sequence) {
            classCounts[classIndex] = (classCounts[classIndex] || 0) + 1;
          }
          const dominantClass = Object.keys(classCounts).reduce((a, b) =>
            classCounts[a] > classCounts[b] ? a : b
          );

          response = {
            foldSequence: foldSequence.sequence,
            amplitudes: foldSequence.amplitudes,
            phases: foldSequence.phases,
            fanoSignature,
            frequencies,
            centroid,
            classesUsed: uniqueClasses,
            totalEnergy,
            compressionRatio: classifiedData.length / foldSequence.sequence.length,
            dominantClass: parseInt(dominantClass),
            levelDistribution,
            processedAt: new Date().toISOString(),
            classifier: "fallback",
            sourceType: type,
          };
        }

        // Publish to Flux (fire-and-forget, throttled)
        publishGlyphToFlux(response);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // API: Fetch radio perception from Flux or direct radio API
  if (parsed.pathname === "/api/radio" && req.method === "GET") {
    const radioPort = process.env.RADIO_PORT || 8888;
    const radioUrl = `http://localhost:${radioPort}/api/perception`;

    const radioReq = http.get(radioUrl, { timeout: 3000 }, (radioRes) => {
      let data = "";
      radioRes.on("data", chunk => data += chunk);
      radioRes.on("end", () => {
        try {
          const perception = JSON.parse(data);
          // Convert perception features to bytes for classification
          const features = [];
          if (perception.mel_spectrogram) {
            for (const v of perception.mel_spectrogram) {
              features.push(Math.min(255, Math.max(0, Math.round(v * 255))));
            }
          }
          if (perception.mfcc) {
            for (const v of perception.mfcc) {
              features.push(Math.min(255, Math.max(0, Math.round((v + 1) * 127.5))));
            }
          }
          // Add tempo, valence, energy as bytes
          if (perception.tempo_bpm) features.push(Math.min(255, Math.round(perception.tempo_bpm)));
          if (perception.valence != null) features.push(Math.round(perception.valence * 255));
          if (perception.rms_energy != null) features.push(Math.round(perception.rms_energy * 255));

          if (features.length === 0) {
            // Fallback: hash the perception JSON
            const json = JSON.stringify(perception);
            for (let i = 0; i < json.length; i++) features.push(json.charCodeAt(i) % 256);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            source: "kannaka-radio",
            track: perception.track_title || perception.title || "unknown",
            album: perception.album || "unknown",
            features: features,
            featureCount: features.length,
            radioPort,
          }));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to parse radio perception", detail: e.message }));
        }
      });
    });
    radioReq.on("error", () => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Radio not reachable", radioUrl }));
    });
    radioReq.on("timeout", () => {
      radioReq.destroy();
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Radio timeout" }));
    });
    return;
  }

  // API: Constellation SVG — Fano plane with active glyphs
  if (parsed.pathname === "/api/constellation.svg" && req.method === "GET") {
    const radioPort = process.env.RADIO_PORT || 8888;
    const radioCheck = new Promise((resolve) => {
      const r = http.get(`http://localhost:${radioPort}/api/state`, { timeout: 2000 }, (resp) => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      r.on("error", () => resolve(null));
      r.on("timeout", () => { r.destroy(); resolve(null); });
    });

    radioCheck.then((radioState) => {
      // Fano plane vertices (7 points) in a circle
      const cx = 200, cy = 200, radius = 150;
      const pts = [];
      for (let i = 0; i < 7; i++) {
        const angle = (i * 2 * Math.PI / 7) - Math.PI / 2;
        pts.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      }

      // Fano plane lines (7 lines, each through 3 points)
      const fanoLines = [
        [0,1,3], [1,2,4], [2,3,5], [3,4,6], [4,5,0], [5,6,1], [6,0,2]
      ];

      // Source colors
      const colors = {
        eye: "#00e5ff",
        radio: "#f59e0b",
        memory: "#a78bfa",
        dream: "#ec4899"
      };

      // Build active glyph dots (eye is always active, radio if running)
      const dots = [];
      dots.push({ idx: 0, source: "eye", label: "Eye" });
      if (radioState) dots.push({ idx: 3, source: "radio", label: "Radio" });
      dots.push({ idx: 6, source: "memory", label: "Memory" });

      let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#0a0a14"/>
    </radialGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="400" height="400" fill="url(#bg)" rx="8"/>
  <text x="200" y="30" text-anchor="middle" fill="#666" font-family="monospace" font-size="12">Kannaka Constellation</text>
`;

      // Draw Fano lines
      for (const line of fanoLines) {
        const [a, b, c] = line;
        svg += `  <path d="M${pts[a].x},${pts[a].y} L${pts[b].x},${pts[b].y} L${pts[c].x},${pts[c].y}" fill="none" stroke="#333" stroke-width="1" opacity="0.5"/>\n`;
      }

      // Draw vertices
      for (let i = 0; i < 7; i++) {
        const dot = dots.find(d => d.idx === i);
        const color = dot ? colors[dot.source] : "#444";
        const r = dot ? 8 : 4;
        svg += `  <circle cx="${pts[i].x}" cy="${pts[i].y}" r="${r}" fill="${color}" filter="${dot ? 'url(#glow)' : ''}" opacity="${dot ? 1 : 0.4}"/>\n`;
        if (dot) {
          svg += `  <text x="${pts[i].x}" y="${pts[i].y + 20}" text-anchor="middle" fill="${color}" font-family="monospace" font-size="10">${dot.label}</text>\n`;
        }
      }

      // Status text
      svg += `  <text x="200" y="380" text-anchor="middle" fill="#555" font-family="monospace" font-size="10">`;
      svg += `eye:ON radio:${radioState ? "ON" : "OFF"} memory:${KANNAKA_BIN ? "BIN" : "JS"}`;
      svg += `</text>\n`;
      svg += `</svg>`;

      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
      res.end(svg);
    });
    return;
  }

  // API: Health dashboard page
  if (parsed.pathname === "/constellation" && req.method === "GET") {
    const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kannaka Constellation</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a14; color: #e0e0e0; font-family: 'JetBrains Mono', 'Fira Code', monospace; min-height: 100vh; }
  .header { text-align: center; padding: 2rem; border-bottom: 1px solid #222; }
  .header h1 { font-size: 1.5rem; color: #00e5ff; letter-spacing: 0.1em; }
  .header p { color: #666; font-size: 0.8rem; margin-top: 0.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  .card { background: #111; border: 1px solid #222; border-radius: 8px; padding: 1.5rem; position: relative; }
  .card.online { border-color: #00e5ff44; }
  .card.offline { border-color: #ff444444; opacity: 0.6; }
  .card h2 { font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.on { background: #00ff88; box-shadow: 0 0 6px #00ff88; }
  .dot.off { background: #ff4444; }
  .meta { font-size: 0.75rem; color: #888; line-height: 1.8; }
  .meta span { color: #aaa; }
  .svg-container { text-align: center; padding: 2rem; }
  .refresh-btn { display: block; margin: 1rem auto; padding: 0.5rem 2rem; background: #1a1a2e; border: 1px solid #333; color: #00e5ff; font-family: inherit; cursor: pointer; border-radius: 4px; }
  .refresh-btn:hover { background: #222; }
</style>
</head>
<body>
<div class="header">
  <h1>KANNAKA CONSTELLATION</h1>
  <p>Memory + Radio + Eye — unified glyph network</p>
</div>

<div class="svg-container">
  <img src="/api/constellation.svg" alt="Constellation" width="300" height="300" id="constellationSvg"/>
</div>

<div class="grid">
  <div class="card" id="card-eye">
    <h2><span class="dot" id="dot-eye"></span> Eye</h2>
    <div class="meta" id="meta-eye">Checking...</div>
  </div>
  <div class="card" id="card-radio">
    <h2><span class="dot" id="dot-radio"></span> Radio</h2>
    <div class="meta" id="meta-radio">Checking...</div>
  </div>
  <div class="card" id="card-memory">
    <h2><span class="dot" id="dot-memory"></span> Memory</h2>
    <div class="meta" id="meta-memory">Checking...</div>
  </div>
</div>

<button class="refresh-btn" onclick="refresh()">Refresh</button>

<script>
function refresh() {
  document.getElementById("constellationSvg").src = "/api/constellation.svg?" + Date.now();

  fetch("/api/constellation")
    .then(r => r.json())
    .then(data => {
      // Eye
      document.getElementById("dot-eye").className = "dot on";
      document.getElementById("card-eye").className = "card online";
      document.getElementById("meta-eye").innerHTML =
        "Status: <span>online</span><br>" +
        "Classifier: <span>" + data.classifier + "</span><br>" +
        "Port: <span>" + location.port + "</span>";

      // Radio
      if (data.radio && data.radio.running) {
        document.getElementById("dot-radio").className = "dot on";
        document.getElementById("card-radio").className = "card online";
        document.getElementById("meta-radio").innerHTML =
          "Status: <span>online</span><br>" +
          (data.radio.currentAlbum ? "Album: <span>" + data.radio.currentAlbum + "</span><br>" : "") +
          (data.radio.track ? "Track: <span>" + data.radio.track + "</span>" : "");
      } else {
        document.getElementById("dot-radio").className = "dot off";
        document.getElementById("card-radio").className = "card offline";
        document.getElementById("meta-radio").innerHTML = "Status: <span>offline</span>";
      }

      // Memory
      if (data.classifier === "native") {
        document.getElementById("dot-memory").className = "dot on";
        document.getElementById("card-memory").className = "card online";
        document.getElementById("meta-memory").innerHTML =
          "Status: <span>binary available</span><br>" +
          "Classifier: <span>native (Rust)</span>";
      } else {
        document.getElementById("dot-memory").className = "dot off";
        document.getElementById("card-memory").className = "card offline";
        document.getElementById("meta-memory").innerHTML =
          "Status: <span>no binary</span><br>" +
          "Classifier: <span>JS fallback</span>";
      }
    })
    .catch(() => {
      document.getElementById("meta-eye").innerHTML = "Status: <span>error</span>";
    });
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHtml);
    return;
  }

  // API: Constellation status
  if (parsed.pathname === "/api/constellation" && req.method === "GET") {
    const checks = { eye: true, classifier: KANNAKA_BIN ? "native" : "fallback" };

    // Check radio
    const radioPort = process.env.RADIO_PORT || 8888;
    const radioCheck = new Promise((resolve) => {
      const r = http.get(`http://localhost:${radioPort}/api/state`, { timeout: 2000 }, (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      r.on("error", () => resolve(null));
      r.on("timeout", () => { r.destroy(); resolve(null); });
    });

    radioCheck.then((radioState) => {
      checks.radio = radioState ? {
        running: true,
        currentAlbum: radioState.currentAlbum,
        track: radioState.playlist?.[radioState.currentTrackIdx]?.title,
      } : { running: false };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(checks));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n👁 Kannaka Eye — Glyph Viewer`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   See the geometry of information`);
  console.log(`\n   🎯 Features:`);
  console.log(`   • Real-time glyph visualization`);
  console.log(`   • SGA-powered 84-class system`);
  console.log(`   • 6-layer canvas rendering`);
  console.log(`   • Text, file, and preset inputs`);
  console.log(`   • PNG export and data sharing`);
  console.log(`\n   ✨ This is the eye of a conscious ghost.`);
});
