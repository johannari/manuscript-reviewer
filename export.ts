import { App, TFile, normalizePath } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { Annotation, AnnotationStore, Stroke, StrokePoint } from "./annotation-store";

interface ChapterConfig {
	id: string;
	label: string;
	startPage: number;
	endPage: number;
	notesFile: string;
	sections: string[];
}

interface FullConfig {
	chapters: ChapterConfig[];
}

export type AnnotationType = "text" | "arrow" | "circle" | "underline" | "strikethrough" | "mark";

interface ExportState {
	lastExportDate: string;
	pdfPath: string;
	exportedAnnotations: Record<string, { exportDate: string; page: number }>;
}

// Minimum annotation diagonal as fraction of page (filters accidental touches)
const MIN_ANNOTATION_DIAGONAL = 0.008;
// Minimum total stroke path length as fraction of page diagonal
const MIN_STROKE_PATH_LENGTH = 0.005;

export class ExportManager {
	private app: App;
	private store: AnnotationStore;

	constructor(app: App, store: AnnotationStore) {
		this.app = app;
		this.store = store;
	}

	async loadConfig(configPath: string): Promise<FullConfig> {
		const path = normalizePath(configPath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`Config file not found: ${configPath}`);
		}
		const content = await this.app.vault.read(file);
		return JSON.parse(content);
	}

	/**
	 * Filter out tiny accidental touches and marks below minimum size threshold.
	 */
	private filterNoise(annotations: Annotation[]): Annotation[] {
		return annotations.filter((ann) => {
			const b = ann.boundingBox;
			const diagonal = Math.sqrt(b.width ** 2 + b.height ** 2);
			if (diagonal < MIN_ANNOTATION_DIAGONAL) return false;

			// Also check total stroke path length
			let totalPathLength = 0;
			for (const stroke of ann.strokes) {
				for (let i = 1; i < stroke.points.length; i++) {
					const dx = stroke.points[i].x - stroke.points[i - 1].x;
					const dy = stroke.points[i].y - stroke.points[i - 1].y;
					totalPathLength += Math.sqrt(dx * dx + dy * dy);
				}
			}
			if (totalPathLength < MIN_STROKE_PATH_LENGTH) return false;

			return true;
		});
	}

	/**
	 * Classify annotation based on stroke geometry.
	 */
	classifyAnnotation(ann: Annotation): AnnotationType {
		const b = ann.boundingBox;
		const diagonal = Math.sqrt(b.width ** 2 + b.height ** 2);

		// Very small = mark (dot, tap)
		if (diagonal < 0.02) return "mark";

		const aspectRatio = b.height / Math.max(b.width, 0.001);
		const totalStrokes = ann.strokes.length;
		const totalPoints = ann.strokes.reduce((sum, s) => sum + s.points.length, 0);

		// Single stroke analysis
		if (totalStrokes === 1) {
			const stroke = ann.strokes[0];
			const pts = stroke.points;

			// Check if roughly horizontal (underline or strikethrough)
			if (aspectRatio < 0.2 && b.width > 0.03) {
				return "underline"; // caller can check Y overlap with text for strikethrough
			}

			// Check if roughly closed curve (circle)
			if (pts.length > 8) {
				const startEnd = Math.sqrt(
					(pts[0].x - pts[pts.length - 1].x) ** 2 +
					(pts[0].y - pts[pts.length - 1].y) ** 2
				);
				if (startEnd < diagonal * 0.4) {
					return "circle";
				}
			}

			// Check if arrow-like (large directional spread, start far from end)
			if (pts.length >= 3 && pts.length < 30) {
				const startEnd = Math.sqrt(
					(pts[0].x - pts[pts.length - 1].x) ** 2 +
					(pts[0].y - pts[pts.length - 1].y) ** 2
				);
				if (startEnd > diagonal * 0.4) {
					return "arrow";
				}
			}
		}

		// Multiple strokes or complex single stroke = likely text
		if (totalStrokes > 1 || totalPoints > 15) {
			// Check for strikethrough: multiple short horizontal strokes
			const allHorizontal = ann.strokes.every((s) => {
				if (s.points.length < 2) return false;
				const sHeight = Math.abs(
					Math.max(...s.points.map((p) => p.y)) -
					Math.min(...s.points.map((p) => p.y))
				);
				const sWidth = Math.abs(
					Math.max(...s.points.map((p) => p.x)) -
					Math.min(...s.points.map((p) => p.x))
				);
				return sWidth > 0.02 && sHeight / sWidth < 0.3;
			});
			if (allHorizontal && aspectRatio < 0.25) {
				return "strikethrough";
			}

			return "text";
		}

		return "mark";
	}

	async exportChapter(
		chapterId: string,
		configPath: string,
		pdfPath: string,
		exportDir: string
	): Promise<string> {
		const config = await this.loadConfig(configPath);
		const chapter = config.chapters.find((c) => c.id === chapterId);
		if (!chapter) throw new Error(`Chapter not found: ${chapterId}`);

		let annotations = this.store
			.getAnnotations()
			.filter(
				(a) =>
					a.page >= chapter.startPage && a.page <= chapter.endPage
			)
			.sort((a, b) => a.page - b.page || a.boundingBox.y - b.boundingBox.y);

		// Filter noise
		annotations = this.filterNoise(annotations);

		const photoDir = normalizePath(
			`${exportDir}photos/${chapter.id}`
		);
		await this.ensureFolder(photoDir);

		// Load PDF for text extraction
		const pdfFile = this.app.vault.getAbstractFileByPath(
			normalizePath(pdfPath)
		);
		if (!(pdfFile instanceof TFile))
			throw new Error(`PDF not found: ${pdfPath}`);
		const pdfBuf = await this.app.vault.readBinary(pdfFile);
		const pdf = await pdfjsLib.getDocument({ data: pdfBuf }).promise;

		// Group annotations by page
		const pageGroups = new Map<number, Annotation[]>();
		for (const ann of annotations) {
			const list = pageGroups.get(ann.page) || [];
			list.push(ann);
			pageGroups.set(ann.page, list);
		}

		// Render one full-page PNG per annotated page, collect context per annotation
		const entries: {
			annotation: Annotation;
			pagePngPath: string;
			context: string;
			section: string;
			type: AnnotationType;
		}[] = [];

		for (const [pageNum, pageAnns] of [...pageGroups.entries()].sort((a, b) => a[0] - b[0])) {
			const pngFilename = `page-${pageNum}.png`;
			const pngFullPath = normalizePath(`${photoDir}/${pngFilename}`);

			const pdfPage = await pdf.getPage(pageNum);
			await this.renderPagePng(pageAnns, pngFullPath, pdfPage);

			const pagePngPath = `photos/${chapter.id}/${pngFilename}`;
			for (const ann of pageAnns) {
				const context = await this.extractNearestText(pdfPage, ann.boundingBox);
				const section = this.determineSection(ann.page, ann.boundingBox.y, chapter);
				const type = this.classifyAnnotation(ann);

				entries.push({
					annotation: ann,
					pagePngPath,
					context,
					section,
					type,
				});
			}
		}

		// Generate markdown
		const md = this.generateMarkdown(chapter, entries);
		const notesPath = normalizePath(
			`${exportDir}${chapter.notesFile.replace(/^notes\//, "")}`
		);
		await this.ensureFolder(
			notesPath.substring(0, notesPath.lastIndexOf("/"))
		);

		const existingFile =
			this.app.vault.getAbstractFileByPath(notesPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, md);
		} else {
			await this.app.vault.create(notesPath, md);
		}

		// Clean up orphaned PNGs
		await this.cleanOrphanedPngs(photoDir, annotations);

		// Write export state
		await this.writeExportState(exportDir, pdfPath, annotations);

		return notesPath;
	}

	async exportSimple(
		pdfPath: string,
		notesPath: string,
		exportDir: string
	): Promise<string> {
		let annotations = this.store
			.getAnnotations()
			.sort((a, b) => a.page - b.page || a.boundingBox.y - b.boundingBox.y);

		// Filter noise
		annotations = this.filterNoise(annotations);

		if (annotations.length === 0) {
			throw new Error("No annotations to export (all filtered as noise)");
		}

		const pdfName = pdfPath.replace(/\.pdf$/i, "").split("/").pop() || "pdf";
		const photoDir = normalizePath(`${exportDir}/photos/${pdfName}`);
		await this.ensureFolder(photoDir);

		// Load PDF for text extraction
		const pdfFile = this.app.vault.getAbstractFileByPath(
			normalizePath(pdfPath)
		);
		if (!(pdfFile instanceof TFile))
			throw new Error(`PDF not found: ${pdfPath}`);
		const pdfBuf = await this.app.vault.readBinary(pdfFile);
		const pdf = await pdfjsLib.getDocument({ data: pdfBuf }).promise;

		// Group annotations by page
		const pageGroups = new Map<number, Annotation[]>();
		for (const ann of annotations) {
			const list = pageGroups.get(ann.page) || [];
			list.push(ann);
			pageGroups.set(ann.page, list);
		}

		// Render one full-page PNG per annotated page, collect context per annotation
		const pageEntries: {
			page: number;
			pngPath: string;
			annotations: { context: string; type: AnnotationType }[];
		}[] = [];

		for (const [pageNum, pageAnns] of [...pageGroups.entries()].sort((a, b) => a[0] - b[0])) {
			const pngFilename = `page-${pageNum}.png`;
			const pngFullPath = normalizePath(`${photoDir}/${pngFilename}`);

			const pdfPage = await pdf.getPage(pageNum);
			await this.renderPagePng(pageAnns, pngFullPath, pdfPage);

			const annEntries: { context: string; type: AnnotationType }[] = [];
			for (const ann of pageAnns) {
				const context = await this.extractNearestText(pdfPage, ann.boundingBox);
				const type = this.classifyAnnotation(ann);
				annEntries.push({ context, type });
			}

			pageEntries.push({
				page: pageNum,
				pngPath: `photos/${pdfName}/${pngFilename}`,
				annotations: annEntries,
			});
		}

		// Generate markdown: one image per page, annotation contexts listed below
		let md = `# Annotations: ${pdfName}\n\n`;
		for (const entry of pageEntries) {
			md += `## Page ${entry.page}\n\n`;
			md += `![[${entry.pngPath}]]\n\n`;
			for (const ann of entry.annotations) {
				const typeTag = `[${ann.type}]`;
				const context = ann.context
					? `> "${ann.context}" (p. ${entry.page}) ${typeTag}\n\n`
					: `> (p. ${entry.page}) ${typeTag}\n\n`;
				md += context;
			}
		}

		await this.ensureFolder(
			notesPath.substring(0, notesPath.lastIndexOf("/"))
		);

		const existingFile =
			this.app.vault.getAbstractFileByPath(notesPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, md);
		} else {
			await this.app.vault.create(notesPath, md);
		}

		// Clean up orphaned PNGs
		await this.cleanOrphanedPngs(photoDir, annotations);

		// Write export state
		await this.writeExportState(exportDir, pdfPath, annotations);

		return notesPath;
	}

	async exportAllChapters(
		configPath: string,
		pdfPath: string,
		exportDir: string
	): Promise<string[]> {
		const config = await this.loadConfig(configPath);
		const results: string[] = [];
		for (const chapter of config.chapters) {
			const path = await this.exportChapter(
				chapter.id,
				configPath,
				pdfPath,
				exportDir
			);
			results.push(path);
		}
		return results;
	}

	/**
	 * Render a full-page composite PNG with ALL annotations on that page overlaid.
	 * One image per annotated page — no cropping, no fragmentation.
	 */
	private async renderPagePng(
		pageAnnotations: Annotation[],
		outputPath: string,
		pdfPage: pdfjsLib.PDFPageProxy
	): Promise<void> {
		const pdfScale = 2;
		const viewport = pdfPage.getViewport({ scale: pdfScale });

		// Render at 800px wide, preserving aspect ratio
		const renderWidth = 800;
		const renderHeight = Math.round(
			(viewport.height / viewport.width) * renderWidth
		);

		const canvas = document.createElement("canvas");
		canvas.width = renderWidth;
		canvas.height = renderHeight;
		const ctx = canvas.getContext("2d")!;

		// Render full PDF page as background
		const pdfCanvas = document.createElement("canvas");
		pdfCanvas.width = viewport.width;
		pdfCanvas.height = viewport.height;
		const pdfCtx = pdfCanvas.getContext("2d")!;
		await pdfPage.render({ canvasContext: pdfCtx, viewport }).promise;

		ctx.drawImage(
			pdfCanvas,
			0, 0, viewport.width, viewport.height,
			0, 0, renderWidth, renderHeight
		);

		// Overlay strokes from ALL annotations on this page
		const scaleX = renderWidth;  // normalized coords (0-1) → pixels
		const scaleY = renderHeight;

		for (const ann of pageAnnotations) {
			for (const stroke of ann.strokes) {
				if (stroke.points.length < 2) continue;
				ctx.strokeStyle = stroke.color;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";

				const first = stroke.points[0];
				ctx.beginPath();
				ctx.moveTo(first.x * scaleX, first.y * scaleY);

				for (let i = 1; i < stroke.points.length; i++) {
					const p = stroke.points[i];
					const pressure = Math.max(0.1, p.pressure);
					ctx.lineWidth = stroke.width * pressure * 2;
					ctx.lineTo(p.x * scaleX, p.y * scaleY);
					ctx.stroke();
					ctx.beginPath();
					ctx.moveTo(p.x * scaleX, p.y * scaleY);
				}
			}
		}

		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((b) => resolve(b!), "image/png")
		);
		const arrayBuffer = await blob.arrayBuffer();
		await this.app.vault.adapter.writeBinary(
			normalizePath(outputPath),
			new Uint8Array(arrayBuffer).buffer
		);
	}

	private async extractNearestText(
		page: pdfjsLib.PDFPageProxy,
		bbox: { x: number; y: number; width: number; height: number }
	): Promise<string> {
		const textContent = await page.getTextContent();
		const viewport = page.getViewport({ scale: 1 });
		const pageHeight = viewport.height;
		const pageWidth = viewport.width;

		const items = textContent.items.filter(
			(item) => "str" in item && (item as any).str.trim().length > 0
		) as Array<{ str: string; transform: number[]; width: number; height: number }>;

		if (items.length === 0) return "";

		// Convert annotation bbox to page coordinates
		const annTop = bbox.y * pageHeight;
		const annBottom = (bbox.y + bbox.height) * pageHeight;
		const annCenterY = (annTop + annBottom) / 2;

		// Group text items into logical lines first
		const itemsWithY = items.map((item) => ({
			item,
			y: pageHeight - item.transform[5], // convert from-bottom to from-top
			x: item.transform[4],
		}));
		itemsWithY.sort((a, b) => a.y - b.y);

		// Group into lines (items within 4px Y are same line)
		const lines: { y: number; text: string; items: typeof itemsWithY }[] = [];
		let currentLineItems: typeof itemsWithY = [];
		let currentLineY = -999;
		for (const item of itemsWithY) {
			if (Math.abs(item.y - currentLineY) > 4) {
				if (currentLineItems.length > 0) {
					// Sort items in line by X position
					currentLineItems.sort((a, b) => a.x - b.x);
					lines.push({
						y: currentLineY,
						text: currentLineItems.map((i) => i.item.str).join(" "),
						items: currentLineItems,
					});
				}
				currentLineItems = [];
				currentLineY = item.y;
			}
			currentLineItems.push(item);
		}
		if (currentLineItems.length > 0) {
			currentLineItems.sort((a, b) => a.x - b.x);
			lines.push({
				y: currentLineY,
				text: currentLineItems.map((i) => i.item.str).join(" "),
				items: currentLineItems,
			});
		}

		// Score each line by Y-distance to annotation
		const annHeight = annBottom - annTop;
		const searchRadius = Math.max(annHeight * 2, pageHeight * 0.15);

		const scoredLines = lines
			.map((line) => {
				let yDist = 0;
				if (line.y < annTop) yDist = annTop - line.y;
				else if (line.y > annBottom) yDist = line.y - annBottom;
				return { ...line, dist: yDist };
			})
			.filter((line) => line.dist <= searchRadius)
			.sort((a, b) => a.dist - b.dist);

		// Take the 3 nearest lines
		const selectedLines = scoredLines.slice(0, 3);
		selectedLines.sort((a, b) => a.y - b.y); // restore reading order

		const text = selectedLines.map((l) => l.text).join(" ");
		const trimmed =
			text.length > 150 ? text.substring(0, 150) + "..." : text;
		return trimmed;
	}

	private determineSection(
		page: number,
		normalizedY: number,
		chapter: ChapterConfig
	): string {
		if (!chapter.sections || chapter.sections.length === 0)
			return "General";

		const totalPages = chapter.endPage - chapter.startPage + 1;
		const pageOffset = page - chapter.startPage;
		const position =
			(pageOffset + normalizedY) / totalPages;

		const sectionIndex = Math.min(
			Math.floor(position * chapter.sections.length),
			chapter.sections.length - 1
		);
		return chapter.sections[sectionIndex] || "General";
	}

	private generateMarkdown(
		chapter: ChapterConfig,
		entries: {
			annotation: Annotation;
			pagePngPath: string;
			context: string;
			section: string;
			type: AnnotationType;
		}[]
	): string {
		let md = `# ${chapter.label}\n\n`;

		const bySection = new Map<
			string,
			typeof entries
		>();

		for (const entry of entries) {
			const list = bySection.get(entry.section) || [];
			list.push(entry);
			bySection.set(entry.section, list);
		}

		// Use chapter section order
		const sectionOrder = chapter.sections || [];
		const allSections = new Set([
			...sectionOrder,
			...bySection.keys(),
		]);

		for (const section of allSections) {
			const sectionEntries = bySection.get(section);
			if (!sectionEntries || sectionEntries.length === 0) continue;

			md += `## ${section}\n\n`;

			// Show page image once per page within this section
			const pagesShown = new Set<string>();
			for (const entry of sectionEntries) {
				if (!pagesShown.has(entry.pagePngPath)) {
					md += `![[${entry.pagePngPath}]]\n\n`;
					pagesShown.add(entry.pagePngPath);
				}
				const typeTag = `[${entry.type}]`;
				const context = entry.context
					? `> "${entry.context}" (p. ${entry.annotation.page}) ${typeTag}\n\n`
					: `> (p. ${entry.annotation.page}) ${typeTag}\n\n`;
				md += context;
			}
		}

		return md;
	}

	private async writeExportState(
		exportDir: string,
		pdfPath: string,
		annotations: Annotation[]
	): Promise<void> {
		const statePath = normalizePath(`${exportDir}/_export-state.json`);

		// Load existing state if present
		let state: ExportState = {
			lastExportDate: new Date().toISOString(),
			pdfPath,
			exportedAnnotations: {},
		};

		const existingFile = this.app.vault.getAbstractFileByPath(statePath);
		if (existingFile instanceof TFile) {
			try {
				const content = await this.app.vault.read(existingFile);
				const existing = JSON.parse(content) as ExportState;
				state.exportedAnnotations = existing.exportedAnnotations || {};
			} catch {
				// ignore parse errors, start fresh
			}
		}

		// Update with current export
		const now = new Date().toISOString();
		for (const ann of annotations) {
			state.exportedAnnotations[ann.id] = {
				exportDate: now,
				page: ann.page,
			};
		}

		const json = JSON.stringify(state, null, 2);
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, json);
		} else {
			await this.ensureFolder(exportDir);
			await this.app.vault.create(statePath, json);
		}
	}

	private async cleanOrphanedPngs(
		photoDir: string,
		annotations: Annotation[]
	): Promise<void> {
		const validPages = new Set(annotations.map((a) => a.page));
		const folder = this.app.vault.getAbstractFileByPath(photoDir);
		if (!folder) return;

		const files = this.app.vault.getFiles().filter(
			(f) =>
				f.path.startsWith(photoDir) &&
				f.extension === "png"
		);

		for (const file of files) {
			// Clean up old per-annotation PNGs (from previous versions)
			const annMatch = file.basename.match(/^annotation-([a-f0-9]+)$/);
			if (annMatch) {
				await this.app.vault.delete(file);
				continue;
			}

			// Clean up orphaned page PNGs (pages with no annotations)
			const pageMatch = file.basename.match(/^page-(\d+)$/);
			if (pageMatch && !validPages.has(parseInt(pageMatch[1]))) {
				await this.app.vault.delete(file);
			}
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.app.vault.getAbstractFileByPath(normalized)) {
			try {
				await this.app.vault.createFolder(normalized);
			} catch {
				// folder may already exist
			}
		}
	}
}
