# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manuscript Reviewer — an Obsidian plugin for annotating PDFs with Apple Pencil on iPad. Works with any PDF in the vault. Annotations are saved in sidecar JSON files and can be exported as Markdown notes with full-page composite PNGs.

**Canonical path:** `~/code/manuscript-reviewer`
**GitHub:** `johannari/manuscript-reviewer` (private), branch `master`
**Related project:** Book repo at `~/code/non-engineering-engineering-leadership`

## Deployment & Workflow

**The plugin runs on iPad.** Annotation and export both happen on iPad in Obsidian. The Mac is only used for building the plugin from source and running Claude Code for processing.

**Plugin update flow (Mac → iPad):**
1. Build on Mac: `npm run build` in `~/code/manuscript-reviewer`
2. Commit and push to GitHub (`master` branch)
3. The author uses **BRAT** (Beta Reviewers Auto-update Tester) on iPad to pull the latest version from GitHub
4. Force-quit and reopen Obsidian on iPad to load the update

**Annotation processing flow (iPad → Mac → Claude Code):**
1. Author annotates PDF on iPad with Apple Pencil
2. Author runs "Export annotations" in Obsidian **on iPad** — plugin exports full-page PNGs + markdown to the iCloud vault
3. iCloud syncs the exported files to Mac
4. Author runs `make commit-annotations` on Mac (commits and pushes annotation exports to git)
5. Claude Code (terminal on Mac) runs `make sync-annotations` and processes the files

**Do NOT:** suggest exporting on Mac, suggest iCloud file copy for plugin updates, or confuse which device runs what.

## Build & Development Commands

- `npm install` — install dependencies
- `npm run dev` — development build (with sourcemaps)
- `npm run build` — production build (minified)
- Output: `main.js` (bundled plugin), `manifest.json`, `styles.css`

## Architecture

- `main.ts` — Plugin entry point. Registers view, commands, file menu integration, PDF file picker, settings tab. v2.4.0+: post-export shell command execution (e.g., git commit+push) via `child_process.exec`.
- `pdf-view.ts` — Custom Obsidian ItemView. Accepts PDF path via view state. PDF rendering with pdf.js, virtualized page rendering (visible + 1 buffer page), toolbar, scroll position tracking.
- `annotation-store.ts` — Data layer. Loads/saves annotations from sidecar JSON (`*.reviewer.json`). Debounced auto-save. Normalized coordinates (0-1).
- `stroke-canvas.ts` — Per-page canvas drawing. PointerEvents for Apple Pencil (pen draws, touch scrolls). Pressure-sensitive strokes. Draw and select modes.
- `annotation-manager.ts` — Coordinates multiple StrokeCanvas instances. Manages mode, color, width, eraser, selection, delete, undo across all visible pages.
- `export.ts` — Exports annotations as full-page composite PNGs (one per annotated page, all strokes overlaid) + Markdown notes with passage context extracted via pdf.js `getTextContent()`. v2.5.0: page-level export (replaces per-annotation PNG crops). v2.3.0+: filters noise (minimum size/path length), classifies annotation types (text/arrow/circle/underline/strikethrough/mark), passage-level text extraction (1-3 nearest lines), export state tracking.
- `settings.ts` — Plugin settings tab and defaults. Includes post-export sync settings (toggle, git repo path, shell command).

### Key design decisions
- All file I/O uses Obsidian Vault API (no Node.js fs) for iPad compatibility
- pdf.js worker is inlined as a blob via custom esbuild plugin for mobile compatibility
- Annotations use normalized 0-1 coordinates relative to page dimensions
- Strokes are grouped into annotations by proximity + 1.5s timeout
- Sidecar JSON is the source of truth; exported notes/PNGs are derived
- Touch events are preventDefault'd on canvas; finger scrolling is handled manually via pointer events
- PDF path is passed via Obsidian view state, not global settings — supports multiple PDFs open simultaneously
- Post-export sync runs a configurable shell command (default: `make commit-annotations`) in a configurable working directory — uses Node.js `child_process.exec`, not Obsidian Vault API. Note: shell commands only work on desktop (Mac), not on iPad.
- Export produces one `page-{N}.png` per annotated page (full page with all strokes), not one `annotation-{id}.png` per stroke cluster. This prevents multi-line handwritten notes from being fragmented across separate images.
