import { App, Notice, TFile, Modal, SuggestModal, ButtonComponent, Setting } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type ErrorLogPlugin from './main';
import { UniversalFile } from './types';

// macOS 폴더 선택 함수
export function pickFolderMac(): Promise<string | null> {
    return new Promise((resolve) => {
        const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Folder containing images")'`;
        exec(script, (error, stdout, stderr) => {
            if (error) { resolve(null); return; }
            resolve(stdout ? stdout.trim() : null);
        });
    });
}

export class TargetFileSuggestModal extends SuggestModal<TFile | string> {
    plugin: ErrorLogPlugin;
    onChoose: (path: string) => void;

    constructor(app: App, plugin: ErrorLogPlugin, onChoose: (path: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.setPlaceholder("오답노트 파일을 검색하거나, 새 파일명을 입력하세요...");
    }

    getSuggestions(query: string): (TFile | string)[] {
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
        const suggestions: (TFile | string)[] = [...files];
        if (query.trim().length > 0) {
            const exactMatch = files.some(f => f.path === query || f.path === query + ".md");
            if (!exactMatch) suggestions.unshift(query);
        }
        return suggestions;
    }

    renderSuggestion(item: TFile | string, el: HTMLElement) {
        if (typeof item === 'string') {
            el.createEl("div", { text: `➕ 새 파일 생성: "${item}${item.endsWith('.md') ? '' : '.md'}"`, cls: "suggestion-title", attr: {style: "color: var(--interactive-accent); font-weight: bold;"} });
        } else {
            el.createEl("div", { text: item.basename, cls: "suggestion-title" });
            const parentPath = item.parent?.path === '/' ? 'Root' : item.parent?.path;
            if (parentPath && parentPath !== '/') el.createEl("small", { text: parentPath, cls: "suggestion-content", attr: { style: "color: var(--text-muted);" } });
        }
    }

    onChooseSuggestion(item: TFile | string, evt: MouseEvent | KeyboardEvent) {
        let path = "";
        if (typeof item === 'string') { path = item; if (!path.endsWith('.md')) path += '.md'; new Notice(`새 파일 모드: ${path}`); }
        else { path = item.path; }
        this.onChoose(path);
    }
}

export class MultiSelectModal extends Modal {
    selectedFiles: Set<UniversalFile> = new Set();
    onProcess: (files: UniversalFile[]) => void;
    onChangeFolder: (newFolder: string) => void;
    plugin: ErrorLogPlugin;

    constructor(app: App, plugin: ErrorLogPlugin, onProcess: (files: UniversalFile[]) => void, onChangeFolder: (newFolder: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onProcess = onProcess;
        this.onChangeFolder = onChangeFolder;
    }

    async pickFolderNative() {
        const folder = await pickFolderMac();
        if (folder) {
            new Notice(`폴더 변경됨: ${folder}`);
            this.onChangeFolder(folder);
            this.close();
        }
    }

    onOpen() {
        const { contentEl } = this;
        const headerDiv = contentEl.createDiv();
        headerDiv.style.display = "flex"; headerDiv.style.justifyContent = "space-between"; headerDiv.style.alignItems = "center"; headerDiv.style.marginBottom = "15px";
        headerDiv.createEl("h2", { text: "Select Images", attr: { style: "margin: 0;" } });

        const currentFolder = this.plugin.settings.imageSourcePath || "(Root)";
        new ButtonComponent(headerDiv).setButtonText(`📂 폴더 변경`).setTooltip(`현재: ${currentFolder}`).onClick(() => { this.pickFolderNative(); });

        const div = contentEl.createDiv();
        div.style.maxHeight="400px"; div.style.overflowY="auto"; div.style.border = "1px solid var(--background-modifier-border)"; div.style.padding = "10px"; div.style.borderRadius = "5px";

        let files: UniversalFile[] = [];
        const exts = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.webp'];

        if (path.isAbsolute(currentFolder) && fs.existsSync(currentFolder)) {
            try {
                const dirFiles = fs.readdirSync(currentFolder);
                files = dirFiles.filter(name => exts.includes(path.extname(name).toLowerCase())).map(name => {
                    const fullPath = path.join(currentFolder, name);
                    const stat = fs.statSync(fullPath);
                    return { name: name, path: fullPath, mtime: stat.mtimeMs, isExternal: true, extension: path.extname(name).substring(1).toLowerCase() };
                });
            } catch (err) { new Notice(`폴더 읽기 실패: ${err}`); }
        } else {
            const targetFolder = currentFolder === '(Root)' ? '' : currentFolder;
            files = this.app.vault.getFiles().filter(f => {
                const ext = '.' + f.extension.toLowerCase();
                const isInFolder = targetFolder === '' || targetFolder === '/' || f.path.startsWith(targetFolder);
                return exts.includes(ext) && isInFolder;
            }).map(f => ({ name: f.name, path: f.path, mtime: f.stat.mtime, isExternal: false, extension: f.extension, originalObject: f }));
        }

        files.sort((a,b) => b.mtime - a.mtime);
        if (files.length === 0) div.createEl("div", { text: "⚠️ 해당 폴더에 이미지가 없습니다.", attr: { style: "padding: 20px; text-align: center; color: var(--text-muted);" } });

        files.slice(0, 100).forEach(f => {
            new Setting(div).setName(f.name).setDesc(new Date(f.mtime).toLocaleDateString()).addToggle(t => t.onChange(c => c ? this.selectedFiles.add(f) : this.selectedFiles.delete(f)));
        });

        new Setting(contentEl).addButton(b => b.setButtonText("Start Analysis 🚀").setCta().onClick(() => { this.close(); this.onProcess(Array.from(this.selectedFiles)); }));
    }
    onClose() { this.contentEl.empty(); }
}

export class ActionSelectModal extends Modal {
    onImageAnalysis: () => void;
    onTableFix: () => void;

    constructor(app: App, onImageAnalysis: () => void, onTableFix: () => void) {
        super(app);
        this.onImageAnalysis = onImageAnalysis;
        this.onTableFix = onTableFix;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "작업 선택" });

        new Setting(contentEl)
            .setName("이미지 분석")
            .setDesc("이미지/PDF를 선택하여 오답노트를 생성합니다")
            .addButton(b => b.setButtonText("시작").setCta().onClick(() => {
                this.close();
                this.onImageAnalysis();
            }));

        new Setting(contentEl)
            .setName("테이블 수정")
            .setDesc("마크다운 테이블의 깨진 구조를 AI로 수정합니다")
            .addButton(b => b.setButtonText("시작").onClick(() => {
                this.close();
                this.onTableFix();
            }));
    }

    onClose() { this.contentEl.empty(); }
}