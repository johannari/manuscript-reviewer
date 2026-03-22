import { Notice, Platform, Plugin, TFile, FuzzySuggestModal, normalizePath } from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
import {
	ManuscriptReviewerSettings,
	DEFAULT_SETTINGS,
	ManuscriptReviewerSettingTab,
} from "./settings";
import { ManuscriptPdfView, VIEW_TYPE } from "./pdf-view";
import { AnnotationStore } from "./annotation-store";
import { ExportManager } from "./export";

class PdfSuggestModal extends FuzzySuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: any, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a PDF to annotate...");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

export default class ManuscriptReviewerPlugin extends Plugin {
	settings: ManuscriptReviewerSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new ManuscriptPdfView(leaf, this));

		this.addRibbonIcon("pen-tool", "Annotate a PDF", () => {
			this.showPdfPicker();
		});

		this.addCommand({
			id: "annotate-pdf",
			name: "Annotate a PDF",
			callback: () => this.showPdfPicker(),
		});

		// File menu: right-click a PDF → "Annotate with Manuscript Reviewer"
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "pdf") {
					menu.addItem((item) => {
						item
							.setTitle("Annotate with Manuscript Reviewer")
							.setIcon("pen-tool")
							.onClick(() => this.openPdf(file.path));
					});
				}
			})
		);

		this.addCommand({
			id: "export-annotations",
			name: "Export annotations for current PDF",
			checkCallback: (checking) => {
				const view = this.getActivePdfView();
				if (!view) return false;
				if (!checking) this.exportAnnotationsFromView(view);
				return true;
			},
		});

		this.addSettingTab(new ManuscriptReviewerSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private showPdfPicker(): void {
		const pdfFiles = this.app.vault.getFiles().filter(
			(f) => f.extension === "pdf"
		);

		if (pdfFiles.length === 0) {
			new Notice("No PDF files found in your vault");
			return;
		}

		if (pdfFiles.length === 1) {
			this.openPdf(pdfFiles[0].path);
			return;
		}

		new PdfSuggestModal(this.app, pdfFiles, (file) => {
			this.openPdf(file.path);
		}).open();
	}

	async openPdf(pdfPath: string): Promise<void> {
		// Check if already open
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		for (const leaf of existing) {
			const view = leaf.view as unknown as ManuscriptPdfView;
			if (view.getPdfPath() === pdfPath) {
				this.app.workspace.revealLeaf(leaf);
				return;
			}
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE,
			active: true,
			state: { file: pdfPath },
		});
		this.app.workspace.revealLeaf(leaf);
	}

	private getActivePdfView(): ManuscriptPdfView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length === 0) return null;

		// Prefer the active leaf if it's one of ours
		const activeLeaf = this.app.workspace.activeLeaf;
		if (activeLeaf && leaves.includes(activeLeaf)) {
			return activeLeaf.view as unknown as ManuscriptPdfView;
		}
		return leaves[0].view as unknown as ManuscriptPdfView;
	}

	async exportAnnotationsFromView(view: ManuscriptPdfView): Promise<void> {
		const pdfPath = view.getPdfPath();
		if (!pdfPath) {
			new Notice("No PDF is open");
			return;
		}

		const store = new AnnotationStore(this.app, pdfPath);
		await store.load();

		const annotations = store.getAnnotations();
		if (annotations.length === 0) {
			new Notice("No annotations to export");
			return;
		}

		const exportMgr = new ExportManager(this.app, store);
		try {
			const exportDir = normalizePath(this.settings.exportDir);
			const pdfName = pdfPath.replace(/\.pdf$/i, "").split("/").pop() || "annotations";
			const notesPath = normalizePath(`${exportDir}/${pdfName}.md`);

			// Generate simple export without chapter config
			const path = await exportMgr.exportSimple(
				pdfPath,
				notesPath,
				exportDir
			);
			new Notice(`Exported annotations to ${path}`);
			await this.runPostExportSync();
		} catch (e) {
			new Notice(`Export failed: ${(e as Error).message}`);
		}
	}

	private async runPostExportSync(): Promise<void> {
		if (!this.settings.postExportEnabled || !Platform.isDesktop) {
			return;
		}

		let cwd = this.settings.postExportCwd;
		if (cwd.startsWith("~")) {
			cwd = cwd.replace("~", process.env.HOME || "");
		}

		if (!cwd) {
			new Notice("Post-export sync: no repo path configured");
			return;
		}

		const command = this.settings.postExportCommand;
		new Notice("Syncing annotations to repo...");

		try {
			const execAsync = promisify(exec);
			await execAsync(command, { cwd, timeout: 30000 });
			new Notice("Annotations synced and pushed to repo");
		} catch (e: any) {
			const stderr = e.stderr || "";
			if (stderr.includes("nothing to commit")) {
				new Notice("No new annotations to sync");
			} else {
				const msg = (e.message || String(e)).slice(0, 200);
				new Notice(`Post-export sync failed: ${msg}`);
			}
		}
	}
}
