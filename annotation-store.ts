import { App, TFile, normalizePath } from "obsidian";

export interface StrokePoint {
	x: number;
	y: number;
	pressure: number;
}

export interface Stroke {
	points: StrokePoint[];
	color: string;
	width: number;
}

export interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Annotation {
	id: string;
	page: number;
	strokes: Stroke[];
	boundingBox: BoundingBox;
	createdAt: string;
	modifiedAt: string;
}

export interface SidecarData {
	currentPage: number;
	annotations: Annotation[];
}

export function generateId(): string {
	const chars = "0123456789abcdef";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

export function computeBoundingBox(strokes: Stroke[]): BoundingBox {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const stroke of strokes) {
		for (const p of stroke.points) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
	}
	if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boxesOverlapOrNear(
	a: BoundingBox,
	b: BoundingBox,
	threshold: number
): boolean {
	const ax1 = a.x - threshold,
		ay1 = a.y - threshold;
	const ax2 = a.x + a.width + threshold,
		ay2 = a.y + a.height + threshold;
	const bx1 = b.x,
		by1 = b.y;
	const bx2 = b.x + b.width,
		by2 = b.y + b.height;
	return ax1 <= bx2 && ax2 >= bx1 && ay1 <= by2 && ay2 >= by1;
}

export class AnnotationStore {
	private app: App;
	private sidecarPath: string;
	private data: SidecarData;
	private saveTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, pdfPath: string) {
		this.app = app;
		this.sidecarPath = pdfPath.replace(/\.pdf$/i, ".reviewer.json");
		this.data = { currentPage: 0, annotations: [] };
	}

	async load(): Promise<void> {
		const path = normalizePath(this.sidecarPath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			try {
				this.data = JSON.parse(content);
				if (!this.data.annotations) this.data.annotations = [];
				if (this.data.currentPage == null) this.data.currentPage = 0;
			} catch {
				this.data = { currentPage: 0, annotations: [] };
			}
		}
	}

	getAnnotations(): Annotation[] {
		return this.data.annotations;
	}

	getAnnotationsForPage(page: number): Annotation[] {
		return this.data.annotations.filter((a) => a.page === page);
	}

	addAnnotation(annotation: Annotation): void {
		this.data.annotations.push(annotation);
		this.debouncedSave();
	}

	updateAnnotation(id: string, updates: Partial<Annotation>): void {
		const idx = this.data.annotations.findIndex((a) => a.id === id);
		if (idx >= 0) {
			Object.assign(this.data.annotations[idx], updates);
			this.debouncedSave();
		}
	}

	deleteAnnotation(id: string): void {
		this.data.annotations = this.data.annotations.filter(
			(a) => a.id !== id
		);
		this.debouncedSave();
	}

	removeLastStroke(annotationId: string): Stroke | null {
		const ann = this.data.annotations.find((a) => a.id === annotationId);
		if (!ann || ann.strokes.length === 0) return null;
		const removed = ann.strokes.pop()!;
		if (ann.strokes.length === 0) {
			this.deleteAnnotation(annotationId);
		} else {
			ann.boundingBox = computeBoundingBox(ann.strokes);
			ann.modifiedAt = new Date().toISOString();
		}
		this.debouncedSave();
		return removed;
	}

	getCurrentPage(): number {
		return this.data.currentPage;
	}

	setCurrentPage(page: number): void {
		this.data.currentPage = page;
		this.debouncedSave();
	}

	private debouncedSave(): void {
		if (this.saveTimeout) clearTimeout(this.saveTimeout);
		this.saveTimeout = setTimeout(() => this.save(), 500);
	}

	async save(): Promise<void> {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}
		const path = normalizePath(this.sidecarPath);
		const content = JSON.stringify(this.data, null, 2);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}
}
