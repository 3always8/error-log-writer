import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, SuggestModal, ButtonComponent } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { CPA_GRADER_PROMPT } from './prompts';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// ⚙️ 설정 인터페이스
interface ErrorLogSettings {
    geminiApiKey: string;
    lastUsedPath: string;
    modelName: string;
    imageSourcePath: string;
    attachmentsPath: string; // 🔥 [New] 첨부파일 저장 경로
}

const DEFAULT_SETTINGS: ErrorLogSettings = {
    geminiApiKey: '',
    lastUsedPath: 'CPA_Error_Log.md',
    modelName: 'gemini-2.0-flash',
    imageSourcePath: '',
    attachmentsPath: 'CPA_Attachments' // 🔥 기본값: CPA_Attachments 폴더
}

const DEFAULT_MODELS: Record<string, string> = {
    'gemini-2.0-flash': 'Gemini 2.0 Flash',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    'gemini-1.5-pro': 'Gemini 1.5 Pro'
};

// ... (인터페이스 기존 동일) ...
interface UniversalFile { name: string; path: string; mtime: number; isExternal: boolean; extension: string; originalObject?: TFile; }
interface ProblemItem { subject: string; answer: string; solution: string; imagePath: string; isExternal: boolean; }

// macOS 폴더 선택 함수
function pickFolderMac(): Promise<string | null> {
    return new Promise((resolve) => {
        const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Folder containing images")'`;
        exec(script, (error, stdout, stderr) => {
            if (error) { resolve(null); return; }
            resolve(stdout ? stdout.trim() : null);
        });
    });
}

export default class ErrorLogPlugin extends Plugin {
    settings: ErrorLogSettings;
    genAI: GoogleGenerativeAI;

	async onload() {
        await this.loadSettings();
        if (this.settings.geminiApiKey) {
            this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
        }

        // 리본 아이콘 (기존 유지)
        this.addRibbonIcon('brain-circuit', 'Create Error Log', (evt: MouseEvent) => {
            if (!this.settings.geminiApiKey) { new Notice('⚠️ API Key Required'); return; }
            new TargetFileSuggestModal(this.app, this, (selectedPath) => {
                this.settings.lastUsedPath = selectedPath;
                this.saveSettings();
                this.openImageSelector(selectedPath);
            }).open();
        });

        // 🔥 [완전 해결] 에디터 동작을 방해하지 않는 정밀한 이벤트 제어
        this.registerDomEvent(document, 'mouseover', (evt: MouseEvent) => {
            const target = evt.target as HTMLElement;

            // 1. 이미지가 아닌 곳에 마우스가 있으면 아무것도 하지 않음 (에디터에 전권 위임)
            if (!target.classList.contains('cpa-clickable-img')) return;

            // 2. Alt 키가 눌려있을 때만 확대 실행
            if (evt.altKey) {
                const src = (target as HTMLImageElement).src;
                const existingOverlay = document.getElementById('cpa-floating-overlay');

                if (existingOverlay && (existingOverlay as HTMLImageElement).src === src) return;
                if (existingOverlay) existingOverlay.remove();

                const overlayImg = document.createElement('img');
                overlayImg.src = src;
                overlayImg.id = 'cpa-floating-overlay';
                overlayImg.className = 'cpa-floating-expanded';

                overlayImg.onclick = (e) => {
                    overlayImg.remove();
                    e.stopPropagation();
                };

                document.body.appendChild(overlayImg);

                // 이미지 위에서의 이벤트만 차단하여 에디터 포커스 튐 방지
                evt.stopImmediatePropagation();
            }
        });

        // ESC 키 닫기 (기존 유지)
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Escape') {
                const overlay = document.getElementById('cpa-floating-overlay');
                if (overlay) overlay.remove();
            }
        });

        this.addSettingTab(new ErrorLogSettingTab(this.app, this));
    }
	// 🔥 [필수] 플러그인 꺼질 때 리스너 제거 (안 하면 메모리 누수 & 중복 실행됨)
    onunload() {
        window.removeEventListener('click', this.handleImageClick, true);
    }

    // 🖱️ Mousedown 핸들러 (편집 모드 진입 방지)
    handleImageMousedown(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        if (target.tagName === 'IMG' && target.classList.contains('cpa-clickable-img')) {
            // "편집기야, 여기 클릭한 거 무시해!"
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
        }
    }

    // 🖱️ Click 핸들러 (확대/축소 로직)
    handleImageClick(evt: MouseEvent) {
        const target = evt.target as HTMLElement;

        // 1. 이미지 클릭 시
        if (target.tagName === 'IMG' && target.classList.contains('cpa-clickable-img')) {
            // 확대/축소 토글
            if (target.classList.contains('cpa-expanded')) {
                target.classList.remove('cpa-expanded');
            } else {
                // 다른 열려있는 이미지 닫기
                document.querySelectorAll('.cpa-clickable-img.cpa-expanded').forEach(img => {
                    img.classList.remove('cpa-expanded');
                });
                target.classList.add('cpa-expanded');
            }

            // 이벤트 전파 중단 (부모 요소가 클릭 감지 못하게)
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
        }
        // 2. 배경(이미지 밖) 클릭 시 닫기 (이미지 클릭은 위에서 멈췄으므로 여기 안 옴)
        else {
            // (주의: 여기서 stopPropagation 하면 안 됨. 다른 UI 클릭이 먹통 됨)
            const expandedImgs = document.querySelectorAll('.cpa-clickable-img.cpa-expanded');
            if (expandedImgs.length > 0) {
                expandedImgs.forEach(img => img.classList.remove('cpa-expanded'));
            }
        }
    }

    openImageSelector(targetPath: string) {
        new MultiSelectModal(this.app, this,
            (files) => this.batchProcessImages(files, targetPath),
            (newFolder) => {
                this.settings.imageSourcePath = newFolder;
                this.saveSettings();
                this.openImageSelector(targetPath);
            }
        ).open();
    }

    async batchProcessImages(files: UniversalFile[], targetPath: string) {
        if (files.length === 0) return;
        new Notice(`총 ${files.length}개의 파일 분석 시작! 🏃`);
        let allProblems: ProblemItem[] = [];

        for (const [i, file] of files.entries()) {
            if (!file) continue;
            new Notice(`[${i + 1}/${files.length}] AI 분석 중: ${file.name}`);
            const problems = await this.processFile(file);
            if (problems && problems.length > 0) allProblems.push(...problems);
            if (i < files.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
        }

		if (allProblems.length > 0) {
            new Notice(`분석 완료! 저장 중... 📝`);
            await this.saveToMarkdown(allProblems, targetPath);
            new Notice("🎉 모든 오답노트 작성이 완료되었습니다!");

            // 🔥 [추가됨] 파일 자동 열기/포커스 기능
            const file = this.app.vault.getAbstractFileByPath(targetPath);
            if (file instanceof TFile) {
                // 1. 현재 열려있는 모든 마크다운 탭 조회
                const leaves = this.app.workspace.getLeavesOfType('markdown');

                // 2. 해당 파일을 보고 있는 탭이 있는지 찾기
                const existingLeaf = leaves.find(leaf => {
                    const view = leaf.view as any; // 타입 단언으로 file 접근
                    return view.file && view.file.path === file.path;
                });

                if (existingLeaf) {
                    // A. 이미 열려있다면 -> 그 탭을 활성화(Focus)
                    this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                } else {
                    // B. 안 열려있다면 -> 새 탭('tab')을 만들어서 열기
                    await this.app.workspace.getLeaf('tab').openFile(file);
                }
            }
        } else {
            new Notice("⚠️ 추출된 문제가 없습니다.");
        }
	}

	async processFile(file: UniversalFile): Promise<ProblemItem[] | null> {
        try {
            let base64Data = "";
            if (file.isExternal) {
                const bitmap = fs.readFileSync(file.path);
                base64Data = Buffer.from(bitmap).toString('base64');
            } else if (file.originalObject) {
                const arrayBuffer = await this.app.vault.readBinary(file.originalObject);
                base64Data = Buffer.from(arrayBuffer).toString('base64');
            }

            const mimeType = file.extension === 'pdf' ? 'application/pdf' : 'image/png';
            const modelName = this.settings?.modelName || "gemini-2.0-flash";
            const model = this.genAI.getGenerativeModel({ model: modelName });

            const result = await model.generateContent([
                CPA_GRADER_PROMPT,
                { inlineData: { data: base64Data, mimeType: mimeType } }
            ]);

            let problems: any[] = [];
            try {
                problems = this.parseRoughJson(result.response.text());
            } catch (e) {
                // 🔥 [수정] 파싱 실패 시 에러 로그만 찍고 null 반환 (목록에서 제외됨)
                console.error(`JSON 파싱 실패 (${file.name}):`, e);
                new Notice(`⚠️ 분석 실패 (형식 오류): ${file.name}`);
                return null;
            }

            if (Array.isArray(problems)) {
                return problems.map(p => ({ ...p, imagePath: file.path, isExternal: file.isExternal }));
            }
            return null;

        } catch (error) {
            // API 호출 자체 실패 시
            console.error(`API 호출 실패 (${file.name}):`, error);
            new Notice(`❌ API 오류: ${file.name}`);
            return null;
        }
    }

	// 💾 마크다운 저장 (🔥 이미지 깨짐 완벽 해결 버전)
    async saveToMarkdown(items: ProblemItem[], targetPath: string) {
        const { vault } = this.app;
        if (!targetPath || targetPath.trim() === "") targetPath = "CPA_Error_Log.md";
        if (!targetPath.endsWith(".md")) targetPath += ".md";

        const fileExists = await vault.adapter.exists(targetPath);

        // 1. 첨부파일 폴더 준비
        let assetsFolder = this.settings.attachmentsPath;
        if (!assetsFolder || assetsFolder.trim() === "") assetsFolder = "CPA_Attachments";

        if (!(await vault.adapter.exists(assetsFolder))) {
            await vault.createFolder(assetsFolder);
        }

        let chunk = "";
        let currentPath: string | null = null;

        for (const item of items) {
            const safeSubject = this.sanitizeForTable(item.subject || "기타");
            const safeAnswer = this.sanitizeForTable(item.answer || "");
            const safeSolution = this.sanitizeForTable(item.solution || "");
            const scrollableSolution = `<div class="cpa-solution cpa-text">${safeSolution}</div>`;

            const showImage = (item.imagePath !== currentPath);
            currentPath = item.imagePath;
            let createdFile: TFile | null = null;

            let imgTag = "";
            if (showImage) {
                let resourcePath = "";

                try {
                    // 🔥 [핵심] 외부 파일이든 내부 파일이든, 안전하게 '첨부 폴더'로 복사 후 사용
                    // (원본이 삭제되거나 이동되어도 오답노트는 유지되도록 함)

                    // A. 원본 데이터 읽기
                    let data: Buffer;
                    if (item.isExternal) {
                        data = fs.readFileSync(item.imagePath);
                    } else {
                        // 내부 파일인 경우
                        const fileObj = vault.getAbstractFileByPath(item.imagePath);
                        if (fileObj instanceof TFile) {
                            const arrBuf = await vault.readBinary(fileObj);
                            data = Buffer.from(arrBuf);
                        } else {
                            throw new Error("내부 파일을 찾을 수 없음");
                        }
                    }

                    // B. 안전한 파일명 생성 (특수문자 제거 + 타임스탬프)
                    const originalName = path.basename(item.imagePath);
                    const safeName = originalName.replace(/[^a-zA-Z0-9가-힣.]/g, '_'); // 한글/영문/숫자 외엔 _로 변경
                    const newFileName = `${Date.now()}_${safeName}`;
                    const newInternalPath = `${assetsFolder}/${newFileName}`;

                    // C. Vault 내부에 파일 생성 (createBinary 사용)
                    createdFile = await vault.createBinary(newInternalPath, data);

                    // D. 🔥 [중요] 생성된 TFile 객체로부터 직접 Resource Path 추출
                    // 이 방식이 가장 확실하게 이미지를 띄워줍니다.
                    resourcePath = vault.getResourcePath(createdFile);
					if (item.isExternal) {
                        try {
                            // fs.unlinkSync: 파일을 영구 삭제하는 Node.js 명령어
                            fs.unlinkSync(item.imagePath);
                            console.log(`원본 삭제 완료: ${item.imagePath}`);
                        } catch (delErr) {
                            console.error(`원본 삭제 실패 (권한 또는 잠금 문제): ${item.imagePath}`, delErr);
                            new Notice(`⚠️ 이미지는 저장됐지만 원본 삭제 실패: ${originalName}`);
                        }
                    }
                    // 디버깅용 (혹시 또 안 나오면 Console 확인)
                    console.log(`이미지 저장 성공: ${newInternalPath} -> ${resourcePath}`);

                } catch (e) {
                    console.error("이미지 처리 실패:", e);
                    // 실패 시 엑박 대신 에러 메시지 표시
                    resourcePath = "";
                    imgTag = `❌ 이미지 로드 실패`;
                }
				if (resourcePath && createdFile) {
                    const vaultRoot = this.app.vault.getRoot().path;
                    const relativePath = path.relative(vaultRoot, createdFile.path);
                    imgTag = `<div class="cpa-img-container"><img src="${relativePath}" class="cpa-clickable-img"></div>`;
                } else {
                    imgTag = `❌ 이미지 로드 실패`;
                }
            }

            chunk += `| ${safeSubject} | ${imgTag} | ${safeAnswer} | ${scrollableSolution} |  |\n`;
        }

        if (!fileExists) {
            const header = `---
cssclasses: cpa-log
---

| 과목 | 문제 | 정답 | 풀이 | 비고 |
|:---:|:---|:---|:---|:---|
`;
            await vault.create(targetPath, header + chunk);
            new Notice(`새 파일 생성됨: ${targetPath}`);
        } else {
            const file = vault.getAbstractFileByPath(targetPath);
            if (file instanceof TFile) {
                await vault.process(file, (data) => {
                    return data + chunk;
                });
                new Notice(`내용 추가됨: ${targetPath}`);
            }
        }
    }

    parseRoughJson(text: string): any[] {
        let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const start = clean.indexOf('[');
        const end = clean.lastIndexOf(']');
        if (start === -1 || end === -1) { throw new Error("JSON Array brackets not found"); }
        clean = clean.substring(start, end + 1);
        clean = clean.replace(/,(\s*\])/g, '$1');
        try { return JSON.parse(clean); }
        catch (e) { clean = clean.replace(/,\s*}/g, '}'); return JSON.parse(clean); }
    }

	// 🧹 데이터 정제 함수 (MathJax 납치 방지 버전)
    sanitizeForTable(text: string): string {
        if (!text) return "";
        let clean = text;
        clean = clean.replace(/^```(json|markdown|text)?/i, '').replace(/```$/i, '');
        clean = clean.replace(/^`/, '').replace(/`$/, '');
        clean = clean.replace(/\|/g, '&#124;');
        clean = clean.replace(/\$([0-9,.]+)\$/g, '&#36;$1');
        clean = clean.replace(/\$/g, '&#36;');
        clean = clean.replace(/(\r\n|\n|\r)/gm, '<br>').replace(/\\n/g, '<br>');
        return clean.trim();
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}

// 📝 [파일 선택 모달] (기존 동일)
class TargetFileSuggestModal extends SuggestModal<TFile | string> {
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
            const cache = this.app.metadataCache.getFileCache(item);
            if (cache?.frontmatter?.cssclasses?.includes('cpa-log')) el.createEl("span", { text: " 🏷️ Log File", attr: { style: "color: var(--text-accent); font-size: 0.8em; margin-left: 5px;" } });
        }
    }

    onChooseSuggestion(item: TFile | string, evt: MouseEvent | KeyboardEvent) {
        let path = "";
        if (typeof item === 'string') { path = item; if (!path.endsWith('.md')) path += '.md'; new Notice(`새 파일 모드: ${path}`); }
        else { path = item.path; }
        this.onChoose(path);
    }
}

// 🖼️ [이미지 선택 모달] (기존 동일)
class MultiSelectModal extends Modal {
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

// ⚙️ 설정 탭 (🔥 첨부파일 경로 설정 추가)
class ErrorLogSettingTab extends PluginSettingTab {
    plugin: ErrorLogPlugin;
    constructor(app: App, plugin: ErrorLogPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Google AI Studio API Key')
            .addText(t => t.setValue(this.plugin.settings.geminiApiKey).onChange(async v => { this.plugin.settings.geminiApiKey = v; await this.plugin.saveSettings(); }));

        // 🔥 [New] 첨부파일 저장 경로 설정
        new Setting(containerEl)
            .setName('Attachment Folder')
            .setDesc('이미지를 복사해둘 Vault 내 폴더명입니다. (예: CPA_Attachments)')
            .addText(t => t
                .setPlaceholder('CPA_Attachments')
                .setValue(this.plugin.settings.attachmentsPath)
                .onChange(async v => {
                    this.plugin.settings.attachmentsPath = v;
                    await this.plugin.saveSettings();
                }));

        // 이미지 소스 폴더
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

        // 모델 설정
        const modelSetting = new Setting(containerEl).setName('Gemini Model').addDropdown(async d => {
            const current = this.plugin.settings.modelName;
            let opts: Record<string, string> = { ...DEFAULT_MODELS };
            if (current && !opts[current]) opts[current] = `${current} (Current)`;
            d.addOptions(opts).setValue(current).onChange(async v => { this.plugin.settings.modelName = v; await this.plugin.saveSettings(); });
        });
        modelSetting.addExtraButton((btn) => {
            btn.setIcon('sync').onClick(async () => { /* (Fetch logic 생략 - 위와 동일) */
                 if (!this.plugin.settings.geminiApiKey) { new Notice('⚠️ API Key Required'); return; }
                 new Notice('Fetching models... ⏳');
                 try {
                     const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.plugin.settings.geminiApiKey}`);
                     if (!response.ok) throw new Error(response.statusText);
                     const data = await response.json();
                     const validModels = data.models.filter((m: any) => m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent'));
                     const dropdownEl = modelSetting.controlEl.querySelector('select') as HTMLSelectElement;
                     if (dropdownEl && validModels.length > 0) {
                         dropdownEl.innerHTML = '';
                         validModels.forEach((m: any) => {
                             const id = m.name.replace('models/', '');
                             const option = document.createElement('option');
                             option.value = id;
                             option.text = `${m.displayName} (${m.version || 'latest'})`;
                             dropdownEl.add(option);
                         });
                         dropdownEl.value = this.plugin.settings.modelName;
                         new Notice(`✅ ${validModels.length} Models Loaded`);
                     }
                 } catch (e) { console.error(e); new Notice('Failed to fetch models'); }
            });
        });
    }
}