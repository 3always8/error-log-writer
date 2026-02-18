import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ErrorLogPlugin from './main';
import { DEFAULT_MODELS } from './types';
import { pickFolderMac } from './modals';

export class ErrorLogSettingTab extends PluginSettingTab {
    plugin: ErrorLogPlugin;
    constructor(app: App, plugin: ErrorLogPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Google AI Studio API Key')
            .addText(t => t.setValue(this.plugin.settings.geminiApiKey).onChange(async v => { this.plugin.settings.geminiApiKey = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Attachment Folder')
            .setDesc('이미지를 복사해둘 Vault 내 폴더명입니다. (예: CPA_Attachments)')
            .addText(t => t
                .setPlaceholder('CPA_Attachments')
                .setValue(this.plugin.settings.attachmentsPath)
                .onChange(async v => { this.plugin.settings.attachmentsPath = v; await this.plugin.saveSettings(); }));

        const folderSetting = new Setting(containerEl)
            .setName('Default Input Folder')
            .setDesc('입력 이미지를 불러올 기본 폴더입니다.')
            .addText(t => t.setValue(this.plugin.settings.imageSourcePath).setDisabled(true));

        folderSetting.addButton(btn => {
            btn.setButtonText("📂 폴더 선택 (macOS)")
               .onClick(async () => {
                   const folder = await pickFolderMac();
                   if (folder) { this.plugin.settings.imageSourcePath = folder; await this.plugin.saveSettings(); this.display(); }
               });
        });

        const modelSetting = new Setting(containerEl).setName('Gemini Model').addDropdown(async d => {
            const current = this.plugin.settings.modelName;
            let opts: Record<string, string> = { ...DEFAULT_MODELS };
            if (current && !opts[current]) opts[current] = `${current} (Current)`;
            d.addOptions(opts).setValue(current).onChange(async v => { this.plugin.settings.modelName = v; await this.plugin.saveSettings(); });
        });
    }
}

