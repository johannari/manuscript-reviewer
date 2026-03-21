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

		// Render annotation PNGs and extract context
		const entries: {
			annotation: Annotation;
			pngPath: string;
			context: string;
			section: string;
			type: AnnotationType;
		}[] = [];

		for (const ann of annotations) {
			const pngFilename = `annotation-${ann.id}.png`;
			const pngPath = normalizePath(`${photoDir}/${pngFilename}`);

			const page = await pdf.getPage(ann.page);
			await this.renderAnnotationPng(ann, pngPath, page);

			const context = await this.extractNearestText(
				page,
				ann.boundingBox
			);
			const section = this.determineSection(
				ann.page,
				ann.boundingBox.y,
				chapter
			);
			const type = this.classifyAnnotation(ann);

			entries.push({
				annotation: ann,
				pngPath: `photos/${chapter.id}/${pngFilename}`,
				context,
				section,
				type,
			});
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

		const entries: {
			annotation: Annotation;
			pngPath: string;
			context: string;
			type: AnnotationType;
		}[] = [];

		for (const ann of annotations) {
			const pngFilename = `annotation-${ann.id}.png`;
			const pngPath = normalizePath(`${photoDir}/${pngFilename}`);

			const page = await pdf.getPage(ann.page);
			await this.renderAnnotationPng(ann, pngPath, page);

			const context = await this.extractNearestText(
				page,
				ann.boundingBox
			);
			const type = this.classifyAnnotation(ann);

			entries.push({
				annotation: ann,
				pngPath: `photos/${pdfName}/${pngFilename}`,
				context,
				type,
			});
		}

		// Generate markdown with type tags
		let md = `# Annotations: ${pdfName}\n\n`;
		let currentPage = -1;
		for (const entry of entries) {
			if (entry.annotation.page !== currentPage) {
				currentPage = entry.annotation.page;
				md += `## Page ${currentPage}\n\n`;
			}
			const typeTag = `[${entry.type}]`;
			const context = entry.context
				? `> "${entry.context}" (p. ${entry.annotation.page}) ${typeTag}\n`
				: `> (p. ${entry.annotation.page}) ${typeTag}\n`;
			md += context;
			md += `> ![[${entry.pngPath}]]\n\n`;
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

	private async renderAnnotationPng(
		ann: Annotation,
		outputPath: string,
		pdfPage?: pdfjsLib.PDFPageProxy
	): Promise<void> {
		const b = ann.boundingBox;
		const diagonal = Math.sqrt(b.width ** 2 + b.height ** 2);

		// Scale padding inversely with annotation size
		// Small annotations get more padding (up to 30%), large stay at 15%
		const basePadding = 0.15;
		const padding = diagonal < 0.05
			? Math.min(0.30, basePadding + (0.05 - diagonal) * 3)
			: basePadding;

		// For margin annotations (left or right edge), use full page width
		const isMarginAnnotation = b.x < 0.15 || (b.x + b.width) > 0.85;

		// Clamp the crop region to page bounds (0-1 normalized)
		let cropX: number, cropRight: number;
		if (isMarginAnnotation) {
			// Full width so the text being referenced is visible
			cropX = 0;
			cropRight = 1;
		} else {
			cropX = Math.max(0, b.x - padding);
			cropRight = Math.min(1, b.x + b.width + padding);
		}
		const cropY = Math.max(0, b.y - padding);
		const cropBottom = Math.min(1, b.y + b.height + padding);
		const cropW = cropRight - cropX;
		const cropH = cropBottom - cropY;

		const renderWidth = 800;
		const aspectRatio = cropH / cropW;
		// Minimum height of 100px so tiny marks aren't microscopic
		const renderHeight = Math.max(100, Math.round(renderWidth * aspectRatio));

		const canvas = document.createElement("canvas");
		canvas.width = renderWidth;
		canvas.height = renderHeight;
		const ctx = canvas.getContext("2d")!;

		// Render PDF page crop as background if available
		if (pdfPage) {
			const pdfScale = 2; // high-res for crisp text
			const viewport = pdfPage.getViewport({ scale: pdfScale });
			const pdfCanvas = document.createElement("canvas");
			pdfCanvas.width = viewport.width;
			pdfCanvas.height = viewport.height;
			const pdfCtx = pdfCanvas.getContext("2d")!;
			await pdfPage.render({ canvasContext: pdfCtx, viewport }).promise;

			// Crop the relevant region from the PDF page
			const srcX = cropX * viewport.width;
			const srcY = cropY * viewport.height;
			const srcW = cropW * viewport.width;
			const srcH = cropH * viewport.height;
			ctx.drawImage(pdfCanvas, srcX, srcY, srcW, srcH, 0, 0, renderWidth, renderHeight);
		} else {
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, renderWidth, renderHeight);
		}

		// Overlay strokes on top of the PDF crop
		const scaleX = renderWidth / cropW;
		const scaleY = renderHeight / cropH;

		for (const stroke of ann.strokes) {
			if (stroke.points.length < 2) continue;
			ctx.strokeStyle = stroke.color;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";

			const first = stroke.points[0];
			ctx.beginPath();
			ctx.moveTo(
				(first.x - cropX) * scaleX,
				(first.y - cropY) * scaleY
			);

			for (let i = 1; i < stroke.points.length; i++) {
				const p = stroke.points[i];
				const pressure = Math.max(0.1, p.pressure);
				ctx.lineWidth = stroke.width * pressure * 2;
				ctx.lineTo(
					(p.x - cropX) * scaleX,
					(p.y - cropY) * scaleY
				);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(
					(p.x - cropX) * scaleX,
					(p.y - cropY) * scaleY
				);
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
			pngPath: string;
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
			for (const entry of sectionEntries) {
				const typeTag = `[${entry.type}]`;
				const context = entry.context
					? `> "${entry.context}" (p. ${entry.annotation.page}) ${typeTag}\n`
					: `> (p. ${entry.annotation.page}) ${typeTag}\n`;
				md += context;
				md += `> ![[${entry.pngPath}]]\n\n`;
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
		const validIds = new Set(annotations.map((a) => a.id));
		const folder = this.app.vault.getAbstractFileByPath(photoDir);
		if (!folder) return;

		const files = this.app.vault.getFiles().filter(
			(f) =>
				f.path.startsWith(photoDir) &&
				f.extension === "png"
		);

		for (const file of files) {
			const match = file.basename.match(/^annotation-([a-f0-9]+)$/);
			if (match && !validIds.has(match[1])) {
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
