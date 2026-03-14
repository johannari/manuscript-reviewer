# Manuscript Reviewer

An Obsidian plugin for annotating PDFs with Apple Pencil (or any stylus) on iPad. Handwritten margin notes are saved alongside the PDF and can be exported as structured Markdown with embedded PNG crops.

## Features

- **Open any PDF** in your vault — right-click → "Annotate with Manuscript Reviewer"
- **Apple Pencil draws, finger scrolls** — pen input is captured for drawing while touch still scrolls the document
- **Pressure-sensitive strokes** with configurable color and width
- **Virtualized rendering** — only visible pages are rendered, so large PDFs stay fast
- **Sidecar JSON storage** — annotations live in `yourfile.reviewer.json` next to the PDF, easy to sync and version
- **Select, delete, undo, eraser** — full editing toolbar
- **Export annotations** as Markdown notes with PNG crops and extracted text context
- **Works on iPad and desktop** — optimized for iPad with Apple Pencil, also works with mouse on desktop

## Installation

### Via BRAT (recommended for beta testing)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian
2. Add beta plugin: `johannari/manuscript-reviewer`
3. Enable the plugin in Settings → Community plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/johannari/manuscript-reviewer/releases)
2. Create a folder: `<your-vault>/.obsidian/plugins/manuscript-reviewer/`
3. Copy the three files into that folder
4. Enable the plugin in Settings → Community plugins

## Usage

1. Add a PDF to your Obsidian vault
2. Right-click the PDF in the file explorer → **"Annotate with Manuscript Reviewer"**
   - Or use the command palette: **"Annotate a PDF"**
   - Or click the pen icon in the sidebar ribbon
3. Draw with Apple Pencil (or mouse on desktop). Scroll with your finger.
4. Annotations auto-save to a `.reviewer.json` sidecar file next to the PDF

### Toolbar

| Button | Action |
|--------|--------|
| **Draw** | Freehand drawing mode (default) |
| **Select** | Tap an annotation to select it |
| **Undo** | Remove the last stroke |
| **Delete** | Delete the selected annotation |
| **Eraser** | Tap an annotation to erase it |
| Color swatches | Red, blue, black, green, orange |
| **S / M / L / XL** | Stroke width |

### Exporting

Use the command palette → **"Export annotations for current PDF"** to generate a Markdown file with:
- PNG crops of each annotation
- Extracted text context from the PDF near each annotation
- Organized by page number

## Settings

- **Export directory** — where exported notes and images are saved (default: `manuscript-reviewer-notes/`)
- **Default pen color** — default color for new annotations
- **Default pen width** — default stroke width (1–10)
- **Stroke grouping timeout** — milliseconds to wait before starting a new annotation group (500–5000ms)

## How it works

- PDFs are rendered with [pdf.js](https://mozilla.github.io/pdf.js/) using an inlined web worker for mobile compatibility
- Each page gets a transparent canvas overlay for drawing
- Pointer events distinguish pen from finger — pen draws, finger scrolls
- Annotations use normalized 0–1 coordinates so they're resolution-independent
- Nearby strokes within the grouping timeout are merged into a single annotation
- The sidecar JSON is the source of truth; exported notes/PNGs are derived artifacts

## Development

```bash
npm install
npm run dev    # development build with sourcemaps
npm run build  # production build (minified)
```

Output: `main.js` (bundled plugin), `manifest.json`, `styles.css`

## License

MIT
