import { ItemView, WorkspaceLeaf, TFile, normalizePath } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-ignore - raw text import for worker blob
import pdfjsWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import { AnnotationStore } from "./annotation-store";
import { AnnotationManager } from "./annotation-manager";
import { InteractionMode } from "./stroke-canvas";
import type ManuscriptReviewerPlugin from "./main";

export const VIEW_TYPE = "manuscript-reviewer-pdf";

const workerBlob = new Blob([pdfjsWorkerSrc], { type: "application/javascript" });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

const BUFFER_PAGES = 1;

export class ManuscriptPdfView extends ItemView {
	plugin: ManuscriptReviewerPlugin;
	store: AnnotationStore;
	annotationManager: AnnotationManager;

	private pdf: pdfjsLib.PDFDocumentProxy | null = null;
	private totalPages: number = 0;
	private pageHeight: number = 0;
	private pageWidth: number = 0;
	private scale: number = 1.5;

	private scrollContainer: HTMLDivElement | null = null;
	private pagesContainer: HTMLDivElement | null = null;
	private pageWrappers: Map<
		number,
		{
			wrapper: HTMLDivElement;
			rendered: boolean;
			pdfCanvas: HTMLCanvasElement | null;
			annotationCanvas: HTMLCanvasElement | null;
		}
	> = new Map();

	private toolbar: HTMLDivElement | null = null;
	private deleteBtn: HTMLButtonElement | null = null;

	private scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ManuscriptReviewerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new AnnotationStore(
			this.app,
			plugin.settings.pdfPath
		);
		this.annotationManager = new AnnotationManager(this.store, {
			penColor: plugin.settings.penColor,
			penWidth: plugin.settings.penWidth,
			groupingTimeout: plugin.settings.strokeGroupingTimeout,
		});
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Manuscript Reviewer";
	}

	getIcon(): string {
		return "pen-tool";
	}

	async onOpen(): Promise<void> {
		await this.store.load();

		const container = this.contentEl;
		container.empty();
		container.addClass("manuscript-reviewer-view");

		this.buildToolbar(container);

		// Debug: show pointer type and version
		const debugEl = container.createDiv({
			attr: { style: "padding: 4px 8px; font-size: 12px; background: #333; color: #0f0; font-family: monospace;" },
		});
		debugEl.textContent = "v1.0.7 — touch screen to see pointer type";
		container.addEventListener("pointerdown", (e: PointerEvent) => {
			debugEl.textContent = `v1.0.7 — type: ${e.pointerType}, pressure: ${e.pressure.toFixed(2)}, id: ${e.pointerId}`;
		});

		this.scrollContainer = container.createDiv({
			cls: "manuscript-reviewer-container",
		});

		this.annotationManager.setSelectionCallback((ann) => {
			if (this.deleteBtn) {
				this.deleteBtn.disabled = !ann;
			}
		});

		this.annotationManager.setAnnotationsChangedCallback(() => {
			// annotations auto-save via store
		});

		await this.loadPdf();
	}

	async onClose(): Promise<void> {
		await this.store.save();
		this.pageWrappers.forEach((pw, page) => {
			if (pw.rendered) {
				this.annotationManager.unregisterCanvas(page);
			}
		});
		this.pageWrappers.clear();
		if (this.pdf) {
			this.pdf.destroy();
			this.pdf = null;
		}
	}

	private async loadPdf(): Promise<void> {
		const pdfPath = normalizePath(this.plugin.settings.pdfPath);
		const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);

		if (!(pdfFile instanceof TFile)) {
			this.scrollContainer!.createEl("p", {
				text: `PDF not found: ${pdfPath}. Set the correct path in plugin settings.`,
				attr: { style: "color: white; padding: 20px; font-size: 16px;" },
			});
			return;
		}

		try {
			const buf = await this.app.vault.readBinary(pdfFile);
			const data = new Uint8Array(buf);
			this.pdf = await pdfjsLib.getDocument({
				data,
				useWorkerFetch: false,
				isEvalSupported: false,
				useSystemFonts: true,
			}).promise;
			this.totalPages = this.pdf.numPages;

			// Get dimensions from first page
			const firstPage = await this.pdf.getPage(1);
			const viewport = firstPage.getViewport({ scale: this.scale });
			this.pageWidth = viewport.width;
			this.pageHeight = viewport.height;

			this.setupPages();

			// Restore scroll position
			const savedPage = this.store.getCurrentPage();
			if (savedPage > 0) {
				this.scrollToPage(savedPage);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.scrollContainer!.createEl("p", {
				text: `Failed to load PDF: ${msg}`,
				attr: { style: "color: white; padding: 20px; font-size: 16px;" },
			});
			console.error("Manuscript Reviewer: PDF load error", e);
		}
	}

	private setupPages(): void {
		if (!this.scrollContainer) return;

		this.pagesContainer = this.scrollContainer.createDiv();

		for (let i = 1; i <= this.totalPages; i++) {
			const wrapper = this.pagesContainer.createDiv({
				cls: "manuscript-reviewer-page-wrapper",
			});
			wrapper.style.width = `${this.pageWidth}px`;
			wrapper.style.height = `${this.pageHeight}px`;

			this.pageWrappers.set(i, {
				wrapper,
				rendered: false,
				pdfCanvas: null,
				annotationCanvas: null,
			});
		}

		this.scrollContainer.addEventListener("scroll", () => {
			this.onScroll();
		});

		// Initial render
		this.updateVisiblePages();
	}

	private onScroll(): void {
		this.updateVisiblePages();

		if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
		this.scrollTimeout = setTimeout(() => {
			const currentPage = this.getCurrentVisiblePage();
			if (currentPage > 0) {
				this.store.setCurrentPage(currentPage);
			}
		}, 500);
	}

	private getCurrentVisiblePage(): number {
		if (!this.scrollContainer) return 0;
		const scrollTop = this.scrollContainer.scrollTop;
		const containerHeight = this.scrollContainer.clientHeight;
		const centerY = scrollTop + containerHeight / 2;

		for (const [page, pw] of this.pageWrappers) {
			const top = pw.wrapper.offsetTop;
			const bottom = top + pw.wrapper.offsetHeight;
			if (centerY >= top && centerY <= bottom) {
				return page;
			}
		}
		return 1;
	}

	private updateVisiblePages(): void {
		if (!this.scrollContainer) return;

		const scrollTop = this.scrollContainer.scrollTop;
		const viewHeight = this.scrollContainer.clientHeight;
		const viewBottom = scrollTop + viewHeight;

		const visiblePages = new Set<number>();

		for (const [page, pw] of this.pageWrappers) {
			const top = pw.wrapper.offsetTop;
			const bottom = top + pw.wrapper.offsetHeight;

			if (bottom >= scrollTop && top <= viewBottom) {
				visiblePages.add(page);
			}
		}

		// Add buffer pages
		const buffered = new Set<number>();
		for (const p of visiblePages) {
			for (
				let i = p - BUFFER_PAGES;
				i <= p + BUFFER_PAGES;
				i++
			) {
				if (i >= 1 && i <= this.totalPages) {
					buffered.add(i);
				}
			}
		}

		// Render new pages
		for (const page of buffered) {
			const pw = this.pageWrappers.get(page)!;
			if (!pw.rendered) {
				this.renderPage(page);
			}
		}

		// Dispose off-screen pages
		for (const [page, pw] of this.pageWrappers) {
			if (pw.rendered && !buffered.has(page)) {
				this.disposePage(page);
			}
		}
	}

	private async renderPage(pageNum: number): Promise<void> {
		if (!this.pdf) return;
		const pw = this.pageWrappers.get(pageNum);
		if (!pw || pw.rendered) return;

		pw.rendered = true;

		const page = await this.pdf.getPage(pageNum);
		const viewport = page.getViewport({ scale: this.scale });

		// PDF canvas
		const pdfCanvas = document.createElement("canvas");
		pdfCanvas.className = "manuscript-reviewer-page-canvas";
		pdfCanvas.width = viewport.width;
		pdfCanvas.height = viewport.height;
		pw.wrapper.appendChild(pdfCanvas);
		pw.pdfCanvas = pdfCanvas;

		const ctx = pdfCanvas.getContext("2d")!;
		await page.render({ canvasContext: ctx, viewport }).promise;

		// Annotation canvas
		const annCanvas = document.createElement("canvas");
		annCanvas.className = "manuscript-reviewer-annotation-canvas";
		annCanvas.width = viewport.width;
		annCanvas.height = viewport.height;
		pw.wrapper.appendChild(annCanvas);
		pw.annotationCanvas = annCanvas;

		// Page number label
		const pageLabel = pw.wrapper.createDiv({
			cls: "manuscript-reviewer-page-number",
		});
		pageLabel.textContent = `Page ${pageNum}`;

		this.annotationManager.registerCanvas(
			annCanvas,
			pageNum,
			viewport.width,
			viewport.height
		);
	}

	private disposePage(pageNum: number): void {
		const pw = this.pageWrappers.get(pageNum);
		if (!pw || !pw.rendered) return;

		this.annotationManager.unregisterCanvas(pageNum);

		pw.wrapper.empty();
		pw.pdfCanvas = null;
		pw.annotationCanvas = null;
		pw.rendered = false;
	}

	private scrollToPage(page: number): void {
		if (!this.scrollContainer) return;
		const pw = this.pageWrappers.get(page);
		if (pw) {
			this.scrollContainer.scrollTop = pw.wrapper.offsetTop;
		}
	}

	private buildToolbar(container: HTMLElement): void {
		this.toolbar = container.createDiv({
			cls: "manuscript-reviewer-toolbar",
		});

		// Draw mode button
		const drawBtn = this.toolbar.createEl("button", {
			text: "Draw",
			title: "Draw mode",
		});
		drawBtn.addClass("is-active");

		// Select mode button
		const selectBtn = this.toolbar.createEl("button", {
			text: "Select",
			title: "Select mode",
		});

		const setMode = (mode: InteractionMode) => {
			this.annotationManager.setMode(mode);
			drawBtn.toggleClass("is-active", mode === "draw");
			selectBtn.toggleClass("is-active", mode === "select");
		};

		drawBtn.addEventListener("click", () => setMode("draw"));
		selectBtn.addEventListener("click", () => setMode("select"));

		// Separator
		this.toolbar.createDiv({ cls: "toolbar-separator" });

		// Undo button
		const undoBtn = this.toolbar.createEl("button", {
			text: "Undo",
			title: "Undo last stroke",
		});
		undoBtn.addEventListener("click", () => {
			this.annotationManager.undo();
		});

		// Delete button
		this.deleteBtn = this.toolbar.createEl("button", {
			text: "Delete",
			title: "Delete selected annotation",
		});
		this.deleteBtn.disabled = true;
		this.deleteBtn.addEventListener("click", () => {
			this.annotationManager.deleteSelected();
		});

		// Eraser button
		const eraserBtn = this.toolbar.createEl("button", {
			text: "Eraser",
			title: "Eraser mode",
		});
		let eraserActive = false;
		eraserBtn.addEventListener("click", () => {
			eraserActive = !eraserActive;
			eraserBtn.toggleClass("is-active", eraserActive);
			this.annotationManager.setEraser(eraserActive);
		});

		// Separator
		this.toolbar.createDiv({ cls: "toolbar-separator" });

		// Colors
		const colors = ["#ff0000", "#0000ff", "#000000", "#00aa00", "#ff8800"];
		for (const color of colors) {
			const colorBtn = this.toolbar.createEl("button", {
				cls: "color-swatch",
				title: `Color: ${color}`,
			});
			const inner = colorBtn.createDiv({ cls: "swatch-inner" });
			inner.style.backgroundColor = color;
			if (color === this.plugin.settings.penColor) {
				colorBtn.addClass("is-active");
			}
			colorBtn.addEventListener("click", () => {
				this.toolbar!.querySelectorAll(".color-swatch").forEach(
					(el) => el.removeClass("is-active")
				);
				colorBtn.addClass("is-active");
				this.annotationManager.setPenColor(color);
			});
		}

		// Separator
		this.toolbar.createDiv({ cls: "toolbar-separator" });

		// Width buttons — labeled as Thin/Med/Thick/Bold
		const widths: { value: number; label: string }[] = [
			{ value: 1, label: "S" },
			{ value: 2, label: "M" },
			{ value: 4, label: "L" },
			{ value: 6, label: "XL" },
		];
		for (const w of widths) {
			const widthBtn = this.toolbar.createEl("button", {
				cls: "width-btn",
				text: w.label,
				title: `Pen width: ${w.value}`,
			});
			if (w.value === this.plugin.settings.penWidth) {
				widthBtn.addClass("is-active");
			}
			widthBtn.addEventListener("click", () => {
				this.toolbar!.querySelectorAll(".width-btn").forEach(
					(el) => el.removeClass("is-active")
				);
				widthBtn.addClass("is-active");
				this.annotationManager.setPenWidth(w.value);
			});
		}
	}
}
