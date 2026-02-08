import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Modal } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
// 🔥 [New] 프롬프트 파일 import
import { CPA_GRADER_PROMPT } from './prompts';

// ... (인터페이스 및 설정 상수들은 기존 유지) ...
interface ErrorLogSettings { geminiApiKey: string; targetNotePath: string; modelName: string; }
const DEFAULT_SETTINGS: ErrorLogSettings = { geminiApiKey: '', targetNotePath: 'CPA_Error_Log.md', modelName: 'gemini-2.0-flash' }
const DEFAULT_MODELS: Record<string, string> = { 'gemini-2.0-flash': 'Gemini 2.0 Flash', 'gemini-1.5-flash': 'Gemini 1.5 Flash', 'gemini-1.5-pro': 'Gemini 1.5 Pro' };
interface ProblemItem { subject: string; question_number: string; answer: string; solution: string; imageFile: TFile; }

export default class ErrorLogPlugin extends Plugin {
	settings: ErrorLogSettings;
	genAI: GoogleGenerativeAI;

	async onload() {
		await this.loadSettings();
		if (this.settings.geminiApiKey) {
			this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
		}
		this.addRibbonIcon('brain-circuit', 'Create Error Log', (evt: MouseEvent) => {
			if (!this.settings.geminiApiKey) { new Notice('⚠️ API Key Required'); return; }
			new MultiSelectModal(this.app, (files) => this.batchProcessImages(files)).open();
		});
		this.addSettingTab(new ErrorLogSettingTab(this.app, this));
	}

	async batchProcessImages(files: TFile[]) {
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
            new Notice(`분석 완료! 파일에 기록합니다... 📝`);
            await this.saveToMarkdown(allProblems);
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
			
            // 🔥 [Change] 지저분한 문자열 대신 변수 하나만 쏙!
			const result = await model.generateContent([
				CPA_GRADER_PROMPT,
				{ inlineData: { data: base64Data, mimeType: mimeType } }
			]);
			
			let problems: any[] = [];
			try {
				problems = this.parseRoughJson(result.response.text());
			} catch (e) {
				console.error(e);
                return [{ subject: "Error", question_number: "Err", answer: "Check Log", solution: result.response.text().replace(/\|/g, '/'), imageFile: file }];
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

    // ... (saveToMarkdown, sanitizeForTable, appendToLogFile 등 하단 로직은 기존과 동일하므로 생략하지 않고 그대로 유지하세요)
    // 편의를 위해 saveToMarkdown만 다시 적어드립니다. 나머지는 그대로 두셔도 됩니다.
	async saveToMarkdown(items: ProblemItem[]) {
		const { vault } = this.app;
		const targetPath = this.settings.targetNotePath;
		let logFile = vault.getAbstractFileByPath(targetPath);
		
		if (!logFile) {
			const header = `---
cssclasses: cpa-log
---

# 📝 CPA Error Log

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
                const scrollableSolution = `<div style="max-height: 300px; overflow-y: auto;">${safeSolution}</div>`;

                const showImage = (item.imageFile !== currentFile);
                currentFile = item.imageFile;

                const imageContent = showImage 
                    ? `<div style="min-height: 100px; display: flex; align-items: center; justify-content: center;">![[${item.imageFile.name}]]</div>` 
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
		if (start !== -1 && end !== -1) clean = clean.substring(start, end + 1);
		clean = clean.replace(/,(\s*\])/g, '$1'); 
		return JSON.parse(clean);
	}

	sanitizeForTable(text: string): string {
		if (!text) return "";
		return text.replace(/(\r\n|\n|\r)/gm, '<br>').replace(/\|/g, '&#124;').replace(/\t/g, ' '); 
	}
    
	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}

// --- MultiSelectModal & ErrorLogSettingTab (기존 유지) ---
class MultiSelectModal extends Modal {
	selectedFiles: Set<TFile> = new Set();
	onProcess: (files: TFile[]) => void;
	constructor(app: App, onProcess: (files: TFile[]) => void) { super(app); this.onProcess = onProcess; }
	onOpen() {
		const { contentEl } = this; contentEl.createEl("h2", { text: "Select Files" });
		const exts = ['png', 'jpg', 'jpeg', 'gif', 'pdf'];
		const files = this.app.vault.getFiles().filter(f => exts.includes(f.extension.toLowerCase())).sort((a,b)=>b.stat.mtime-a.stat.mtime).slice(0,30);
		const div = contentEl.createDiv(); div.style.maxHeight="400px"; div.style.overflowY="auto";
		files.forEach(f => {
			new Setting(div).setName(f.name).setDesc(new Date(f.stat.mtime).toLocaleDateString()).addToggle(t => t.onChange(c => c ? this.selectedFiles.add(f) : this.selectedFiles.delete(f)));
		});
		new Setting(contentEl).addButton(b => b.setButtonText("Start 🚀").setCta().onClick(() => { this.close(); this.onProcess(Array.from(this.selectedFiles)); }));
	}
	onClose() { this.contentEl.empty(); }
}

// ... (상단 import 및 ErrorLogPlugin 클래스는 기존 그대로 유지) ...

// 🔥 [복구 완료] 모델 동기화 로직이 포함된 설정 탭
class ErrorLogSettingTab extends PluginSettingTab {
	plugin: ErrorLogPlugin;
	constructor(app: App, plugin: ErrorLogPlugin) { super(app, plugin); this.plugin = plugin; }

	display(): void {
		const {containerEl} = this; 
		containerEl.empty();

		new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Google AI Studio에서 발급받은 키를 입력하세요.')
			.addText(t => t
				.setPlaceholder('Enter your API Key')
				.setValue(this.plugin.settings.geminiApiKey)
				.onChange(async v => { 
					this.plugin.settings.geminiApiKey = v; 
					await this.plugin.saveSettings(); 
				}));
		
		const modelSetting = new Setting(containerEl)
			.setName('Gemini Model')
			.setDesc('사용할 모델을 선택하세요. (🔄 버튼을 누르면 최신 모델 목록을 가져옵니다)')
			.addDropdown(async (d) => {
				// 1. 기본값 세팅 (설정 파일에 저장된 값 or 기본값)
				const current = this.plugin.settings.modelName;
				
				// 기본 옵션들을 먼저 채움 (혹시 API 호출 실패할 경우 대비)
				let opts: Record<string, string> = { ...DEFAULT_MODELS };
				
				// 만약 현재 설정된 모델이 기본 목록에 없으면(예: 신규 모델) 추가해서 보여줌
				if (current && !opts[current]) {
					opts[current] = `${current} (Current)`;
				}
				
				d.addOptions(opts)
				 .setValue(current)
				 .onChange(async v => { 
					 this.plugin.settings.modelName = v; 
					 await this.plugin.saveSettings(); 
				 });
			});

		// 🔥 [Rollback] 모델 목록 가져오기 버튼 기능 복구
		modelSetting.addExtraButton((btn) => {
			btn.setIcon('sync')
			   .setTooltip('Fetch available models from Google')
			   .onClick(async () => {
				   if (!this.plugin.settings.geminiApiKey) { 
					   new Notice('⚠️ API Key가 필요합니다.'); 
					   return; 
				   }

				   new Notice('Fetching models... ⏳');
				   
				   try {
					   // 1. Gemini API에 모델 목록 요청
					   const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.plugin.settings.geminiApiKey}`);
					   
					   if (!response.ok) {
						   throw new Error(`API Error: ${response.statusText}`);
					   }
					   
					   const data = await response.json();
					   
					   // 2. 모델 필터링: "generateContent" 기능이 있는 모델만 + "gemini" 이름 포함
					   // (embedding 모델이나 구형 모델 제외)
					   const validModels = data.models.filter((m: any) => 
						   m.name.includes('gemini') && 
						   m.supportedGenerationMethods && 
						   m.supportedGenerationMethods.includes('generateContent')
					   );
					   
					   if (validModels.length === 0) {
						   new Notice('사용 가능한 Gemini 모델을 찾을 수 없습니다.');
						   return;
					   }

					   // 3. 드롭다운 갱신
					   const dropdownEl = modelSetting.controlEl.querySelector('select') as HTMLSelectElement;
					   if (dropdownEl) {
						   dropdownEl.innerHTML = ''; // 기존 목록 초기화
						   
						   // 받아온 모델들 추가
						   validModels.forEach((m: any) => {
							   // 이름이 'models/gemini-1.5-flash' 형태이므로 앞부분 제거
							   const id = m.name.replace('models/', '');
							   const option = document.createElement('option');
							   option.value = id;
							   option.text = `${m.displayName} (${m.version || 'latest'})`;
							   dropdownEl.add(option);
						   });
						   
						   // 현재 선택된 값이 목록에 있으면 유지, 없으면 첫 번째 모델 선택
						   const current = this.plugin.settings.modelName;
						   let exists = false;
						   for(let i=0; i<dropdownEl.options.length; i++) { 
							   if(dropdownEl.options.item(i)?.value === current) exists = true; 
						   }
						   
						   // 만약 목록에 내 설정값이 없다면(커스텀 모델 등), 강제로 추가해서 선택 유지
						   if (!exists) { 
							   const opt = document.createElement('option'); 
							   opt.value = current; 
							   opt.text = `${current} (Keep Current)`; 
							   dropdownEl.add(opt); 
						   }
						   
						   dropdownEl.value = current;
					   }
					   
					   new Notice(`✅ ${validModels.length}개의 모델을 불러왔습니다!`);

				   } catch (error) {
					   console.error(error);
					   new Notice(`모델 목록 불러오기 실패: ${(error as Error).message}`);
				   }
			   });
		});

		new Setting(containerEl)
			.setName('Target Note File')
			.setDesc('오답노트가 저장될 파일명입니다.')
			.addText(t => t
				.setValue(this.plugin.settings.targetNotePath)
				.onChange(async v => { 
					this.plugin.settings.targetNotePath = v; 
					await this.plugin.saveSettings(); 
				}));
	}
}