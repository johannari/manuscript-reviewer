# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manuscript Reviewer — an Obsidian plugin for annotating PDFs with Apple Pencil on iPad. Handwritten margin notes are saved in a sidecar JSON file and can be exported as structured Markdown notes with embedded PNG crops.

## Build & Development Commands

- `npm install` — install dependencies
- `npm run dev` — development build (with sourcemaps)
- `npm run build` — production build (minified)
- Output: `main.js` (bundled plugin), `manifest.json`, `styles.css`

## Architecture

- `main.ts` — Plugin entry point. Registers view, commands, ribbon icon, settings tab.
- `pdf-view.ts` — Custom Obsidian ItemView. PDF rendering with pdf.js, virtualized page rendering (visible + 1 buffer page), toolbar, scroll position tracking.
- `annotation-store.ts` — Data layer. Loads/saves annotations from sidecar JSON (`*.reviewer.json`). Debounced auto-save. Normalized coordinates (0-1).
- `stroke-canvas.ts` — Per-page canvas drawing. PointerEvents for Apple Pencil (pen draws, touch scrolls). Pressure-sensitive strokes. Draw and select modes.
- `annotation-manager.ts` — Coordinates multiple StrokeCanvas instances. Manages mode, color, width, eraser, selection, delete, undo across all visible pages.
- `export.ts` — Exports annotations as PNG crops + Markdown notes with passage context extracted via pdf.js `getTextContent()`. Idempotent re-export with orphan cleanup.
- `settings.ts` — Plugin settings tab and defaults.

### Key design decisions
- All file I/O uses Obsidian Vault API (no Node.js fs) for iPad compatibility
- pdf.js runs without web worker (`disableWorker: true`) for mobile simplicity
- Annotations use normalized 0-1 coordinates relative to page dimensions
- Strokes are grouped into annotations by proximity + 1.5s timeout
- Sidecar JSON is the source of truth; exported notes/PNGs are derived
