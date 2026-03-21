import { App, TFile, normalizePath } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { Annotation, AnnotationStore, Stroke } from "./annotation-store";

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

	async exportChapter(
		chapterId: string,
		configPath: string,
		pdfPath: string,
		exportDir: string
	): Promise<string> {
		const config = await this.loadConfig(configPath);
		const chapter = config.chapters.find((c) => c.id === chapterId);
		if (!chapter) throw new Error(`Chapter not found: ${chapterId}`);

		const annotations = this.store
			.getAnnotations()
			.filter(
				(a) =>
					a.page >= chapter.startPage && a.page <= chapter.endPage
			)
			.sort((a, b) => a.page - b.page || a.boundingBox.y - b.boundingBox.y);

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

			entries.push({
				annotation: ann,
				pngPath: `photos/${chapter.id}/${pngFilename}`,
				context,
				section,
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

		return notesPath;
	}

	async exportSimple(
		pdfPath: string,
		notesPath: string,
		exportDir: string
	): Promise<string> {
		const annotations = this.store
			.getAnnotations()
			.sort((a, b) => a.page - b.page || a.boundingBox.y - b.boundingBox.y);

		if (annotations.length === 0) {
			throw new Error("No annotations to export");
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

			entries.push({
				annotation: ann,
				pngPath: `photos/${pdfName}/${pngFilename}`,
				context,
			});
		}

		// Generate markdown
		let md = `# Annotations: ${pdfName}\n\n`;
		let currentPage = -1;
		for (const entry of entries) {
			if (entry.annotation.page !== currentPage) {
				currentPage = entry.annotation.page;
				md += `## Page ${currentPage}\n\n`;
			}
			const context = entry.context
				? `> "${entry.context}" (p. ${entry.annotation.page})\n`
				: `> (p. ${entry.annotation.page})\n`;
			md += context;
			md += `→ ![[${entry.pngPath}]]\n\n`;
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
		const padding = 0.15; // 15% padding for surrounding text context
		const b = ann.boundingBox;

		// Clamp the crop region to page bounds (0-1 normalized)
		const cropX = Math.max(0, b.x - padding);
		const cropY = Math.max(0, b.y - padding);
		const cropRight = Math.min(1, b.x + b.width + padding);
		const cropBottom = Math.min(1, b.y + b.height + padding);
		const cropW = cropRight - cropX;
		const cropH = cropBottom - cropY;

		const renderWidth = 800;
		const aspectRatio = cropH / cropW;
		const renderHeight = Math.max(50, Math.round(renderWidth * aspectRatio));

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
		) as Array<{ str: string; transform: number[]; width: number }>;

		if (items.length === 0) return "";

		// Convert annotation bbox to page coordinates
		const annTop = bbox.y * pageHeight;
		const annBottom = (bbox.y + bbox.height) * pageHeight;
		const annCenterY = (annTop + annBottom) / 2;
		const annLeft = bbox.x * pageWidth;
		const annRight = (bbox.x + bbox.width) * pageWidth;

		// Score each text item by proximity to annotation bbox
		const scored = items.map((item) => {
			const itemY = pageHeight - item.transform[5]; // convert from-bottom to from-top
			const itemX = item.transform[4];

			// Y distance: 0 if overlapping, otherwise distance to nearest edge
			let yDist = 0;
			if (itemY < annTop) yDist = annTop - itemY;
			else if (itemY > annBottom) yDist = itemY - annBottom;

			// X distance: prefer text on the same horizontal region
			let xDist = 0;
			if (itemX > annRight) xDist = (itemX - annRight) * 0.5; // less weight on X
			else if (itemX + (item.width || 0) < annLeft) xDist = (annLeft - itemX) * 0.5;

			return { item, dist: yDist + xDist, y: itemY };
		});

		scored.sort((a, b) => a.dist - b.dist);

		// Take nearest items, then group by line (similar Y position)
		const nearest = scored.slice(0, 15);
		nearest.sort((a, b) => a.y - b.y);

		// Group into lines (items within 3px Y are same line)
		const lines: string[] = [];
		let currentLine: string[] = [];
		let currentLineY = -999;
		for (const s of nearest) {
			if (Math.abs(s.y - currentLineY) > 3) {
				if (currentLine.length > 0) lines.push(currentLine.join(" "));
				currentLine = [];
				currentLineY = s.y;
			}
			currentLine.push(s.item.str);
		}
		if (currentLine.length > 0) lines.push(currentLine.join(" "));

		const text = lines.join(" ");
		const trimmed =
			text.length > 200 ? text.substring(0, 200) + "..." : text;
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
				const context = entry.context
					? `> "${entry.context}" (p. ${entry.annotation.page})\n`
					: `> (p. ${entry.annotation.page})\n`;
				md += context;
				md += `→ ![[${entry.pngPath}]]\n\n`;
			}
		}

		return md;
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
