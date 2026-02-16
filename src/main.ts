import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, TextComponent, ButtonComponent } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { CPA_GRADER_PROMPT } from './prompts';

// ⚙️ 설정: 'targetNotePath'는 이제 '마지막으로 사용한 파일'을 기억하는 용도입니다.
interface ErrorLogSettings { 
    geminiApiKey: string; 
    lastUsedPath: string; // 🔥 [Change] 고정 경로가 아니라 '마지막 사용 경로'
    modelName: string;
    imageSourcePath: string; 
}

const DEFAULT_SETTINGS: ErrorLogSettings = { 
    geminiApiKey: '', 
    lastUsedPath: 'CPA_Error_Log.md', 
    modelName: 'gemini-2.0-flash',
    imageSourcePath: '' 
}

const DEFAULT_MODELS: Record<string, string> = { 
    'gemini-2.0-flash': 'Gemini 2.0 Flash', 
    'gemini-1.5-flash': 'Gemini 1.5 Flash', 
    'gemini-1.5-pro': 'Gemini 1.5 Pro' 
};

interface ProblemItem { subject: string; question_number: string; answer: string; solution: string; imageFile: TFile; }

export default class ErrorLogPlugin extends Plugin {
    settings: ErrorLogSettings;
    genAI: GoogleGenerativeAI;

	
    // 🚀 배치 처리 (targetPath를 인자로 받음)
    async batchProcessImages(files: TFile[], targetPath: string) {
        if (files.length === 0) return;
        new Notice(`총 ${files.length}개의 파일 분석 시작! 🏃`);

        let allProblems: ProblemItem[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file) continue;
            new Notice(`[${i + 1}/${files.length}] AI 분석 중: ${file.name}`);

            const problems = await this.processFile(file);
            if (problems && problems.length > 0) {
                allProblems.push(...problems);
            }
            if (i < files.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (allProblems.length > 0) {
            new Notice(`분석 완료! ${targetPath}에 기록합니다... 📝`);
            // 🔥 targetPath 전달
            await this.saveToMarkdown(allProblems, targetPath);
            new Notice("🎉 모든 오답노트 작성이 완료되었습니다!");
        } else {
            new Notice("⚠️ 추출된 문제가 없습니다.");
        }
    }

    async processFile(file: TFile): Promise<ProblemItem[] | null> {
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);
            const base64Data = Buffer.from(arrayBuffer).toString('base64');
            const mimeType = file.extension.toLowerCase() === 'pdf' ? 'application/pdf' : 'image/png';

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
                console.error(e);
                return [{ 
                    subject: "Error", 
                    question_number: "Err", 
                    answer: "Check Log", 
                    solution: `JSON 파싱 실패.\n${result.response.text()}`.replace(/\|/g, '/'), 
                    imageFile: file 
                }];
            }

            if (Array.isArray(problems)) {
                return problems.map(p => ({ ...p, imageFile: file }));
            }
            return null;

        } catch (error) {
            console.error(error);
            new Notice(`실패 (${file.name}): ${(error as Error).message}`);
            return null;
        }
    }

    // 💾 마크다운 저장 (동적 경로 적용)
    async saveToMarkdown(items: ProblemItem[], targetPath: string) {
        const { vault } = this.app;
        
        // 경로 안전 장치
        if (!targetPath || targetPath.trim() === "") targetPath = "Untitled_Error_Log.md";
        if (!targetPath.endsWith(".md")) targetPath += ".md";

        let logFile = vault.getAbstractFileByPath(targetPath);
        
        // 파일 생성 (헤더 포함)
        if (!logFile) {
            const header = `---
cssclasses: cpa-log
---

| 과목 | 문제 | 번호 | 정답 | 풀이 |
|:---:|:---|:---:|:---:|:---|
`;
            logFile = await vault.create(targetPath, header);
        }

        if (logFile instanceof TFile) {
            let chunk = "";
            let currentFile: TFile | null = null;

            for (const item of items) {
                const safeSubject = this.sanitizeForTable(item.subject || "기타");
                const safeAnswer = this.sanitizeForTable(item.answer || "");
                const safeSolution = this.sanitizeForTable(item.solution || "");
                const scrollableSolution = `<div class="cpa-solution">${safeSolution}</div>`;

                const showImage = (item.imageFile !== currentFile);
                currentFile = item.imageFile;

                const imageContent = showImage 
                    ? `<div class="cpa-img-container">![[${item.imageFile.name}]]</div>` 
                    : '';

                chunk += `| ${safeSubject} | ${imageContent} | ${item.question_number} | ${safeAnswer} | ${scrollableSolution} |\n`;
            }
            await vault.append(logFile, chunk);
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

	sanitizeForTable(text: string): string {
        if (!text) return "";

        let clean = text;

        // 1. [핵심] 앞뒤에 붙은 백틱(`)이나 코드블록(```) 제거
        // LLM이 "수식 보호"를 위해 습관적으로 감싸는 것을 벗겨냅니다.
        clean = clean.replace(/^```(json|markdown|text)?/i, '').replace(/```$/i, ''); // 멀티라인
        clean = clean.replace(/^`/, '').replace(/`$/, ''); // 인라인

        // 2. 파이프(|) 기호 이스케이프 (테이블 깨짐 방지)
        clean = clean.replace(/\|/g, '&#124;');

        // 3. 줄바꿈 처리
        // (1) 실제 엔터키(\n) -> <br>로 변환
        clean = clean.replace(/(\r\n|\n|\r)/gm, '<br>');
        
        // (2) 텍스트로 렌더링될 수 있는 리터럴 "\n" 문자열 -> <br>로 변환
        clean = clean.replace(/\\n/g, '<br>');

        // 4. [방어] 혹시라도 이스케이프된 태그가 있다면 복구 (&lt;br&gt; -> <br>)
        // 단, 코드 설명을 위해 의도한 것일 수도 있으므로 이 부분은 선택사항이나, 
        // 오답노트 특성상 "줄바꿈 의도"가 99%이므로 강제 변환이 유리합니다.
        clean = clean.replace(/&lt;br&gt;/gi, '<br>').replace(/&lt;br\s*\/&gt;/gi, '<br>');

        return clean.trim();
    }

	
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}

// 📂 [New Modal] 저장할 파일 선택 (Step 1)
class TargetFileModal extends Modal {
    plugin: ErrorLogPlugin;
    onChoose: (path: string) => void;
    inputEl: TextComponent;

    constructor(app: App, plugin: ErrorLogPlugin, onChoose: (path: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Step 1: 오답노트 파일 선택" });
        contentEl.createEl("p", { text: "분석 결과를 저장할 파일을 선택하거나 이름을 입력하세요.", cls: "setting-item-description" });

        // 1. 입력 필드 (기본값: 마지막 사용 파일)
        const inputDiv = contentEl.createDiv();
        inputDiv.style.display = "flex";
        inputDiv.style.gap = "10px";
        inputDiv.style.marginBottom = "20px";

        this.inputEl = new TextComponent(inputDiv)
            .setPlaceholder("Example: 회계_오답노트.md")
            .setValue(this.plugin.settings.lastUsedPath)
            .onChange((value) => { /* 값 변경 감지 */ });
        
        this.inputEl.inputEl.style.width = "100%";
        this.inputEl.inputEl.style.flex = "1";

        new ButtonComponent(inputDiv)
            .setButtonText("Next 👉")
            .setCta()
            .onClick(() => {
                const path = this.inputEl.getValue();
                if (path.trim()) {
                    this.close();
                    this.onChoose(path);
                } else {
                    new Notice("파일 이름을 입력해주세요!");
                }
            });

        // 2. 추천 파일 목록 (cpa-log 클래스가 있거나, 최근 수정된 파일)
        contentEl.createEl("h4", { text: "📂 추천 파일 (클릭하여 선택)" });
        const listContainer = contentEl.createDiv();
        listContainer.style.maxHeight = "200px";
        listContainer.style.overflowY = "auto";
        listContainer.style.border = "1px solid var(--background-modifier-border)";
        listContainer.style.borderRadius = "4px";

        // 기존 파일 중 .md 파일이면서 cpa-log 클래스를 가진 파일(우선) 또는 최근 파일 찾기
        const mdFiles = this.app.vault.getMarkdownFiles();
        
        // 스마트 필터: frontmatter에 'cssclasses: cpa-log'가 있는 파일 우선 정렬
        const recommendedFiles = mdFiles.sort((a, b) => {
            const aCache = this.app.metadataCache.getFileCache(a);
            const bCache = this.app.metadataCache.getFileCache(b);
            const aIsLog = aCache?.frontmatter?.cssclasses?.includes('cpa-log');
            const bIsLog = bCache?.frontmatter?.cssclasses?.includes('cpa-log');
            
            if (aIsLog && !bIsLog) return -1;
            if (!aIsLog && bIsLog) return 1;
            return b.stat.mtime - a.stat.mtime; // 그 외엔 최신순
        }).slice(0, 10); // 상위 10개만

        if (recommendedFiles.length === 0) {
				listContainer.createEl("div", { 
				text: "추천 파일이 없습니다.", 
				attr: { style: "padding: 10px; text-align: center; color: var(--text-muted);" } 
			});
        }

        recommendedFiles.forEach(file => {
            const item = listContainer.createEl("div", { cls: "suggestion-item" });
            item.style.display = "flex";
            item.style.justifyContent = "space-between";
            item.style.padding = "8px 10px";
            item.style.cursor = "pointer";
            item.onmouseover = () => item.style.backgroundColor = "var(--background-secondary)";
            item.onmouseout = () => item.style.backgroundColor = "transparent";

            // 파일명 표시
            const nameSpan = item.createEl("span", { text: file.name });
            nameSpan.style.fontWeight = "bold";

            // 경로 표시
			item.createEl("span", { 
				text: file.parent?.path || "/", 
				attr: { style: "color: var(--text-muted); font-size: 0.8em;" } 
			});
			
            item.onClickEvent(() => {
                this.inputEl.setValue(file.path); // 경로 클릭 시 입력창에 반영
            });
        });
    }

    onClose() { this.contentEl.empty(); }
}

// 📂 [Image Select Modal] 이미지 선택 (Step 2 - 기존 유지)
class MultiSelectModal extends Modal {
    selectedFiles: Set<TFile> = new Set();
    onProcess: (files: TFile[]) => void;
    plugin: ErrorLogPlugin;

    constructor(app: App, plugin: ErrorLogPlugin, onProcess: (files: TFile[]) => void) { 
        super(app); 
        this.plugin = plugin;
        this.onProcess = onProcess; 
    }

    onOpen() {
        const { contentEl } = this; 
        contentEl.createEl("h2", { text: "Step 2: 분석할 이미지 선택" });

        const targetFolder = this.plugin.settings.imageSourcePath ? this.plugin.settings.imageSourcePath.trim() : "";
        if (targetFolder) contentEl.createEl("small", { text: `📂 Source: ${targetFolder}`, cls: "setting-item-description" });
        
        const exts = ['png', 'jpg', 'jpeg', 'gif', 'pdf'];
        const files = this.app.vault.getFiles()
            .filter(f => {
                const isCorrectExt = exts.includes(f.extension.toLowerCase());
                const isInFolder = targetFolder === '' || f.path.startsWith(targetFolder);
                return isCorrectExt && isInFolder;
            })
            .sort((a,b)=>b.stat.mtime-a.stat.mtime).slice(0, 30);

        const div = contentEl.createDiv(); 
        div.style.maxHeight="400px"; 
        div.style.overflowY="auto";
        div.style.marginTop="10px";

		if (files.length === 0) {
			div.createEl("div", { 
				text: "⚠️ 이미지가 없습니다.", 
				attr: { style: "padding: 10px;" } 
			});
		}
		
        files.forEach(f => {
            new Setting(div)
                .setName(f.name)
                .setDesc(new Date(f.stat.mtime).toLocaleDateString())
                .addToggle(t => t.onChange(c => c ? this.selectedFiles.add(f) : this.selectedFiles.delete(f)));
        });

        new Setting(contentEl).addButton(b => b.setButtonText("Start Analysis 🚀").setCta().onClick(() => { this.close(); this.onProcess(Array.from(this.selectedFiles)); }));
    }
    onClose() { this.contentEl.empty(); }
}

// ⚙️ 설정 탭 (파일 경로 설정 제거 -> 마지막 사용 경로로 대체됨을 인지)
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

        new Setting(containerEl)
            .setName('Image Source Folder')
            .setDesc('이미지 검색 대상 폴더 (비워두면 전체)')
            .addText(t => t.setValue(this.plugin.settings.imageSourcePath).onChange(async v => { this.plugin.settings.imageSourcePath = v.replace(/^\/|\/$/g, ''); await this.plugin.saveSettings(); }));

        // 모델 설정 (기존 코드 유지 - 너무 길어서 생략하지만 실제 코드에는 포함되어야 함)
        const modelSetting = new Setting(containerEl).setName('Gemini Model').addDropdown(async d => { /* ... */ });
        modelSetting.addExtraButton(b => { 
            b.setIcon('sync').onClick(async () => { /* 모델 Fetch 로직 */ });
        });

        // 🔥 Target Note Path 설정은 이제 '기본값' 개념이므로 삭제하거나
        // 사용자가 "다음에 켤 때 기본으로 뜰 이름"을 수정하는 용도로 남겨둬도 됩니다.
        new Setting(containerEl)
            .setName('Default Output File')
            .setDesc('실행 시 팝업에 기본으로 입력될 파일명입니다.')
            .addText(t => t.setValue(this.plugin.settings.lastUsedPath).onChange(async v => { this.plugin.settings.lastUsedPath = v; await this.plugin.saveSettings(); }));
    }
}