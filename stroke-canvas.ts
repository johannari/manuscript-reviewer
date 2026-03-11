import {
	Annotation,
	Stroke,
	StrokePoint,
	BoundingBox,
	computeBoundingBox,
	boxesOverlapOrNear,
	generateId,
	AnnotationStore,
} from "./annotation-store";

export type InteractionMode = "draw" | "select";

export interface StrokeCanvasCallbacks {
	onAnnotationCreated: (annotation: Annotation) => void;
	onAnnotationUpdated: (annotation: Annotation) => void;
	onSelectionChanged: (annotation: Annotation | null) => void;
	onStrokeUndone: () => void;
}

export class StrokeCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private page: number;
	private pageWidth: number;
	private pageHeight: number;

	private mode: InteractionMode = "draw";
	private penColor: string = "#ff0000";
	private penWidth: number = 2;
	private isEraser: boolean = false;

	private isDrawing: boolean = false;
	private currentPoints: StrokePoint[] = [];

	private pendingAnnotation: Annotation | null = null;
	private groupingTimer: ReturnType<typeof setTimeout> | null = null;
	private groupingTimeout: number = 1500;
	private groupingThreshold: number = 0.1;

	private selectedAnnotation: Annotation | null = null;
	private store: AnnotationStore;
	private callbacks: StrokeCanvasCallbacks;

	private undoStack: { annotationId: string; stroke: Stroke }[] = [];

	constructor(
		canvas: HTMLCanvasElement,
		page: number,
		pageWidth: number,
		pageHeight: number,
		store: AnnotationStore,
		callbacks: StrokeCanvasCallbacks,
		settings: {
			penColor: string;
			penWidth: number;
			groupingTimeout: number;
		}
	) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d")!;
		this.page = page;
		this.pageWidth = pageWidth;
		this.pageHeight = pageHeight;
		this.store = store;
		this.callbacks = callbacks;
		this.penColor = settings.penColor;
		this.penWidth = settings.penWidth;
		this.groupingTimeout = settings.groupingTimeout;

		this.setupEvents();
	}

	setMode(mode: InteractionMode): void {
		this.mode = mode;
		if (mode === "draw") {
			this.selectedAnnotation = null;
			this.callbacks.onSelectionChanged(null);
		}
		this.canvas.style.cursor =
			mode === "draw" ? "crosshair" : "pointer";
	}

	setPenColor(color: string): void {
		this.penColor = color;
	}

	setPenWidth(width: number): void {
		this.penWidth = width;
	}

	setEraser(active: boolean): void {
		this.isEraser = active;
	}

	getSelectedAnnotation(): Annotation | null {
		return this.selectedAnnotation;
	}

	undo(): void {
		if (this.undoStack.length === 0) return;
		const last = this.undoStack.pop()!;
		this.store.removeLastStroke(last.annotationId);
		this.callbacks.onStrokeUndone();
		this.redraw();
	}

	redraw(): void {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		const annotations = this.store.getAnnotationsForPage(this.page);
		for (const ann of annotations) {
			this.drawAnnotation(ann);
		}
		if (this.mode === "select") {
			this.drawSelectionHighlights(annotations);
		}
	}

	destroy(): void {
		if (this.groupingTimer) clearTimeout(this.groupingTimer);
		this.canvas.removeEventListener(
			"pointerdown",
			this.handlePointerDown
		);
		this.canvas.removeEventListener(
			"pointermove",
			this.handlePointerMove
		);
		this.canvas.removeEventListener("pointerup", this.handlePointerUp);
		this.canvas.removeEventListener(
			"pointercancel",
			this.handlePointerUp
		);
	}

	private setupEvents(): void {
		this.canvas.addEventListener("pointerdown", this.handlePointerDown);
		this.canvas.addEventListener("pointermove", this.handlePointerMove);
		this.canvas.addEventListener("pointerup", this.handlePointerUp);
		this.canvas.addEventListener("pointercancel", this.handlePointerUp);
	}

	private handlePointerDown = (e: PointerEvent): void => {
		// Only handle pen (Apple Pencil) and mouse (desktop fallback)
		// Touch (finger) passes through for scrolling
		if (e.pointerType === "touch") return;

		e.preventDefault();
		e.stopPropagation();
		// Capture this pointer so subsequent move/up events come to this canvas
		// and the browser doesn't scroll for this pointer
		this.canvas.setPointerCapture(e.pointerId);

		if (this.mode === "select") {
			this.handleSelectTap(e);
			return;
		}

		if (this.isEraser) {
			this.handleEraserTap(e);
			return;
		}

		this.isDrawing = true;
		this.currentPoints = [];
		const point = this.getNormalizedPoint(e);
		this.currentPoints.push(point);

		this.ctx.beginPath();
		this.ctx.strokeStyle = this.penColor;
		this.ctx.lineWidth =
			this.penWidth * (this.canvas.width / this.pageWidth);
		this.ctx.lineCap = "round";
		this.ctx.lineJoin = "round";
		this.ctx.moveTo(
			point.x * this.canvas.width,
			point.y * this.canvas.height
		);
	};

	private handlePointerMove = (e: PointerEvent): void => {
		if (!this.isDrawing || e.pointerType === "touch") return;

		e.preventDefault();
		e.stopPropagation();

		const point = this.getNormalizedPoint(e);
		this.currentPoints.push(point);

		const pressure = Math.max(0.1, point.pressure);
		this.ctx.lineWidth =
			this.penWidth *
			pressure *
			2 *
			(this.canvas.width / this.pageWidth);
		this.ctx.lineTo(
			point.x * this.canvas.width,
			point.y * this.canvas.height
		);
		this.ctx.stroke();
		this.ctx.beginPath();
		this.ctx.moveTo(
			point.x * this.canvas.width,
			point.y * this.canvas.height
		);
	};

	private handlePointerUp = (e: PointerEvent): void => {
		if (e.pointerType === "touch") return;
		if (this.canvas.hasPointerCapture(e.pointerId)) {
			this.canvas.releasePointerCapture(e.pointerId);
		}
		if (!this.isDrawing) return;
		this.isDrawing = false;

		if (this.currentPoints.length < 2) return;

		const stroke: Stroke = {
			points: this.currentPoints,
			color: this.penColor,
			width: this.penWidth,
		};

		this.addStrokeToAnnotation(stroke);
		this.currentPoints = [];
	};

	private addStrokeToAnnotation(stroke: Stroke): void {
		if (this.groupingTimer) clearTimeout(this.groupingTimer);

		const strokeBox = computeBoundingBox([stroke]);

		if (
			this.pendingAnnotation &&
			boxesOverlapOrNear(
				this.pendingAnnotation.boundingBox,
				strokeBox,
				this.groupingThreshold
			)
		) {
			this.pendingAnnotation.strokes.push(stroke);
			this.pendingAnnotation.boundingBox = computeBoundingBox(
				this.pendingAnnotation.strokes
			);
			this.pendingAnnotation.modifiedAt = new Date().toISOString();
			this.store.updateAnnotation(this.pendingAnnotation.id, {
				strokes: this.pendingAnnotation.strokes,
				boundingBox: this.pendingAnnotation.boundingBox,
				modifiedAt: this.pendingAnnotation.modifiedAt,
			});
			this.undoStack.push({
				annotationId: this.pendingAnnotation.id,
				stroke,
			});
			this.callbacks.onAnnotationUpdated(this.pendingAnnotation);
		} else {
			this.finalizePending();

			const now = new Date().toISOString();
			const annotation: Annotation = {
				id: generateId(),
				page: this.page,
				strokes: [stroke],
				boundingBox: strokeBox,
				createdAt: now,
				modifiedAt: now,
			};
			this.store.addAnnotation(annotation);
			this.pendingAnnotation = annotation;
			this.undoStack.push({
				annotationId: annotation.id,
				stroke,
			});
			this.callbacks.onAnnotationCreated(annotation);
		}

		this.groupingTimer = setTimeout(() => {
			this.finalizePending();
		}, this.groupingTimeout);
	}

	private finalizePending(): void {
		this.pendingAnnotation = null;
	}

	private handleSelectTap(e: PointerEvent): void {
		const point = this.getNormalizedPoint(e);
		const annotations = this.store.getAnnotationsForPage(this.page);

		let found: Annotation | null = null;
		for (const ann of annotations) {
			const b = ann.boundingBox;
			const pad = 0.02;
			if (
				point.x >= b.x - pad &&
				point.x <= b.x + b.width + pad &&
				point.y >= b.y - pad &&
				point.y <= b.y + b.height + pad
			) {
				found = ann;
			}
		}

		this.selectedAnnotation = found;
		this.callbacks.onSelectionChanged(found);
		this.redraw();
	}

	private handleEraserTap(e: PointerEvent): void {
		const point = this.getNormalizedPoint(e);
		const annotations = this.store.getAnnotationsForPage(this.page);

		for (const ann of annotations) {
			const b = ann.boundingBox;
			const pad = 0.02;
			if (
				point.x >= b.x - pad &&
				point.x <= b.x + b.width + pad &&
				point.y >= b.y - pad &&
				point.y <= b.y + b.height + pad
			) {
				this.store.deleteAnnotation(ann.id);
				this.redraw();
				return;
			}
		}
	}

	private drawAnnotation(ann: Annotation): void {
		for (const stroke of ann.strokes) {
			if (stroke.points.length < 2) continue;
			this.ctx.beginPath();
			this.ctx.strokeStyle = stroke.color;
			this.ctx.lineCap = "round";
			this.ctx.lineJoin = "round";

			const first = stroke.points[0];
			this.ctx.moveTo(
				first.x * this.canvas.width,
				first.y * this.canvas.height
			);

			for (let i = 1; i < stroke.points.length; i++) {
				const p = stroke.points[i];
				const pressure = Math.max(0.1, p.pressure);
				this.ctx.lineWidth =
					stroke.width *
					pressure *
					2 *
					(this.canvas.width / this.pageWidth);
				this.ctx.lineTo(
					p.x * this.canvas.width,
					p.y * this.canvas.height
				);
				this.ctx.stroke();
				this.ctx.beginPath();
				this.ctx.moveTo(
					p.x * this.canvas.width,
					p.y * this.canvas.height
				);
			}
		}
	}

	private drawSelectionHighlights(annotations: Annotation[]): void {
		for (const ann of annotations) {
			const b = ann.boundingBox;
			const isSelected = ann.id === this.selectedAnnotation?.id;
			this.ctx.strokeStyle = isSelected
				? "rgba(100, 149, 237, 0.9)"
				: "rgba(100, 149, 237, 0.4)";
			this.ctx.lineWidth = isSelected ? 3 : 1;
			this.ctx.setLineDash([6, 3]);
			if (isSelected) {
				this.ctx.fillStyle = "rgba(100, 149, 237, 0.1)";
				this.ctx.fillRect(
					b.x * this.canvas.width - 4,
					b.y * this.canvas.height - 4,
					b.width * this.canvas.width + 8,
					b.height * this.canvas.height + 8
				);
			}
			this.ctx.strokeRect(
				b.x * this.canvas.width - 4,
				b.y * this.canvas.height - 4,
				b.width * this.canvas.width + 8,
				b.height * this.canvas.height + 8
			);
			this.ctx.setLineDash([]);
		}
	}

	private getNormalizedPoint(e: PointerEvent): StrokePoint {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left) / rect.width,
			y: (e.clientY - rect.top) / rect.height,
			pressure: e.pressure || 0.5,
		};
	}
}
