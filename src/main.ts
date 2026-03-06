import { App, Plugin, Notice, TFile } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
// 리팩토링된 모듈 불러오기
import { ErrorLogSettings, DEFAULT_SETTINGS, UniversalFile, ProblemItem } from './types';
import { CPA_GRADER_BATCH_PROMPT, TABLE_FIX_PROMPT } from './prompts';
import { TargetFileSuggestModal, MultiSelectModal, ActionSelectModal } from './modals';
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
            if (!this.settings.geminiApiKey) { new Notice('⚠️ API Key Required', 0); return; }
            new TargetFileSuggestModal(this.app, this, (selectedPath) => {
                this.settings.lastUsedPath = selectedPath;
                this.saveSettings();
                new ActionSelectModal(this.app,
                    () => this.openImageSelector(selectedPath),
                    () => this.fixTableFormatting(selectedPath)
                ).open();
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

    async batchProcessImages(files: UniversalFile[], targetPath: string) {
        if (files.length === 0) return;

        let assetsFolder = this.settings.attachmentsPath || "CPA_Attachments";
        if (!(await this.app.vault.adapter.exists(assetsFolder))) {
            await this.app.vault.createFolder(assetsFolder);
        }

        // 🔥 [해결 1] 전체 진행 상태를 관리하는 단일 Notice 객체 생성 (사라지지 않음)
        const progressNotice = new Notice('작업 준비 중...', 0);

        try {
            // 1. PDF를 이미지로 쪼개서 목록(Flat) 만들기
            progressNotice.setMessage('PDF 및 이미지 파일 전처리 중입니다...');
            let processableFiles: UniversalFile[] = [];

            for (const file of files) {
                if (file.extension.toLowerCase() === 'pdf') {
                    // 참고: convertPdfToImages 내부에도 Notice가 있다면 화면에 잠시 두 개가 뜰 수 있습니다.
                    const splitImages = await this.convertPdfToImages(file, assetsFolder, progressNotice);
                    processableFiles.push(...splitImages);
                } else {
                    processableFiles.push(file);
                }
            }

            if (processableFiles.length === 0) {
                progressNotice.hide();
                new Notice("⚠️ 처리할 이미지가 없습니다.", 5000);
                return;
            }

            let allProblems: ProblemItem[] = [];
            const CHUNK_SIZE = 5; // 한 번에 API에 전송할 이미지 수
            const totalChunks = Math.ceil(processableFiles.length / CHUNK_SIZE);

            progressNotice.setMessage(`총 ${processableFiles.length}장, ${totalChunks}번의 묶음 분석을 시작합니다! 🏃`);

            // 2. Chunk 단위로 묶어서 LLM 통신
            for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                const start = chunkIdx * CHUNK_SIZE;
                const end = start + CHUNK_SIZE;
                const chunkFiles = processableFiles.slice(start, end);

                // 🔥 [해결 2] 새로운 Notice를 띄우지 않고 기존 Notice의 텍스트만 동적 교체
                progressNotice.setMessage(`[묶음 ${chunkIdx + 1}/${totalChunks}] AI 분석 중... (${chunkFiles.length}장 처리)`);

                const problems = await this.fetchProblemsFromLLM(chunkFiles);
                if (problems && problems.length > 0) {
                    allProblems.push(...problems);
                }

                if (chunkIdx < totalChunks - 1) {
                    progressNotice.setMessage(`[묶음 ${chunkIdx + 1}/${totalChunks}] API 쿨타임 대기 중...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            // 3. 분석 결과 파일에 저장
            if (allProblems.length > 0) {
                progressNotice.setMessage(`분석 완료! 마크다운 파일 생성 중... 📝`);
                await this.saveToMarkdown(allProblems, targetPath);

                // 🔥 [해결 3] 모든 작업이 성공적으로 끝났을 때만 기존 알림을 숨기고 성공 알림 표시
                progressNotice.hide();
                new Notice("🎉 오답노트 작성이 완료되었습니다!", 5000);

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
                progressNotice.hide();
                new Notice("⚠️ 추출된 문제가 없습니다.", 5000);
            }

        } catch (error: unknown) {
            // 🔥 LLM 통신이나 파일 저장 중 에러가 발생하면 무조건 알림을 끄고 에러 표출
            progressNotice.hide();

            // 안전하게 에러 메시지 추출 (Type Guard)
            let errorMessage = "알 수 없는 오류가 발생했습니다.";
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === "string") {
                errorMessage = error;
            } else {
                errorMessage = String(error);
            }

            new Notice(`❌ 일괄 처리 중 오류 발생: ${errorMessage}`, 10000);
            console.error("Batch Process Error:", error); // 콘솔에 원본 객체 상세 로깅
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
                // 메인 알림을 방해하지 않도록 에러 로깅만 하고 Notice는 띄우지 않습니다.
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

    async convertPdfToImages(pdfFile: UniversalFile, targetFolder: string, sharedNotice?: Notice): Promise<UniversalFile[]> {
        await this.writeDebugLog("PDF_CONVERT_START", `정밀 렌더링 엔진 가동: ${pdfFile.name}`);
        const { vault } = this.app;
        const generatedImages: UniversalFile[] = [];

        let progressNotice: Notice;
        if (sharedNotice) {
            progressNotice = sharedNotice;
            progressNotice.setMessage(`PDF 고화질 변환 중입니다... (${pdfFile.name})`);
        } else {
            progressNotice = new Notice(`PDF 고화질 변환 중입니다... (${pdfFile.name})`, 0);
        }
        let pdfDocument: any = null; // finally 블록에서 자원을 해제하기 위해 외부 스코프에 선언

        try {
            let data: ArrayBuffer;
            if (pdfFile.isExternal) {
                data = fs.readFileSync(pdfFile.path).buffer;
            } else {
                data = await vault.readBinary(pdfFile.originalObject as TFile);
            }

            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(data),
                disableFontFace: false
            });

            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);

                // 🔥 [핵심 1] 화질 완전 보존: 스케일을 4.0으로 대폭 상향 (CPA 수식/작은 글씨 깨짐 방지)
                const viewport = page.getViewport({ scale: 4.0 });

                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d', { alpha: false }); // 성능 향상을 위해 알파 채널 제거

                if (!context) throw new Error("Canvas Context 생성 실패");

                canvas.height = viewport.height;
                canvas.width = viewport.width;

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
                    page.cleanup(); // 실패 시에도 메모리 누수 방지를 위해 정리
                    continue;
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

                // 🔥 [핵심 2] 메모리 스파이크 통제: 캔버스 비우기 + pdf.js 내부 캐시 강제 반환
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }

            await this.writeDebugLog("PDF_CONVERT_SUCCESS", `성공적으로 ${generatedImages.length}개 이미지 생성`);

            // 2. 작업 완료: 진행 중 알림을 숨기고 성공 알림 표시
            if (!sharedNotice) {
                progressNotice.hide();
                new Notice(`✅ PDF 변환 완료: ${numPages}페이지 (고화질 보존)`, 5000);
            }
            return generatedImages;

            } catch (error) {
            await this.writeDebugLog("PDF_CONVERT_FATAL", `PDF 처리 파이프라인 붕괴`, error);

            // 에러 시에도 공유 객체 여부에 따라 다르게 처리
            if (!sharedNotice) {
                progressNotice.hide();
                new Notice(`❌ PDF 변환 실패: ${pdfFile.name}`, 10000);
            } else {
                progressNotice.setMessage(`❌ PDF 변환 실패: ${pdfFile.name}`);
            }

            return [];
        } finally {
            // 🔥 [핵심 3] 문서 완전 파기: 루프가 끝난 뒤 전체 워커와 메모리를 시스템에 반환
            if (pdfDocument) {
                try {
                    await pdfDocument.destroy();
                } catch (e) {
                    await this.writeDebugLog("PDF_DESTROY_ERROR", `문서 객체 파기 중 오류 발생`, e);
                }
            }
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

    // 🧹 데이터 정제 함수 (수식 내부 줄바꿈 및 특수기호 완벽 제어 버전)
    sanitizeForTable(text: string): string {
        if (!text) return "";
        let clean = text;

        clean = clean.replace(/^```(json|markdown|text)?/i, '').replace(/```$/i, '');
        clean = clean.replace(/^`/, '').replace(/`$/, '');
        clean = clean.replace(/\|/g, '&#124;');

        // 1. [MATH] 태그 내부 집중 정제 (LLM이 지시를 잘 따랐을 때 발동)
        clean = clean.replace(/\[MATH\]([\s\S]*?)\[\/MATH\]/g, (match, mathInner) => {
            // A. 수식 내부의 줄바꿈이나 <br>은 테이블 붕괴 원인이므로 띄어쓰기로 압착
            let refined = mathInner.replace(/(\r\n|\n|\r|<br>|\\n)/gm, '  ');

            // B. 수식 내부에 달러($10,000)가 있으면 MathJax가 폭발하므로 강제 이스케이프 처리
            refined = refined.replace(/(?<!\\)\$/g, '\\$');

            // C. 혹시라도 LLM이 습관적으로 쓴 '*' 기호가 마크다운을 망치지 않도록 \times로 치환
            refined = refined.replace(/\*/g, '\\times ');

            // 완벽하게 정제된 수식을 옵시디언 MathJax 기호로 감싸서 배출
            return `$${refined}$`;
        });

        // 2. 수식 처리가 끝난 후, 텍스트 구간에 남은 모든 '$'는 100% 금액이므로 안전하게 이스케이프
        clean = clean.replace(/(?<!\\)\$/g, '\\$');

        // 3. 텍스트 구간의 일반 줄바꿈을 표 내부용 <br>로 변경
        clean = clean.replace(/(\r\n|\n|\r)/gm, '<br>').replace(/\\n/g, '<br>');

        return clean.trim();
    }

    // 📋 테이블 수정 기능
    async fixTableFormatting(targetPath: string): Promise<void> {
        const progressNotice = new Notice('테이블 구조 분석 준비 중...', 0);

        try {
            const file = this.app.vault.getAbstractFileByPath(targetPath);
            if (!(file instanceof TFile)) {
                progressNotice.hide();
                new Notice('파일을 찾을 수 없습니다: ' + targetPath, 5000);
                return;
            }

            const originalContent = await this.app.vault.read(file);

            if (!this.containsMarkdownTable(originalContent)) {
                progressNotice.hide();
                new Notice('이 파일에는 마크다운 테이블이 없습니다.', 5000);
                return;
            }

            // 백업 파일 생성
            const backupPath = targetPath.replace(/\.md$/, '_backup.md');
            progressNotice.setMessage('백업 파일 생성 중...');
            const backupExists = await this.app.vault.adapter.exists(backupPath);
            if (backupExists) {
                const backupFile = this.app.vault.getAbstractFileByPath(backupPath);
                if (backupFile instanceof TFile) await this.app.vault.modify(backupFile, originalContent);
            } else {
                await this.app.vault.create(backupPath, originalContent);
            }
            await this.writeDebugLog("TABLE_FIX_BACKUP", `백업 생성: ${backupPath}`);

            // 테이블 블록 추출
            const tableBlocks = this.extractTableBlocks(originalContent);
            if (tableBlocks.length === 0) {
                progressNotice.hide();
                new Notice('테이블 블록을 추출할 수 없습니다.', 5000);
                return;
            }

            let result = originalContent;
            let offset = 0;
            let fixedCount = 0;
            let skippedCount = 0;

            for (let i = 0; i < tableBlocks.length; i++) {
                const block = tableBlocks[i]!;
                progressNotice.setMessage(`테이블 ${i + 1}/${tableBlocks.length} 수정 중...`);

                const fixedTable = await this.fixTableViaLLM(block.text);

                // 행 수 검증: 80% 미만이면 거부
                const originalRows = block.text.split('\n').filter(l => l.trim().startsWith('|')).length;
                const fixedRows = fixedTable.split('\n').filter(l => l.trim().startsWith('|')).length;

                if (fixedRows < originalRows * 0.8) {
                    await this.writeDebugLog("TABLE_FIX_REJECTED", `테이블 ${i + 1}: 행 수 검증 실패 (원본 ${originalRows}행 → 응답 ${fixedRows}행). 원본 유지.`);
                    skippedCount++;
                    continue;
                }

                const adjustedStart = block.start + offset;
                const adjustedEnd = block.end + offset;
                result = result.substring(0, adjustedStart) + fixedTable + result.substring(adjustedEnd);
                offset += fixedTable.length - block.text.length;
                fixedCount++;

                if (i < tableBlocks.length - 1) {
                    progressNotice.setMessage(`API 쿨타임 대기 중... (${i + 1}/${tableBlocks.length})`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (result === originalContent) {
                progressNotice.hide();
                new Notice('테이블 구조에 문제가 없습니다. 수정 사항 없음.', 5000);
                return;
            }

            progressNotice.setMessage('수정된 내용을 저장하는 중...');
            await this.app.vault.modify(file, result);

            progressNotice.hide();
            let msg = `테이블 수정 완료! (${fixedCount}개 수정`;
            if (skippedCount > 0) msg += `, ${skippedCount}개 검증 실패로 건너뜀`;
            msg += `)`;
            new Notice(msg, 5000);

            // 파일 열기/포커스
            const leaves = this.app.workspace.getLeavesOfType('markdown');
            const existingLeaf = leaves.find(leaf => {
                const view = leaf.view as any;
                return view.file && view.file.path === file.path;
            });
            if (existingLeaf) this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
            else await this.app.workspace.getLeaf('tab').openFile(file);

        } catch (error: unknown) {
            progressNotice.hide();
            let errorMessage = "알 수 없는 오류가 발생했습니다.";
            if (error instanceof Error) errorMessage = error.message;
            else if (typeof error === "string") errorMessage = error;
            else errorMessage = String(error);

            new Notice(`테이블 수정 중 오류 발생: ${errorMessage}`, 10000);
            console.error("Table Fix Error:", error);
            await this.writeDebugLog("TABLE_FIX_ERROR", `테이블 수정 실패`, error);
        }
    }

    async fixTableViaLLM(tableText: string): Promise<string> {
        const modelName = this.settings?.modelName || "gemini-2.0-flash";
        const model = this.genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent([
            TABLE_FIX_PROMPT,
            `\n--- [테이블 시작] ---\n${tableText}\n--- [테이블 끝] ---\n`
        ]);

        let response = result.response.text();
        await this.writeDebugLog("TABLE_FIX_RAW", "테이블 수정 LLM 응답 수신", response);

        // 코드펜스 제거
        response = response.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

        return response;
    }

    extractTableBlocks(content: string): { start: number; end: number; text: string }[] {
        const lines = content.split('\n');
        const blocks: { start: number; end: number; text: string }[] = [];
        let tableStart = -1;
        let charPos = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            const isTableLine = line.trim().startsWith('|');

            if (isTableLine && tableStart === -1) {
                tableStart = charPos;
            } else if (!isTableLine && tableStart !== -1) {
                blocks.push({
                    start: tableStart,
                    end: charPos - 1, // 이전 줄 끝 (줄바꿈 제외)
                    text: content.substring(tableStart, charPos - 1)
                });
                tableStart = -1;
            }

            charPos += line.length + 1; // +1 for \n
        }

        // 파일 끝이 테이블인 경우
        if (tableStart !== -1) {
            blocks.push({
                start: tableStart,
                end: content.length,
                text: content.substring(tableStart)
            });
        }

        return blocks;
    }

    containsMarkdownTable(content: string): boolean {
        return /^\|.+\|$/m.test(content);
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}