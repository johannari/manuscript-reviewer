import { App, PluginSettingTab, Setting } from "obsidian";
import type ManuscriptReviewerPlugin from "./main";

export interface ManuscriptReviewerSettings {
	exportDir: string;
	penColor: string;
	penWidth: number;
	strokeGroupingTimeout: number;
	postExportEnabled: boolean;
	postExportCwd: string;
	postExportCommand: string;
}

export const DEFAULT_SETTINGS: ManuscriptReviewerSettings = {
	exportDir: "manuscript-reviewer-notes/",
	penColor: "#ff0000",
	penWidth: 2,
	strokeGroupingTimeout: 1500,
	postExportEnabled: false,
	postExportCwd: "",
	postExportCommand: "make commit-annotations",
};

export class ManuscriptReviewerSettingTab extends PluginSettingTab {
	plugin: ManuscriptReviewerPlugin;

	constructor(app: App, plugin: ManuscriptReviewerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "To annotate a PDF, right-click it in the file explorer and choose \"Annotate with Manuscript Reviewer\", or use the command palette.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Export directory")
			.setDesc("Directory for exported notes and images")
			.addText((text) =>
				text
					.setPlaceholder("manuscript-reviewer-notes/")
					.setValue(this.plugin.settings.exportDir)
					.onChange(async (value) => {
						this.plugin.settings.exportDir = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default pen color")
			.setDesc("Default color for new annotations")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.penColor)
					.onChange(async (value) => {
						this.plugin.settings.penColor = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default pen width")
			.setDesc("Default stroke width (1-10)")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.penWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.penWidth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Stroke grouping timeout")
			.setDesc(
				"Milliseconds to wait before starting a new annotation (500-5000)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(500, 5000, 100)
					.setValue(this.plugin.settings.strokeGroupingTimeout)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.strokeGroupingTimeout = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Post-export sync" });

		new Setting(containerEl)
			.setName("Enable post-export sync")
			.setDesc(
				"Automatically run a shell command after exporting annotations"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.postExportEnabled)
					.onChange(async (value) => {
						this.plugin.settings.postExportEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Git repo path")
			.setDesc("Absolute path to the git repository")
			.addText((text) =>
				text
					.setPlaceholder(
						"~/code/non-engineering-engineering-leadership"
					)
					.setValue(this.plugin.settings.postExportCwd)
					.onChange(async (value) => {
						this.plugin.settings.postExportCwd = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Shell command")
			.setDesc("Command to run after export")
			.addText((text) =>
				text
					.setPlaceholder("make commit-annotations")
					.setValue(this.plugin.settings.postExportCommand)
					.onChange(async (value) => {
						this.plugin.settings.postExportCommand = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
