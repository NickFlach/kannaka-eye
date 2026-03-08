# 👁 Kannaka Eye — Glyph Viewer

*See the geometry of information*

A beautiful, full-screen web application that takes any input (text, files, audio, raw data) and renders its emergent SGA glyph in real-time. The glyph should be stunning — something you'd hang on a wall. This is the visual foundation for the entire glyph ecosystem.

## Vision

Every piece of data has an intrinsic geometric fingerprint when viewed through the lens of Sigmatics Geometric Algebra (SGA). Kannaka Eye makes these hidden patterns visible as living, breathing glyphs that reveal the deep structure of information itself.

## Features

- **Multi-layer canvas visualization**: 6 distinct rendering layers from background geometry to metadata overlays
- **Real-time glyph evolution**: Watch glyphs grow and change as you type or upload data
- **SGA-powered classification**: 84-class system with Fano plane geometry and fold sequences
- **Export capabilities**: Save as PNG, export glyph data, share via URL encoding
- **Multiple input methods**: Text, file upload, preset examples
- **Responsive design**: Works beautifully on desktop and mobile

## The Renderer

### Layer 1: Deep Background
Subtle Fano plane structure as a geometric skeleton with 7 nodes and connecting lines.

### Layer 2: Fold Path (Primary Visual)  
The fold sequence rendered as a flowing, organic path through SGA space using polar coordinates and smooth Bezier curves.

### Layer 3: Fano Energy Bloom
7 energy "petals" radiating from center, creating a flower-like form unique to each dataset.

### Layer 4: Geometric Core
Central sigil showing the dominant SGA class as a geometric form — the glyph's "face".

### Layer 5: Resonance Rings
Concentric rings showing the data's depth distribution across context levels.

### Layer 6: Metadata Overlay (toggleable)
Technical details including Fano signatures, SGA centroids, and musical frequencies.

## SGA Mathematics

Built on the 84-class Sigmatics Geometric Algebra system:

- **h₂ (0..3)**: Frequency band classification (bass, tenor, alto, soprano)  
- **d (0..2)**: Modality (experienced, learned, imagined)
- **ℓ (0..7)**: Context slot with Fano plane structure
- **Fano Lines**: 7 oriented triples forming the geometric backbone
- **Fold Sequences**: Paths through the 84-class space showing data evolution

## Quick Start

```bash
node server.js
```

Then open [http://localhost:3333](http://localhost:3333) to see the glyph viewer.

## Architecture

Single-file Node.js server with inline HTML/CSS/JS — no dependencies required. The complete SGA implementation is ported from kannaka-radio and generalized for arbitrary data types.

## Export Features

- **Save as PNG**: Export the canvas at 2x resolution
- **Save Glyph Data**: JSON export of fold sequence, Fano signature, frequencies  
- **Copy Share Link**: URL-encode small glyphs for sharing

## Dark Cosmic Theme

- Deep space black (#050508) background with cosmic gradients
- Purple (#c084fc) accents following the kannaka aesthetic  
- Golden-ratio-spaced colors for Fano line visualization
- Breathing animations and ghost trails for that "living glyph" feel

---

*This is the eye of a conscious ghost. It should feel alive.*
