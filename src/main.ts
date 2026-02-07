import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Modal } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";

interface ErrorLogSettings {
	geminiApiKey: string;
	targetNotePath: string;
	modelName: string;
}

const DEFAULT_SETTINGS: ErrorLogSettings = {
	geminiApiKey: '',
	targetNotePath: 'CPA_Error_Log.md',
	modelName: 'gemini-2.0-flash'
}

const DEFAULT_MODELS: Record<string, string> = {
	'gemini-2.0-flash': 'Gemini 2.0 Flash (Recommended)',
	'gemini-1.5-flash': 'Gemini 1.5 Flash',
	'gemini-1.5-pro': 'Gemini 1.5 Pro',
	'gemini-1.5-flash-8b': 'Gemini 1.5 Flash-8b (Cheapest)'
};

interface ProblemItem {
	question_number: string;
	answer: string;
	solution: string;
}

export default class ErrorLogPlugin extends Plugin {
	settings: ErrorLogSettings;
	genAI: GoogleGenerativeAI;

	async onload() {
		await this.loadSettings();
		
		if (this.settings.geminiApiKey) {
			this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
		}

		this.addRibbonIcon('brain-circuit', 'Create Error Log', (evt: MouseEvent) => {
			if (!this.settings.geminiApiKey) {
				new Notice('⚠️ 설정에서 Gemini API Key를 먼저 입력해주세요.');
				return;
			}
			new MultiSelectModal(this.app, (files) => this.batchProcessImages(files)).open();
		});

		this.addSettingTab(new ErrorLogSettingTab(this.app, this));
	}

	async batchProcessImages(files: TFile[]) {
		if (files.length === 0) return;

		new Notice(`총 ${files.length}개의 파일 분석 시작! 🏃`);

		for (let i = 0; i < files.length; i++) {
			// [Fix 2] file.name 오류 해결: 변수 할당 후 존재 여부 체크 (Type Guard)
			const file = files[i];
			if (!file) continue;

			new Notice(`[${i + 1}/${files.length}] 처리 중: ${file.name}`);
			
			await this.processFile(file);

			if (i < files.length - 1) {
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		new Notice("🎉 모든 오답노트 작성이 완료되었습니다!");
	}

	async processFile(file: TFile) {
		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			const base64Data = Buffer.from(arrayBuffer).toString('base64');
			const mimeType = file.extension.toLowerCase() === 'pdf' ? 'application/pdf' : 'image/png';
			
			const modelName = this.settings?.modelName || "gemini-2.0-flash"; 
			const model = this.genAI.getGenerativeModel({ model: modelName });
			
			const prompt = `
			이 파일에는 하나 이상의 CPA 시험 문제가 포함되어 있어.
			모든 문제를 식별해서 각각 풀이해줘.

			[출력 포맷 - 중요]
			반드시 **JSON Array** 형식으로만 출력해.
			
			JSON 스키마:
			[
			  {
				"question_number": "문제 번호 (예: Q1, 문제2)",
				"answer": "핵심 정답 (굵게)",
				"solution": "상세 풀이 (줄바꿈은 <br> 태그 사용, 수식은 LaTeX $...$ 사용)"
			  }
			]

			[제약사항]
			1. 표 깨짐 방지를 위해 '|' (파이프) 기호 절대 사용 금지.
			2. 문제는 이미지 내에 보이는 순서대로 추출.
			`;

			const result = await model.generateContent([
				prompt,
				{ inlineData: { data: base64Data, mimeType: mimeType } }
			]);
			
			let responseText = result.response.text().trim();
			responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

			let problems: ProblemItem[] = [];
			try {
				problems = JSON.parse(responseText);
			} catch (e) {
				console.error("JSON Parse Error", responseText);
				problems = [{
					question_number: "Whole",
					answer: "Format Error",
					solution: responseText.replace(/\|/g, '/')
				}];
			}

			if (Array.isArray(problems)) {
				for (let i = 0; i < problems.length; i++) {
					// [Fix 3] problems[i] 오류 해결: 변수 할당 후 체크
					const problem = problems[i];
					if (!problem) continue;

					const showImage = (i === 0);
					await this.appendToLogFile(file, problem, showImage);
				}
				new Notice(`✅ ${file.name}: ${problems.length}문제 작성 완료`);
			}

		} catch (error) {
			console.error(`❌ Error (${file.name}):`, error);
			new Notice(`실패 (${file.name}): ${(error as Error).message}`);
		}
	}

	async appendToLogFile(file: TFile, problem: ProblemItem, showImage: boolean) {
		const { vault } = this.app;
		const targetPath = this.settings.targetNotePath;
		
		let logFile = vault.getAbstractFileByPath(targetPath);
		if (!logFile) {
			logFile = await vault.create(targetPath, 
				`# 📝 CPA Error Log\n\n| 날짜 | 문제(원본) | 번호 | 정답 | 풀이 |\n|:---:|:---:|:---:|:---:|:---|\n`
			);
		}

		if (logFile instanceof TFile) {
			const today = new Date().toISOString().slice(2, 10).replace(/-/g, '/');
			
			const safeAnswer = (problem.answer || "").replace(/\|/g, '/');
			const safeSolution = (problem.solution || "").replace(/\|/g, '/');
			
			const imageLink = showImage ? `![[${file.name}\\|300]]` : '';
			const dateStr = showImage ? today : '"'; 

			const newRow = `| ${dateStr} | ${imageLink} | ${problem.question_number} | ${safeAnswer} | ${safeSolution} |\n`;
			await vault.append(logFile, newRow);
		}
	}
    
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.geminiApiKey) {
			this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
		}
	}
}

class ErrorLogSettingTab extends PluginSettingTab {
	plugin: ErrorLogPlugin;

	constructor(app: App, plugin: ErrorLogPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Error Log Writer Settings'});

		new Setting(containerEl)
			.setName('Gemini API Key')
			.addText(text => text
				.setValue(this.plugin.settings.geminiApiKey)
				.onChange(async (v) => {
					this.plugin.settings.geminiApiKey = v;
					await this.plugin.saveSettings();
				}));

		const modelSetting = new Setting(containerEl)
			.setName('Gemini Model')
			.setDesc('사용할 모델을 선택하세요.');

		modelSetting.addDropdown(async (dropdown) => {
			const currentModel = this.plugin.settings.modelName;
			let options: Record<string, string> = { ...DEFAULT_MODELS };
			
			if (currentModel && !options[currentModel]) {
				options[currentModel] = `${currentModel} (Custom)`;
			}

			dropdown.addOptions(options);
			dropdown.setValue(currentModel);

			dropdown.onChange(async (value) => {
				this.plugin.settings.modelName = value;
				await this.plugin.saveSettings();
			});
		});

		modelSetting.addExtraButton((btn) => {
			btn.setIcon('sync')
			   .setTooltip('Refresh Model List')
			   .onClick(async () => {
				   if (!this.plugin.settings.geminiApiKey) {
					   new Notice('⚠️ API Key Required');
					   return;
				   }
				   new Notice('Fetching models... ⏳');
				   
				   try {
					   const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.plugin.settings.geminiApiKey}`);
					   if (!response.ok) throw new Error('Network Error');
					   
					   const data = await response.json();
					   const validModels = data.models.filter((m: any) => 
						   m.name.includes('gemini') && 
						   m.supportedGenerationMethods.includes('generateContent')
					   );

					   const dropdownEl = modelSetting.controlEl.querySelector('select') as HTMLSelectElement;
					   if (dropdownEl) {
						   dropdownEl.innerHTML = '';
						   
						   validModels.forEach((m: any) => {
							   const id = m.name.replace('models/', '');
							   const option = document.createElement('option');
							   option.value = id;
							   option.text = `${m.displayName} (${m.version})`;
							   dropdownEl.add(option);
						   });
						   
						   const current = this.plugin.settings.modelName;
						   
						   // [Fix 1] dropdownEl.options[i] 오류 해결: item() 메서드 사용 및 null 체크
						   let exists = false;
						   for(let i=0; i<dropdownEl.options.length; i++) {
							   const opt = dropdownEl.options.item(i);
							   if(opt && opt.value === current) exists = true;
						   }
						   
						   if (!exists) {
								const option = document.createElement('option');
								option.value = current;
								option.text = `${current} (Current)`;
								dropdownEl.add(option);
						   }

						   dropdownEl.value = current;
					   }
					   new Notice(`✅ ${validModels.length} Models Loaded`);

				   } catch (error) {
					   new Notice(`Error: ${(error as Error).message}`);
				   }
			   });
		});

		new Setting(containerEl)
			.setName('Target Note File')
			.addText(text => text
				.setValue(this.plugin.settings.targetNotePath)
				.onChange(async (v) => {
					this.plugin.settings.targetNotePath = v;
					await this.plugin.saveSettings();
				}));
	}
}

class MultiSelectModal extends Modal {
	selectedFiles: Set<TFile> = new Set<TFile>();
	onProcess: (files: TFile[]) => void;

	constructor(app: App, onProcess: (files: TFile[]) => void) {
		super(app);
		this.onProcess = onProcess;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Select Files (Img/PDF)" });
		const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'pdf'];
		const allFiles = this.app.vault.getFiles()
			.filter(file => allowedExtensions.includes(file.extension.toLowerCase()))
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, 30);

		const listContainer = contentEl.createDiv();
		listContainer.style.maxHeight = "400px";
		listContainer.style.overflowY = "auto";

		allFiles.forEach((file) => {
			new Setting(listContainer)
				.setName(file.name)
				.setDesc(new Date(file.stat.mtime).toLocaleString())
				.addToggle((toggle) => {
					toggle.onChange((isChecked) => {
						if (isChecked) this.selectedFiles.add(file);
						else this.selectedFiles.delete(file);
					});
				});
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Start Analysis 🚀").setCta()
				.onClick(() => {
					this.close();
					this.onProcess(Array.from(this.selectedFiles));
				}));
	}
	onClose() { this.contentEl.empty(); }
}