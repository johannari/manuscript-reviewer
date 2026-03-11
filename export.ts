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
			await this.renderAnnotationPng(ann, pngPath);

			const page = await pdf.getPage(ann.page);
			const context = await this.extractNearestText(
				page,
				ann.boundingBox.y + ann.boundingBox.height / 2
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
		outputPath: string
	): Promise<void> {
		const padding = 0.02;
		const b = ann.boundingBox;

		const renderWidth = 800;
		const aspectRatio = (b.height + padding * 2) / (b.width + padding * 2);
		const renderHeight = Math.max(
			50,
			Math.round(renderWidth * aspectRatio)
		);

		const canvas = document.createElement("canvas");
		canvas.width = renderWidth;
		canvas.height = renderHeight;
		const ctx = canvas.getContext("2d")!;

		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, renderWidth, renderHeight);

		const scaleX = renderWidth / (b.width + padding * 2);
		const scaleY = renderHeight / (b.height + padding * 2);
		const offsetX = b.x - padding;
		const offsetY = b.y - padding;

		for (const stroke of ann.strokes) {
			if (stroke.points.length < 2) continue;
			ctx.strokeStyle = stroke.color;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";

			const first = stroke.points[0];
			ctx.beginPath();
			ctx.moveTo(
				(first.x - offsetX) * scaleX,
				(first.y - offsetY) * scaleY
			);

			for (let i = 1; i < stroke.points.length; i++) {
				const p = stroke.points[i];
				const pressure = Math.max(0.1, p.pressure);
				ctx.lineWidth = stroke.width * pressure * 2;
				ctx.lineTo(
					(p.x - offsetX) * scaleX,
					(p.y - offsetY) * scaleY
				);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(
					(p.x - offsetX) * scaleX,
					(p.y - offsetY) * scaleY
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
		normalizedY: number
	): Promise<string> {
		const textContent = await page.getTextContent();
		const viewport = page.getViewport({ scale: 1 });
		const pageHeight = viewport.height;

		const targetY = normalizedY * pageHeight;

		type TextItemWithTransform = {
			str: string;
			transform: number[];
		};

		const items = textContent.items.filter(
			(item): item is TextItemWithTransform =>
				"str" in item && item.str.trim().length > 0
		);

		if (items.length === 0) return "";

		// pdf.js transform[5] is the Y position (from bottom), convert to from-top
		items.sort((a, b) => {
			const aY = pageHeight - a.transform[5];
			const bY = pageHeight - b.transform[5];
			return (
				Math.abs(aY - targetY) - Math.abs(bY - targetY)
			);
		});

		// Grab nearest text items to form a passage
		const nearest = items.slice(0, 5);
		nearest.sort((a, b) => {
			const aY = pageHeight - a.transform[5];
			const bY = pageHeight - b.transform[5];
			return aY - bY;
		});

		const text = nearest.map((item) => item.str).join(" ");
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
