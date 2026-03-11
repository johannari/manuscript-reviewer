import { Notice, Plugin } from "obsidian";
import {
	ManuscriptReviewerSettings,
	DEFAULT_SETTINGS,
	ManuscriptReviewerSettingTab,
} from "./settings";
import { ManuscriptPdfView, VIEW_TYPE } from "./pdf-view";
import { AnnotationStore } from "./annotation-store";
import { ExportManager } from "./export";

export default class ManuscriptReviewerPlugin extends Plugin {
	settings: ManuscriptReviewerSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new ManuscriptPdfView(leaf, this));

		this.addRibbonIcon("pen-tool", "Open Manuscript Reviewer", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-manuscript-reviewer",
			name: "Open manuscript PDF",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "export-chapter-notes",
			name: "Export chapter notes",
			callback: () => this.exportChapter(),
		});

		this.addCommand({
			id: "export-all-chapters",
			name: "Export all chapters",
			callback: () => this.exportAllChapters(),
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

	private async activateView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}

	private async exportChapter(): Promise<void> {
		const store = new AnnotationStore(
			this.app,
			this.settings.pdfPath
		);
		await store.load();

		const exportMgr = new ExportManager(this.app, store);

		try {
			const config = await exportMgr.loadConfig(
				this.settings.configPath
			);
			const chapters = config.chapters;

			if (chapters.length === 0) {
				new Notice("No chapters configured");
				return;
			}

			// Find chapter based on current page from active view
			let targetChapter = chapters[0];
			const leaves =
				this.app.workspace.getLeavesOfType(VIEW_TYPE);
			if (leaves.length > 0) {
				const view = leaves[0].view as ManuscriptPdfView;
				const currentPage = view.store.getCurrentPage();
				for (const ch of chapters) {
					if (
						currentPage >= ch.startPage &&
						currentPage <= ch.endPage
					) {
						targetChapter = ch;
						break;
					}
				}
			}

			const path = await exportMgr.exportChapter(
				targetChapter.id,
				this.settings.configPath,
				this.settings.pdfPath,
				this.settings.exportDir
			);
			new Notice(
				`Exported ${targetChapter.label} to ${path}`
			);
		} catch (e) {
			new Notice(`Export failed: ${(e as Error).message}`);
		}
	}

	private async exportAllChapters(): Promise<void> {
		const store = new AnnotationStore(
			this.app,
			this.settings.pdfPath
		);
		await store.load();

		const exportMgr = new ExportManager(this.app, store);

		try {
			const paths = await exportMgr.exportAllChapters(
				this.settings.configPath,
				this.settings.pdfPath,
				this.settings.exportDir
			);
			new Notice(
				`Exported ${paths.length} chapter(s)`
			);
		} catch (e) {
			new Notice(`Export failed: ${(e as Error).message}`);
		}
	}
}
