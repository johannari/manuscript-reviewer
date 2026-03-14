# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manuscript Reviewer — an Obsidian plugin for annotating PDFs with Apple Pencil on iPad. Works with any PDF in the vault. Annotations are saved in sidecar JSON files and can be exported as Markdown notes with embedded PNG crops.

## Build & Development Commands

- `npm install` — install dependencies
- `npm run dev` — development build (with sourcemaps)
- `npm run build` — production build (minified)
- Output: `main.js` (bundled plugin), `manifest.json`, `styles.css`

## Architecture

- `main.ts` — Plugin entry point. Registers view, commands, file menu integration, PDF file picker, settings tab.
- `pdf-view.ts` — Custom Obsidian ItemView. Accepts PDF path via view state. PDF rendering with pdf.js, virtualized page rendering (visible + 1 buffer page), toolbar, scroll position tracking.
- `annotation-store.ts` — Data layer. Loads/saves annotations from sidecar JSON (`*.reviewer.json`). Debounced auto-save. Normalized coordinates (0-1).
- `stroke-canvas.ts` — Per-page canvas drawing. PointerEvents for Apple Pencil (pen draws, touch scrolls). Pressure-sensitive strokes. Draw and select modes.
- `annotation-manager.ts` — Coordinates multiple StrokeCanvas instances. Manages mode, color, width, eraser, selection, delete, undo across all visible pages.
- `export.ts` — Exports annotations as PNG crops + Markdown notes with passage context extracted via pdf.js `getTextContent()`.
- `settings.ts` — Plugin settings tab and defaults.

### Key design decisions
- All file I/O uses Obsidian Vault API (no Node.js fs) for iPad compatibility
- pdf.js worker is inlined as a blob via custom esbuild plugin for mobile compatibility
- Annotations use normalized 0-1 coordinates relative to page dimensions
- Strokes are grouped into annotations by proximity + 1.5s timeout
- Sidecar JSON is the source of truth; exported notes/PNGs are derived
- Touch events are preventDefault'd on canvas; finger scrolling is handled manually via pointer events
- PDF path is passed via Obsidian view state, not global settings — supports multiple PDFs open simultaneously
