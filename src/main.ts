import { App, Plugin, Notice, TFile } from 'obsidian';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist';
// 리팩토링된 모듈 불러오기
import {
    ErrorLogSettings, DEFAULT_SETTINGS, UniversalFile, ProblemItem,
    PreAnalysisInputFile, RenderedPage, PreAnalysisResponse, ParseTarget,
    PreAnalysisContext, ProgressStatus, PdfTextContent, ParsedAnswers,
    AnswerItem, ExplanationItem
} from './types';
import { TargetFileSuggestModal, MultiSelectModal, ActionSelectModal } from './modals';
import { ErrorLogSettingTab } from './settings';
import { DebugLogger } from './utils/logger';
import { LLMService } from './services/llm-service';
import { PDFService } from './services/pdf-service';
import { MarkdownService } from './services/markdown-service';
import { TableService } from './services/table-service';
import { CPA_GRADER_BATCH_PROMPT, OCR_TEXT_EXTRACTION_PROMPT, ANSWER_KEY_EXTRACTION_PROMPT, EXPLANATION_EXTRACTION_PROMPT } from './prompts';

export default class ErrorLogPlugin extends Plugin {
    settings: ErrorLogSettings;
    genAI: GoogleGenerativeAI;

    // Service instances
    private logger!: DebugLogger;
    private llmService!: LLMService;
    private pdfService!: PDFService;
    private markdownService!: MarkdownService;

    async onload() {
        await this.loadSettings();
        
        // Initialize logger first
        this.logger = new DebugLogger(this.settings, this.app.vault);
        
        // Initialize AI
        if (this.settings.geminiApiKey) {
            this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
        }
        
        // Initialize services (dependency order matters)
        this.llmService = new LLMService(this.genAI, this.settings.modelName, this.logger);
        this.pdfService = new PDFService(this.logger);
        this.markdownService = new MarkdownService(this.logger);

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
                container.id = 'cpa-floating-container';

                // 2. 실제 이미지 생성 및 컨테이너에 삽입
                const overlayImg = document.createElement('img');
                overlayImg.src = src;
                overlayImg.className = 'cpa-floating-img-inside';
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

        // ESC 키 닫기
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

        // 전체 진행 상태를 관리하는 단일 Notice 객체 생성
        const progressNotice = new Notice('작업 준비 중...', 0);

        // Separate PDFs and images - only PDFs go to pre-analysis
        const pdfFiles = files.filter(f => f.extension.toLowerCase() === 'pdf');
        const imageFiles = files.filter(f => f.extension.toLowerCase() !== 'pdf');

        try {
            // Step 4.5: Pre-Analysis (only for PDFs)
            let preAnalysisContext: PreAnalysisContext | null = null;
            // Map from page number to image path for pre-processed content
            const preAnalysisImageMap: Map<number, string> = new Map();
            
            if (pdfFiles.length > 0) {
                progressNotice.setMessage('Pre-Analysis 시작: PDF 내용 분석 중...');
                try {
                    preAnalysisContext = await this.performPreAnalysis(
                        pdfFiles,
                        assetsFolder,
                        progressNotice
                    );

                    if (preAnalysisContext) {
                        progressNotice.setMessage(`Pre-Analysis 완료: ${preAnalysisContext.answers.length}개의 정답, ${preAnalysisContext.processedContent.length}개의 해설 찾음`);
                    } else {
                        progressNotice.setMessage('Pre-Analysis 스킵 - 기본 처리 모드 진행');
                    }
                } catch (error) {
                    // Silent fallback
                    console.warn('Pre-analysis failed, falling back to original behavior');
                    progressNotice.setMessage('Pre-Analysis 스킵 - 기본 처리 모드 진행');
                }
            }

            // Step 5: Preprocessing - Convert PDFs to images (if needed) and prepare files
            progressNotice.setMessage('PDF 및 이미지 파일 전처리 중입니다...');
            let processableFiles: UniversalFile[] = [...imageFiles];

            if (pdfFiles.length > 0) {
                if (preAnalysisContext && preAnalysisContext.progressStatus.remaining.length > 0) {
                    // Only render remaining pages that weren't processed in pre-analysis
                    for (const pdfFile of pdfFiles) {
                        const remainingImages = await this.renderRemainingPdfPages(
                            pdfFile,
                            preAnalysisContext.progressStatus.remaining,
                            assetsFolder,
                            progressNotice
                        );
                        processableFiles.push(...remainingImages);
                    }
                } else {
                    // Render all PDF pages (fallback or when no pre-analysis context)
                    for (const pdfFile of pdfFiles) {
                        const splitImages = await this.convertPdfToImages(pdfFile, assetsFolder, progressNotice);
                        processableFiles.push(...splitImages);
                    }
                }
            }

            if (processableFiles.length === 0 && (!preAnalysisContext || preAnalysisContext.processedContent.length === 0)) {
                progressNotice.hide();
                new Notice("⚠️ 처리할 이미지가 없습니다.", 5000);
                return;
            }

            let allProblems: ProblemItem[] = [...(preAnalysisContext?.processedContent || [])];
            const CHUNK_SIZE = 2;
            const totalChunks = Math.ceil(processableFiles.length / CHUNK_SIZE);

            if (totalChunks > 0) {
                progressNotice.setMessage(`총 ${processableFiles.length}장, ${totalChunks}번의 묶음 분석을 시작합니다! 🏃`);

                // Step 6: Batch Analysis
                for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                    const start = chunkIdx * CHUNK_SIZE;
                    const end = start + CHUNK_SIZE;
                    const chunkFiles = processableFiles.slice(start, end);

                    progressNotice.setMessage(`[묶음 ${chunkIdx + 1}/${totalChunks}] AI 분석 중... (${chunkFiles.length}장 처리)`);

                    const problems = await this.fetchProblemsFromLLM(chunkFiles, preAnalysisContext);
                    if (problems && problems.length > 0) {
                        allProblems.push(...problems);
                    }

                    if (chunkIdx < totalChunks - 1) {
                        progressNotice.setMessage(`[묶음 ${chunkIdx + 1}/${totalChunks}] API 쿨타임 대기 중...`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                }
            }

            // Step 7: Save to markdown
            if (allProblems.length > 0) {
                progressNotice.setMessage(`분석 완료! 마크다운 파일 생성 중... 📝`);
                await this.saveToMarkdown(allProblems, targetPath);

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
            progressNotice.hide();

            // 안전하게 에러 메시지 추출
            let errorMessage = "알 수 없는 오류가 발생했습니다.";
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === "string") {
                errorMessage = error;
            } else {
                errorMessage = String(error);
            }

            new Notice(`❌ 일괄 처리 중 오류 발생: ${errorMessage}`, 10000);
            console.error("Batch Process Error:", error);
        }
    }

    // 묶음 단위(Batch)로 LLM에 전송하고 결과를 매핑하는 함수
    // Updated to accept optional pre-analysis context for enhanced batch processing
    async fetchProblemsFromLLM(
        files: UniversalFile[],
        preAnalysisContext: PreAnalysisContext | null
    ): Promise<ProblemItem[] | null> {
        // Read binary helper for LLM service
        const readImageBinary = async (file: UniversalFile): Promise<string> => {
            let base64Data = "";

            if (file.isExternal) {
                const bitmap = fs.readFileSync(file.path);
                base64Data = Buffer.from(bitmap).toString('base64');
            } else if (file.originalObject) {
                const arrayBuffer = await this.app.vault.readBinary(file.originalObject as TFile);
                base64Data = Buffer.from(arrayBuffer).toString('base64');
            }

            return base64Data;
        };

        return this.llmService.fetchProblemsFromLLM(files, readImageBinary, preAnalysisContext);
    }

    /**
     * Step 4.5: Pre-Analysis - Extract answers/explanations from PDFs before batch processing
     * Only processes PDF files, not standalone images
     */
    private async performPreAnalysis(
        pdfFiles: UniversalFile[],
        assetsFolder: string,
        progressNotice: Notice
    ): Promise<PreAnalysisContext | null> {
        progressNotice.setMessage('Pre-Analysis 시작: 답변/해설 추출 중...');

        // Build pre-analysis inputs (only PDFs) and track page-to-image mapping
        const preAnalysisInputs: PreAnalysisInputFile[] = [];
        // Map from sequential index to {imagePath, page}
        const pageIndexToImage: Map<number, { imagePath: string; page: number }> = new Map();
        let currentPage = 0;

        for (const file of pdfFiles) {
            // Render PDF pages to images for pre-analysis (lower resolution for speed)
            const renderedResults = await this.renderPagesForPreAnalysis(file, assetsFolder);
            if (renderedResults.length > 0) {
                const pagesWithContext: RenderedPage[] = renderedResults.map((r, i) => ({
                    ...r.page,
                    pageNumber: currentPage + i
                }));
                
                preAnalysisInputs.push({
                    fileName: file.path.split('/').pop() || file.name,
                    fileType: 'pdf',
                    pages: pagesWithContext,
                    startPage: currentPage,
                    endPage: currentPage + renderedResults.length - 1
                });

                // Track page-to-image mapping
                for (const r of renderedResults) {
                    pageIndexToImage.set(r.page.pageNumber, {
                        imagePath: r.imagePath,
                        page: r.pageNum
                    });
                }
                
                currentPage += renderedResults.length;
            }
        }

        if (preAnalysisInputs.length === 0) {
            return null; // Nothing to analyze
        }

        // Call Pre-Analysis Gemini
        progressNotice.setMessage(`Pre-Analysis 진행 중... (${currentPage} 페이지 처리)`);

        const preAnalysisResponse = await this.llmService.preAnalysis(preAnalysisInputs);

        if (!preAnalysisResponse) {
            progressNotice.setMessage('Pre-Analysis 실패 - fallback 모드 진행');
            return null; // Fallback: return null, continue to normal processing
        }

        // Update processedContent with imagePath and page from the mapping
        for (const item of preAnalysisResponse.processedContent) {
            const imageIndex = item.image_index || 0;
            const mapping = pageIndexToImage.get(imageIndex);
            if (mapping) {
                item.imagePath = mapping.imagePath;
                item.page = mapping.page;
            }
        }

        // Build PreAnalysisContext from response
        const context: PreAnalysisContext = {
            answers: preAnalysisResponse.answers,
            parseTarget: preAnalysisResponse.parseTarget,
            processedContent: preAnalysisResponse.processedContent,
            progressStatus: preAnalysisResponse.progressStatus
        };

        return context;
    }

    /**
     * Render only specific pages from a PDF for final processing
     * Used when pre-analysis already processed some pages
     */
    private async renderRemainingPdfPages(
        pdfFile: UniversalFile,
        remainingPages: number[],
        targetFolder: string,
        sharedNotice?: Notice
    ): Promise<UniversalFile[]> {
        const generatedImages: UniversalFile[] = [];
        let pdfDocument: any = null;

        try {
            let pdfData: Buffer;
            if (pdfFile.isExternal) {
                pdfData = fs.readFileSync(pdfFile.path);
            } else {
                const fileObj = this.app.vault.getAbstractFileByPath(pdfFile.path);
                if (fileObj instanceof TFile) {
                    pdfData = Buffer.from(await this.app.vault.readBinary(fileObj));
                } else {
                    return [];
                }
            }

            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(pdfData),
                disableFontFace: false
            });

            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            // Pre-analysis uses 2x scale, final render uses 4x scale
            const scale = 4.0;
            const progressNotice = sharedNotice;

            for (const preAnalysisIndex of remainingPages) {
                // Convert pre-analysis index (0-based) to PDF page number (1-based)
                const pdfPageNum = preAnalysisIndex + 1;
                
                if (pdfPageNum < 1 || pdfPageNum > numPages) continue;

                const page = await pdfDocument.getPage(pdfPageNum);
                const viewport = page.getViewport({ scale });

                const canvas = this.createCanvas(viewport.width, viewport.height);
                const context = canvas.getContext('2d', { alpha: false });

                if (!context) continue;

                await page.render({ canvasContext: context, viewport }).promise;

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');

                const originalName = path.basename(pdfFile.path, '.pdf').replace(/[^a-zA-Z0-9가-힣]/g, '_');
                const newFileName = `${Date.now()}_${originalName}_final_p${pdfPageNum}.png`;
                const newInternalPath = `${targetFolder}/${newFileName}`;

                const createdFile = await this.app.vault.createBinary(newInternalPath, buffer);

                generatedImages.push({
                    name: createdFile.name || createdFile.path?.split('/').pop() || newFileName,
                    path: createdFile.path || newInternalPath,
                    mtime: createdFile.stat?.mtime || Date.now(),
                    isExternal: false,
                    extension: 'png',
                    originalObject: createdFile
                });

                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }

            return generatedImages;

        } catch (error) {
            console.error("PDF render for remaining pages failed:", error);
            return [];
        } finally {
            if (pdfDocument) {
                try {
                    await pdfDocument.destroy();
                } catch (e) {
                    // Ignore destroy errors
                }
            }
        }
    }

    /**
     * Render PDF pages for Pre-Analysis (lower resolution than final processing)
     * Saves rendered pages to files and returns them with page numbers
     */
    private async renderPagesForPreAnalysis(
        pdfFile: UniversalFile,
        targetFolder: string
    ): Promise<{ page: RenderedPage; imagePath: string; pageNum: number }[]> {
        const results: { page: RenderedPage; imagePath: string; pageNum: number }[] = [];
        let pdfDocument: any = null;

        try {
            let pdfData: Buffer;
            if (pdfFile.isExternal) {
                pdfData = fs.readFileSync(pdfFile.path);
            } else {
                const fileObj = this.app.vault.getAbstractFileByPath(pdfFile.path);
                if (fileObj instanceof TFile) {
                    pdfData = Buffer.from(await this.app.vault.readBinary(fileObj));
                } else {
                    return [];
                }
            }

            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(pdfData),
                disableFontFace: false
            });

            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            // Use lower scale (2.0) for faster pre-analysis
            const scale = 2.0;

            for (let i = 0; i < numPages; i++) {
                const page = await pdfDocument.getPage(i + 1);
                const viewport = page.getViewport({ scale });

                const canvas = this.createCanvas(viewport.width, viewport.height);
                const context = canvas.getContext('2d', { alpha: false });

                if (!context) continue;

                await page.render({ canvasContext: context, viewport }).promise;

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

                // Save the rendered page to a file
                const originalName = path.basename(pdfFile.path, '.pdf').replace(/[^a-zA-Z0-9가-힣]/g, '_');
                const fileName = `${Date.now()}_${originalName}_pre_p${i + 1}.png`;
                const internalPath = `${targetFolder}/${fileName}`;
                
                const createdFile = await this.app.vault.createBinary(internalPath, Buffer.from(base64Data, 'base64'));

                results.push({
                    page: {
                        pageNumber: i,
                        imageData: base64Data,
                        mimeType: 'image/png'
                    },
                    imagePath: createdFile.path || internalPath,
                    pageNum: i + 1 // 1-based page number
                });

                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }

            return results;

        } catch (error) {
            console.error("PDF render for pre-analysis failed:", error);
            return [];
        } finally {
            if (pdfDocument) {
                try {
                    await pdfDocument.destroy();
                } catch (e) {
                    // Ignore destroy errors
                }
            }
        }
    }

    /**
     * Convert standalone image to PreAnalysisPage format
     */
    private async imageToPreAnalysisPage(
        imageFile: UniversalFile,
        pageNumber: number
    ): Promise<RenderedPage | null> {
        try {
            let base64Data = '';

            if (imageFile.isExternal) {
                const bitmap = fs.readFileSync(imageFile.path);
                base64Data = Buffer.from(bitmap).toString('base64');
            } else if (imageFile.originalObject) {
                const arrayBuffer = await this.app.vault.readBinary(imageFile.originalObject as TFile);
                base64Data = Buffer.from(arrayBuffer).toString('base64');
            } else {
                return null;
            }

            return {
                pageNumber,
                imageData: base64Data,
                mimeType: 'image/png'
            };
        } catch (error) {
            console.error("Image to pre-analysis page failed:", error);
            return null;
        }
    }

    async convertPdfToImages(pdfFile: UniversalFile, targetFolder: string, sharedNotice?: Notice): Promise<UniversalFile[]> {
        // Read binary helper for PDF service
        const readPdfBinary = async (): Promise<Buffer> => {
            if (pdfFile.isExternal) {
                return fs.readFileSync(pdfFile.path);
            } else {
                const data = await this.app.vault.readBinary(pdfFile.originalObject as TFile);
                return Buffer.from(data);
            }
        };

        // Create binary helper for PDF service
        const createBinary = async (filePath: string, data: Buffer): Promise<any> => {
            return await this.app.vault.createBinary(filePath, data);
        };

        return this.pdfService.convertToImages(
            pdfFile,
            targetFolder,
            createBinary,
            readPdfBinary,
            sharedNotice
        );
    }

    // 파일에 문제 저장
    async saveToMarkdown(items: ProblemItem[], targetPath: string) {
        // Read image binary helper for markdown service
        const readImageBinary = async (item: ProblemItem): Promise<Buffer> => {
            if (item.isExternal) {
                return fs.readFileSync(item.imagePath);
            } else {
                const fileObj = this.app.vault.getAbstractFileByPath(item.imagePath);
                if (fileObj instanceof TFile) {
                    return Buffer.from(await this.app.vault.readBinary(fileObj));
                } else {
                    throw new Error("내부 파일을 찾을 수 없음");
                }
            }
        };

        return this.markdownService.saveToMarkdown(
            items,
            targetPath,
            this.app.vault,
            this.settings.attachmentsPath || "CPA_Attachments",
            readImageBinary
        );
    }

    // PDF text extraction with hybrid OCR strategy
    async extractPdfText(pdfFile: UniversalFile): Promise<PdfTextContent> {
        await this.logger.log("PDF_TEXT_EXTRACTION_START", `텍스트 추출 시작: ${pdfFile.name}`);

        try {
            // Read PDF binary
            let pdfData: Buffer;
            if (pdfFile.isExternal) {
                pdfData = fs.readFileSync(pdfFile.path);
            } else {
                const fileObj = this.app.vault.getAbstractFileByPath(pdfFile.path);
                if (fileObj instanceof TFile) {
                    pdfData = Buffer.from(await this.app.vault.readBinary(fileObj));
                } else {
                    throw new Error(`내부 파일을 찾을 수 없음: ${pdfFile.path}`);
                }
            }

            // Step 1: Try pdf-parse for embedded text (native PDF)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pdfParseModule: any = await import('pdf-parse');
            const pdfParse = pdfParseModule.default;
            const result = await pdfParse(pdfData);
            const extractedText = result.text || '';

            if (extractedText.trim().length > 200) {
                // Native PDF - text extracted successfully
                await this.logger.log("PDF_TEXT_EXTRACTION_RESULT", `네이티브 PDF 감지. ${extractedText.length}자 추출 (pdf-parse)`);
                return {
                    fullText: extractedText,
                    pages: [{ pageNumber: 1, text: extractedText }],
                    answerSectionText: '',
                    questionSectionText: '',
                    isScanned: false,
                    extractionMethod: 'pdf-parse'
                };
            }

            // Step 2: Scanned PDF - need to use Gemini Vision OCR
            await this.logger.log("PDF_SCANNED_DETECTED", "네이티브 텍스트 없음. Gemini Vision OCR 사용", { fileName: pdfFile.name });

            // Render last 2 pages to images for OCR
            const lastPageImages = await this.renderPdfPagesToImages(pdfFile, -2);

            if (lastPageImages.length === 0) {
                throw new Error("PDF 페이지 이미지를 렌더링할 수 없음");
            }

            // Extract text from images using Gemini Vision
            let ocrText = '';
            for (let i = 0; i < lastPageImages.length; i++) {
                const imageFile = lastPageImages[i];
                if (!imageFile) continue;
                const pageText = await this.extractTextFromImage(imageFile);
                ocrText += `\n--- Page ${i + 1} ---\n${pageText}`;
            }

            await this.logger.log("PDF_TEXT_EXTRACTION_RESULT", `스캔 PDF 감지. OCR로 ${ocrText.length}자 추출 (gemini-vision)`);

            return {
                fullText: ocrText,
                pages: [],
                answerSectionText: ocrText,
                questionSectionText: '',
                isScanned: true,
                extractionMethod: 'gemini-vision'
            };

        } catch (error) {
            await this.logger.log("PDF_TEXT_EXTRACTION_ERROR", `텍스트 추출 실패: ${pdfFile.path}`, error);
            // Return empty content on failure - caller should handle fallback
            return {
                fullText: '',
                pages: [],
                answerSectionText: '',
                questionSectionText: '',
                isScanned: false,
                extractionMethod: 'pdf-parse'
            };
        }
    }

    /**
     * Render specific pages of a PDF to images for OCR.
     */
    private async renderPdfPagesToImages(pdfFile: UniversalFile, pageOffset: number): Promise<UniversalFile[]> {
        const generatedImages: UniversalFile[] = [];
        let pdfDocument: any = null;

        try {
            let pdfData: Buffer;
            if (pdfFile.isExternal) {
                pdfData = fs.readFileSync(pdfFile.path);
            } else {
                const fileObj = this.app.vault.getAbstractFileByPath(pdfFile.path);
                if (fileObj instanceof TFile) {
                    pdfData = Buffer.from(await this.app.vault.readBinary(fileObj));
                } else {
                    return [];
                }
            }

            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(pdfData),
                disableFontFace: false
            });

            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            // Determine which pages to render
            let pagesToRender: number[] = [];
            if (pageOffset < 0) {
                // Negative offset - render last N pages
                const count = Math.min(-pageOffset, numPages);
                for (let i = numPages - count; i < numPages; i++) {
                    pagesToRender.push(i + 1);
                }
            } else {
                pagesToRender.push(pageOffset + 1);
            }

            const targetFolder = this.settings.attachmentsPath || 'CPA_Attachments';

            for (const pageNum of pagesToRender) {
                const page = await pdfDocument.getPage(pageNum);
                const viewport = page.getViewport({ scale: 3.0 });

                const canvas = this.createCanvas(viewport.width, viewport.height);
                const context = canvas.getContext('2d', { alpha: false });

                if (!context) continue;

                await page.render({ canvasContext: context, viewport: viewport }).promise;

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');

                const originalName = pdfFile.path.split('/').pop()?.replace(/[^a-zA-Z0-9가-힣]/g, '_') || 'pdf';
                const newFileName = `${Date.now()}_${originalName}_ocr_p${pageNum}.png`;
                const newInternalPath = `${targetFolder}/${newFileName}`;

                const createdFile = await this.app.vault.createBinary(newInternalPath, buffer);

                generatedImages.push({
                    name: createdFile.name || createdFile.path?.split('/').pop() || newFileName,
                    path: createdFile.path || newInternalPath,
                    mtime: createdFile.stat?.mtime || Date.now(),
                    isExternal: false,
                    extension: 'png',
                    originalObject: createdFile
                });

                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }

            return generatedImages;

        } catch (error) {
            await this.logger.log("RENDER_PDF_TO_IMAGE_ERROR", "PDF 페이지 렌더링 실패", error);
            return [];
        } finally {
            if (pdfDocument) {
                try {
                    await pdfDocument.destroy();
                } catch (e) {
                    // Ignore destroy errors
                }
            }
        }
    }

    /**
     * Create a canvas element (browser or node compatible).
     */
    private createCanvas(width: number, height: number): any {
        try {
            const { createCanvas } = require('canvas');
            return createCanvas(width, height);
        } catch {
            if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
                return document.createElement('canvas');
            }
            return {
                width,
                height,
                getContext: () => null
            };
        }
    }

    /**
     * Extract text from an image using Gemini Vision OCR.
     */
    private async extractTextFromImage(imageFile: UniversalFile): Promise<string> {
        if (!this.genAI) {
            throw new Error('Gemini API Key가 설정되지 않았습니다.');
        }

        try {
            // Read image and convert to base64
            let base64Data = '';
            if (imageFile.isExternal) {
                const bitmap = fs.readFileSync(imageFile.path);
                base64Data = Buffer.from(bitmap).toString('base64');
            } else if (imageFile.originalObject) {
                const arrayBuffer = await this.app.vault.readBinary(imageFile.originalObject as TFile);
                base64Data = Buffer.from(arrayBuffer).toString('base64');
            } else {
                throw new Error('이미지 파일을 읽을 수 없음');
            }

            const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                OCR_TEXT_EXTRACTION_PROMPT,
                {
                    inlineData: {
                        data: base64Data,
                        mimeType: 'image/png'
                    }
                }
            ]);

            const text = result.response.text();
            await this.logger.log("IMAGE_OCR_RESULT", `${imageFile.name} OCR 완료`, { extractedLength: text.length });
            return text;

        } catch (error) {
            await this.logger.log("IMAGE_OCR_ERROR", `${imageFile.path} OCR 실패`, error);
            return '';
        }
    }

    /**
     * Parse answer key from extracted text using Gemini.
     */
    async parseAnswerKeyFromText(text: string): Promise<AnswerItem[]> {
        if (!this.genAI || !text.trim()) {
            return [];
        }

        try {
            const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                ANSWER_KEY_EXTRACTION_PROMPT,
                `Extracted text:\n${text}`
            ]);

            const response = result.response.text();
            await this.logger.log("ANSWER_KEY_DETECTION_START", `답안지 파싱 시작`, { textLength: text.length });

            // Parse JSON response
            let parsedData: AnswerItem[] = [];
            try {
                const clean = response.replace(/```json/g, '').replace(/```/g, '').trim();
                const start = clean.indexOf('[');
                const end = clean.lastIndexOf(']');
                if (start !== -1 && end !== -1) {
                    const jsonStr = clean.substring(start, end + 1);
                    parsedData = JSON.parse(jsonStr);
                }
            } catch (e) {
                await this.logger.log("ANSWER_KEY_PARSE_ERROR", `JSON 파싱 실패`, e);
            }

            await this.logger.log("ANSWER_KEY_DETECTION_RESULT", `${parsedData.length}개의 정답 찾음`, parsedData.slice(0, 5));
            return parsedData;

        } catch (error) {
            await this.logger.log("ANSWER_KEY_DETECTION_ERROR", `답안지 파싱 실패`, error);
            return [];
        }
    }

    /**
     * Parse explanations from extracted text using Gemini.
     */
    async parseExplanationsFromText(text: string): Promise<ExplanationItem[]> {
        if (!this.genAI || !text.trim()) {
            return [];
        }

        try {
            const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent([
                EXPLANATION_EXTRACTION_PROMPT,
                `Extracted text:\n${text}`
            ]);

            const response = result.response.text();
            await this.logger.log("EXPLANATION_EXTRACTION_START", `해설 추출 시작`, { textLength: text.length });

            // Parse JSON response
            let parsedData: ExplanationItem[] = [];
            try {
                const clean = response.replace(/```json/g, '').replace(/```/g, '').trim();
                const start = clean.indexOf('[');
                const end = clean.lastIndexOf(']');
                if (start !== -1 && end !== -1) {
                    const jsonStr = clean.substring(start, end + 1);
                    parsedData = JSON.parse(jsonStr);
                }
            } catch (e) {
                await this.logger.log("EXPLANATION_PARSE_ERROR", `JSON 파싱 실패`, e);
            }

            await this.logger.log("EXPLANATION_EXTRACTION_RESULT", `${parsedData.length}개의 해설 찾음`, parsedData.slice(0, 5));
            return parsedData;

        } catch (error) {
            await this.logger.log("EXPLANATION_EXTRACTION_ERROR", `해설 추출 실패`, error);
            return [];
        }
    }

    /**
     * Parse ParsedAnswers from PDF text content.
     * Combines answer key and explanation extraction.
     */
    async parseAnswersFromPdfContent(content: PdfTextContent): Promise<ParsedAnswers> {
        if (!content.answerSectionText && !content.fullText) {
            return {
                answerKey: [],
                explanations: [],
                sourceFormat: 'none'
            };
        }

        // Parse answer key
        const answerKey = await this.parseAnswerKeyFromText(content.answerSectionText || content.fullText);

        // Parse explanations
        const explanations = await this.parseExplanationsFromText(content.answerSectionText || content.fullText);

        // Determine format
        let sourceFormat: 'format1' | 'format2' | 'format3' | 'none' = 'none';
        if (answerKey.length > 0 && explanations.length > 0) {
            sourceFormat = 'format2';
        } else if (explanations.length > 0) {
            sourceFormat = 'format3';
        } else if (answerKey.length > 0) {
            sourceFormat = 'format1';
        }

        return {
            answerKey,
            explanations,
            sourceFormat
        };
    }

    // 테이블 수정 기능
    async fixTableFormatting(targetPath: string): Promise<void> {
        const tableService = new TableService(this.llmService, this.logger);
        await tableService.fixTableFormatting(targetPath, this.app);
    }

    // Settings 관리
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); if (this.settings.geminiApiKey) this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey); }
}
