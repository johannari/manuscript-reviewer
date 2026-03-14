import { Annotation, AnnotationStore } from "./annotation-store";
import { StrokeCanvas, InteractionMode, StrokeCanvasCallbacks } from "./stroke-canvas";

export class AnnotationManager {
	private store: AnnotationStore;
	private canvases: Map<number, StrokeCanvas> = new Map();
	private mode: InteractionMode = "draw";
	private penColor: string;
	private penWidth: number;
	private isEraser: boolean = false;
	private groupingTimeout: number;

	private selectedAnnotation: Annotation | null = null;
	private onSelectionChanged: ((ann: Annotation | null) => void) | null =
		null;
	private onAnnotationsChanged: (() => void) | null = null;

	constructor(
		store: AnnotationStore,
		settings: {
			penColor: string;
			penWidth: number;
			groupingTimeout: number;
		}
	) {
		this.store = store;
		this.penColor = settings.penColor;
		this.penWidth = settings.penWidth;
		this.groupingTimeout = settings.groupingTimeout;
	}

	setSelectionCallback(cb: (ann: Annotation | null) => void): void {
		this.onSelectionChanged = cb;
	}

	setAnnotationsChangedCallback(cb: () => void): void {
		this.onAnnotationsChanged = cb;
	}

	registerCanvas(
		canvas: HTMLCanvasElement,
		page: number,
		pageWidth: number,
		pageHeight: number
	): StrokeCanvas {
		const callbacks: StrokeCanvasCallbacks = {
			onAnnotationCreated: () => {
				this.onAnnotationsChanged?.();
			},
			onAnnotationUpdated: () => {
				this.onAnnotationsChanged?.();
			},
			onSelectionChanged: (ann) => {
				this.selectedAnnotation = ann;
				this.onSelectionChanged?.(ann);
			},
			onStrokeUndone: () => {
				this.onAnnotationsChanged?.();
			},
		};

		const sc = new StrokeCanvas(canvas, page, pageWidth, pageHeight, this.store, callbacks, {
			penColor: this.penColor,
			penWidth: this.penWidth,
			groupingTimeout: this.groupingTimeout,
		});

		sc.setMode(this.mode);
		sc.setEraser(this.isEraser);
		this.canvases.set(page, sc);
		sc.redraw();
		return sc;
	}

	unregisterCanvas(page: number): void {
		const sc = this.canvases.get(page);
		if (sc) {
			sc.destroy();
			this.canvases.delete(page);
		}
	}

	setMode(mode: InteractionMode): void {
		this.mode = mode;
		for (const sc of this.canvases.values()) {
			sc.setMode(mode);
		}
	}

	setPenColor(color: string): void {
		this.penColor = color;
		for (const sc of this.canvases.values()) {
			sc.setPenColor(color);
		}
	}

	setPenWidth(width: number): void {
		this.penWidth = width;
		for (const sc of this.canvases.values()) {
			sc.setPenWidth(width);
		}
	}

	setEraser(active: boolean): void {
		this.isEraser = active;
		for (const sc of this.canvases.values()) {
			sc.setEraser(active);
		}
	}

	deleteSelected(): void {
		if (!this.selectedAnnotation) return;
		this.store.deleteAnnotation(this.selectedAnnotation.id);
		const page = this.selectedAnnotation.page;
		this.selectedAnnotation = null;
		this.onSelectionChanged?.(null);
		const sc = this.canvases.get(page);
		if (sc) sc.redraw();
		this.onAnnotationsChanged?.();
	}

	undo(): void {
		for (const sc of this.canvases.values()) {
			sc.undo();
		}
	}

	redrawPage(page: number): void {
		const sc = this.canvases.get(page);
		if (sc) sc.redraw();
	}

	getSelectedAnnotation(): Annotation | null {
		return this.selectedAnnotation;
	}

	routePenDown(page: number, e: PointerEvent): void {
		const sc = this.canvases.get(page);
		if (sc) sc.onPenDown(e);
	}

	routePenMove(page: number, e: PointerEvent): void {
		const sc = this.canvases.get(page);
		if (sc) sc.onPenMove(e);
	}

	routePenUp(page: number, e: PointerEvent): void {
		const sc = this.canvases.get(page);
		if (sc) sc.onPenUp(e);
	}
}
