import { App, Plugin, Notice, TFile } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
// 리팩토링된 모듈 불러오기
import { ErrorLogSettings, DEFAULT_SETTINGS, UniversalFile, ProblemItem } from './types';
import { CPA_GRADER_BATCH_PROMPT } from './prompts';
import { TargetFileSuggestModal, MultiSelectModal } from './modals';
import { ErrorLogSettingTab } from './settings';

export default class ErrorLogPlugin extends Plugin {
    settings: ErrorLogSettings;
    genAI: GoogleGenerativeAI;

    async onload() {
        await this.loadSettings();
        if (this.settings.geminiApiKey) {
            this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
        }

        // 리본 아이콘
        this.addRibbonIcon('brain-circuit', 'Create Error Log', (evt: MouseEvent) => {
            if (!this.settings.geminiApiKey) { new Notice('⚠️ API Key Required'); return; }
            new TargetFileSuggestModal(this.app, this, (selectedPath) => {
                this.settings.lastUsedPath = selectedPath;
                this.saveSettings();
                this.openImageSelector(selectedPath);
            }).open();
        });

        // 🖱️ 이미지 호버 & Alt 키 이벤트 (동기화 대응 및 스크롤 컨테이너 적용)
        this.registerDomEvent(document, 'mouseover', (evt: MouseEvent) => {
            const target = evt.target as HTMLElement;
            if (target.tagName !== 'IMG') return;

            const imgTarget = target as HTMLImageElement;
            const attachmentsFolder = this.settings.attachmentsPath || "CPA_Attachments";

            const isTargetImage = imgTarget.src.includes(attachmentsFolder) ||
                                  (imgTarget.getAttribute('data-path') && imgTarget.getAttribute('data-path')!.includes(attachmentsFolder));

            if (!isTargetImage) return;

            if (evt.altKey) {
                const src = imgTarget.src;
                // 기존에 떠있는 컨테이너가 있으면 제거
                const existingContainer = document.getElementById('cpa-floating-container');
                if (existingContainer) existingContainer.remove();

                // 1. 스크롤 가능한 컨테이너 생성 (Wrapper)
                const container = document.createElement('div');
                container.id = 'cpa-floating-container'; // ID 변경됨

                // 2. 실제 이미지 생성 및 컨테이너에 삽입
                const overlayImg = document.createElement('img');
                overlayImg.src = src;
                overlayImg.className = 'cpa-floating-img-inside'; // 내부 이미지용 클래스
                container.appendChild(overlayImg);

                // 3. 컨테이너 클릭 시 닫기
                container.onclick = (e) => {
                    container.remove();
                    e.stopPropagation();
                };

                document.body.appendChild(container);
                evt.stopImmediatePropagation();
            }
        });

        // ESC 키 닫기 (ID 변경 반영)
        this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Escape') {
                const container = document.getElementById('cpa-floating-container');
                if (container) container.remove();
            }
        });

        this.addSettingTab(new ErrorLogSettingTab(this.app, this));
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

    // 🚀 일괄 처리 로직 (PDF 분해 + Chunk 단위 LLM 전송)
    async batchProcessImages(files: UniversalFile[], targetPath: string) {
        if (files.length === 0) return;

        let assetsFolder = this.settings.attachmentsPath || "CPA_Attachments";
        if (!(await this.app.vault.adapter.exists(assetsFolder))) {
            await this.app.vault.createFolder(assetsFolder);
        }

        // 1. PDF를 이미지로 쪼개서 목록(Flat) 만들기
        let processableFiles: UniversalFile[] = [];
        for (const file of files) {
            if (file.extension.toLowerCase() === 'pdf') {
                const splitImages = await this.convertPdfToImages(file, assetsFolder);
                processableFiles.push(...splitImages);
            } else {
                processableFiles.push(file);
            }
        }

        if (processableFiles.length === 0) return;

        let allProblems: ProblemItem[] = [];
        const CHUNK_SIZE = 5; // 한 번에 API에 전송할 이미지 수
        const totalChunks = Math.ceil(processableFiles.length / CHUNK_SIZE);

        new Notice(`총 ${processableFiles.length}장, ${totalChunks}번의 묶음 분석을 시작합니다! 🏃`);

        // 2. Chunk 단위로 묶어서 LLM 통신
        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
            const start = chunkIdx * CHUNK_SIZE;
            const end = start + CHUNK_SIZE;
            const chunkFiles = processableFiles.slice(start, end);

            new Notice(`[묶음 ${chunkIdx + 1}/${totalChunks}] AI 분석 중... (${chunkFiles.length}장 처리)`);

            const problems = await this.fetchProblemsFromLLM(chunkFiles); // 🔥 이름 변경됨
            if (problems && problems.length > 0) {
                allProblems.push(...problems);
            }

            if (chunkIdx < totalChunks - 1) await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // 3. 분석 결과 파일에 저장
        if (allProblems.length > 0) {
            new Notice(`분석 완료! 저장 중... 📝`);
            await this.saveToMarkdown(allProblems, targetPath);
            new Notice("🎉 오답노트 작성이 완료되었습니다!");

            const file = this.app.vault.getAbstractFileByPath(targetPath);
            if (file instanceof TFile) {
                const leaves = this.app.workspace.getLeavesOfType('markdown');
                const existingLeaf = leaves.find(leaf => {
                    const view = leaf.view as any;
                    return view.file && view.file.path === file.path;
                });
                if (existingLeaf) this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                else await this.app.workspace.getLeaf('tab').openFile(file);
            }
        } else {
            new Notice("⚠️ 추출된 문제가 없습니다.");
        }
    }

    // 📦 묶음 단위(Batch)로 LLM에 전송하고 결과를 매핑하는 함수
    async fetchProblemsFromLLM(files: UniversalFile[]): Promise<ProblemItem[] | null> {
        await this.writeDebugLog("LLM_BATCH_START", `Batch 요청 시작. 처리할 파일 수: ${files.length}`);

        try {
            const modelName = this.settings?.modelName || "gemini-2.0-flash";
            const model = this.genAI.getGenerativeModel({ model: modelName });

            const promptParts: any[] = [CPA_GRADER_BATCH_PROMPT];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                // 🔥 [수정 1] file 객체가 null 또는 undefined인 경우 방어 (에러 방지)
                if (!file || !file.path) {
                    await this.writeDebugLog("BATCH_WARNING", `인덱스 ${i}의 파일 객체가 비어있습니다. 건너뜁니다.`);
                    continue;
                }

                let base64Data = "";

                if (file.isExternal) {
                    const bitmap = fs.readFileSync(file.path);
                    base64Data = Buffer.from(bitmap).toString('base64');
                } else if (file.originalObject) {
                    const arrayBuffer = await this.app.vault.readBinary(file.originalObject as TFile);
                    base64Data = Buffer.from(arrayBuffer).toString('base64');
                }

                const mimeType = 'image/png';

                promptParts.push({ text: `\n--- [Image Index: ${i}] ---\n` });
                promptParts.push({ inlineData: { data: base64Data, mimeType: mimeType } });
            }

            const result = await model.generateContent(promptParts);
            const textResponse = result.response.text();

            await this.writeDebugLog("LLM_RESPONSE_RAW", `LLM 원문 응답 수신 완료`, textResponse);

            let extractedData: any[] = [];
            try {
                extractedData = this.parseRoughJson(textResponse);
            } catch (e) {
                await this.writeDebugLog("JSON_PARSE_ERROR", `JSON 파싱 실패`, e);
                new Notice(`⚠️ 묶음 분석 실패 (형식 오류)`);
                return null;
            }

            if (!Array.isArray(extractedData)) {
                await this.writeDebugLog("JSON_FORMAT_ERROR", `결과가 배열 형식이 아님`, extractedData);
                return null;
            }

            const mappedProblems: ProblemItem[] = [];
            for (const item of extractedData) {
                const idx = item.image_index;
                if (typeof idx === 'number' && idx >= 0 && idx < files.length) {
                    const matchedFile = files[idx];

                    // 🔥 [수정 2] 매핑할 원본 파일 객체가 null인 경우 방어
                    if (!matchedFile) {
                        await this.writeDebugLog("MAPPING_WARNING", `인덱스 ${idx}에 매핑할 원본 파일이 존재하지 않습니다.`, item);
                        continue;
                    }

                    mappedProblems.push({
                        ...item,
                        imagePath: matchedFile.path,
                        isExternal: matchedFile.isExternal
                    });
                } else {
                    await this.writeDebugLog("MAPPING_WARNING", `유효하지 않은 image_index: ${idx}`, item);
                }
            }

            mappedProblems.sort((a, b) => {
                const idxA = a.image_index !== undefined ? a.image_index : 0;
                const idxB = b.image_index !== undefined ? b.image_index : 0;
                return idxA - idxB;
            });

            await this.writeDebugLog("BATCH_SUCCESS", `추출 및 매핑된 문제 수: ${mappedProblems.length}`);
            return mappedProblems;

        } catch (error) {
            await this.writeDebugLog("LLM_API_ERROR", `Batch API 호출 실패`, error);
            console.error(`Batch API 호출 실패:`, error);
            return null;
        }
    }

    async convertPdfToImages(pdfFile: UniversalFile, targetFolder: string): Promise<UniversalFile[]> {
        await this.writeDebugLog("PDF_CONVERT_START", `정밀 렌더링 엔진 가동: ${pdfFile.name}`);
        const { vault } = this.app;
        const generatedImages: UniversalFile[] = [];

        try {
            let data: ArrayBuffer;
            if (pdfFile.isExternal) {
                data = fs.readFileSync(pdfFile.path).buffer;
            } else {
                data = await vault.readBinary(pdfFile.originalObject as TFile);
            }

            // 🔥 [해결 1] 라이브러리 버전을 동적으로 확인하여 워커 주소 일치시킴
            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            // const loadingTask = pdfjsLib.getDocument({
            //     data: new Uint8Array(data),
            //     // 워커 로드 실패 시 메인 스레드에서라도 실행하도록 함 (약간 느려질 수 있으나 작동은 함)
            //     disableWorker: false,
            //     stopAtErrors: false
            // });

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(data),
                // 폰트 로딩 문제 방지
                disableFontFace: false
            });

            const pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);

                // 🔥 [해결 2] 스케일을 1.2로 약간 낮춰 메모리 압박 감소 (CPA 시험지는 1.2로도 충분합니다)
                const viewport = page.getViewport({ scale: 1.2 });

                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d', { alpha: false }); // 성능 향상을 위해 알파 채널 제거

                if (!context) throw new Error("Canvas Context 생성 실패");

                canvas.height = viewport.height;
                canvas.width = viewport.width;

                // 🔥 [해결 3] 렌더링 태스크에 명시적인 에러 캐칭 추가
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport,
                    canvas: canvas
                };

                const renderTask = page.render(renderContext);

                try {
                    await renderTask.promise;
                } catch (renderErr) {
                    await this.writeDebugLog("RENDER_TASK_ERROR", `페이지 ${pageNum} 렌더링 실패`, renderErr);
                    continue; // 한 페이지 실패해도 다음 페이지 시도
                }

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
                const buffer = Buffer.from(base64Data, 'base64');

                const originalName = path.basename(pdfFile.path, '.pdf').replace(/[^a-zA-Z0-9가-힣]/g, '_');
                const newFileName = `${Date.now()}_${originalName}_p${pageNum}.png`;
                const newInternalPath = `${targetFolder}/${newFileName}`;

                const createdFile = await vault.createBinary(newInternalPath, buffer);

                generatedImages.push({
                    name: createdFile.name,
                    path: createdFile.path,
                    mtime: createdFile.stat.mtime,
                    isExternal: false,
                    extension: 'png',
                    originalObject: createdFile
                });

                // 메모리 해제 지원
                canvas.width = 0;
                canvas.height = 0;
            }

            await this.writeDebugLog("PDF_CONVERT_SUCCESS", `성공적으로 ${generatedImages.length}개 이미지 생성`);
            return generatedImages;

        } catch (error) {
            await this.writeDebugLog("PDF_CONVERT_FATAL", `PDF 처리 파이프라인 붕괴`, error);
            new Notice(`❌ PDF 변환 실패: ${pdfFile.name}`);
            return [];
        }
    }

    // 📝 디버그 로깅
    async writeDebugLog(context: string, message: string, data: any = "") {
        const { vault } = this.app;
        const logPath = this.settings.debugLogPath || "CPA_Debug_Log.md";
        const timestamp = window.moment().format("YYYY-MM-DD HH:mm:ss");

        let dataString = "";
        if (data instanceof Error) dataString = `${data.name}: ${data.message}\n${data.stack || ''}`;
        else if (typeof data === 'object') { try { dataString = JSON.stringify(data, null, 2); } catch (e) { dataString = String(data); } }
        else dataString = String(data);

        const logEntry = `\n### [${timestamp}] ${context}\n- **Message**: ${message}\n- **Data**:\n\`\`\`text\n${dataString}\n\`\`\`\n`;

        try {
            const fileExists = await vault.adapter.exists(logPath);
            if (!fileExists) await vault.create(logPath, `# 🐞 CPA Plugin Debug Log\n${logEntry}`);
            else {
                const file = vault.getAbstractFileByPath(logPath);
                if (file instanceof TFile) await vault.process(file, (content) => content + logEntry);
            }
            console.log(`[CPA Debug: ${context}]`, message);
        } catch (e) { console.error("로그 작성 실패:", e); }
    }

    // 💾 마크다운 저장 (위키링크 버전)
    async saveToMarkdown(items: ProblemItem[], targetPath: string) {
        const { vault } = this.app;
        if (!targetPath || targetPath.trim() === "") targetPath = "CPA_Error_Log.md";
        if (!targetPath.endsWith(".md")) targetPath += ".md";

        const fileExists = await vault.adapter.exists(targetPath);
        let assetsFolder = this.settings.attachmentsPath || "CPA_Attachments";
        if (!(await vault.adapter.exists(assetsFolder))) await vault.createFolder(assetsFolder);

        let chunk = "";
        let currentPath: string | null = null;

        for (const item of items) {
            const safeSubject = this.sanitizeForTable(item.subject || "기타");
            const safeAnswer = this.sanitizeForTable(item.answer || "");
            const safeSolution = this.sanitizeForTable(item.solution || "");
            const safeNumber = this.sanitizeForTable(item.number || "");
            const scrollableSolution = `<div class="cpa-solution cpa-text">${safeSolution}</div>`;

            const showImage = (item.imagePath !== currentPath);
            currentPath = item.imagePath;

            let imgTag = "";
            if (showImage) {
                try {
                    let data: Buffer;
                    if (item.isExternal) data = fs.readFileSync(item.imagePath);
                    else {
                        const fileObj = vault.getAbstractFileByPath(item.imagePath);
                        if (fileObj instanceof TFile) data = Buffer.from(await vault.readBinary(fileObj));
                        else throw new Error("내부 파일을 찾을 수 없음");
                    }

                    const originalName = path.basename(item.imagePath);
                    const safeName = originalName.replace(/[^a-zA-Z0-9가-힣.]/g, '_');
                    const newFileName = `${Date.now()}_${safeName}`;
                    const newInternalPath = `${assetsFolder}/${newFileName}`;

                    const createdFile = await vault.createBinary(newInternalPath, data);
                    imgTag = `![[${createdFile.path}]]`;

                    if (item.isExternal) {
                        try { fs.unlinkSync(item.imagePath); } catch (delErr) { console.error(`원본 삭제 실패`, delErr); }
                    }
                } catch (e) {
                    console.error("이미지 처리 실패:", e);
                    imgTag = `❌ 이미지 로드 실패`;
                }
            }
            chunk += `| ${safeSubject} | ${imgTag} | ${safeNumber}: ${safeAnswer} | ${scrollableSolution} |  |\n`;
        }

        if (!fileExists) {
            const header = `---\ncssclasses: cpa-log\n---\n\n| 과목 | 문제 | 정답 | 풀이 | 비고 |\n|:---:|:---|:---|:---|:---|\n`;
            await vault.create(targetPath, header + chunk);
        } else {
            const file = vault.getAbstractFileByPath(targetPath);
            if (file instanceof TFile) await vault.process(file, (data) => data + chunk);
        }
    }

    parseRoughJson(text: string): any[] {
        let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const start = clean.indexOf('[');
        const end = clean.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error("JSON Array brackets not found");
        clean = clean.substring(start, end + 1);
        clean = clean.replace(/,(\s*\])/g, '$1');

        // 🔥 [추가된 핵심 방어 로직] 
        // LLM이 JSON 문자열 안에 무심코 쓴 LaTeX 백슬래시(\times)나 특수기호(\$)를 
        // JSON 파서가 에러 없이 읽을 수 있도록 이중 백슬래시(\\)로 안전하게 치환합니다.
        // (단, JSON 문자열 구조를 유지해야 하는 따옴표 이스케이프(\")는 건드리지 않습니다.)
        clean = clean.replace(/\\(?=[^\\"])/g, '\\\\');

        try { return JSON.parse(clean); }
        catch (e) { 
            clean = clean.replace(/,\s*}/g, '}'); 
            return JSON.parse(clean); 
        }
    }

    // 🧹 데이터 정제 함수 (치환 전략 + 중복 이스케이프 방지 적용)
    sanitizeForTable(text: string): string {
        if (!text) return "";
        let clean = text;
        
        clean = clean.replace(/^```(json|markdown|text)?/i, '').replace(/```$/i, '');
        clean = clean.replace(/^`/, '').replace(/`$/, '');
        clean = clean.replace(/\|/g, '&#124;');
        
        // 🔥 [수정됨] 텍스트 내의 '$'를 텍스트용(\$)으로 강제 이스케이프하되,
        // LLM이 이미 백슬래시를 붙여둔 경우(?<!\\)는 중복해서 이스케이프하지 않음
        clean = clean.replace(/(?<!\\)\$/g, '\\$');
        
        // LLM이 작성한 수식 태그 [MATH]...[/MATH] 를 찾아내서 마크다운 진짜 수식 기호인 $...$ 로 변환
        clean = clean.replace(/\[MATH\](.*?)\[\/MATH\]/g, '$$$1$$');
        
        clean = clean.replace(/(\r\n|\n|\r)/gm, '<br>').replace(/\\n/g, '<br>');
        
        return clean.trim();
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}