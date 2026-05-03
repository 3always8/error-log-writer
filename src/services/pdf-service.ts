import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
import { UniversalFile } from '../types';
import { DebugLogger } from '../utils/logger';
import { TFile } from 'obsidian';
import * as path from 'path';

/**
 * Service for PDF rendering and image conversion.
 * Handles high-quality PDF-to-image conversion with memory management.
 */
export class PDFService {
    constructor(
        private logger: DebugLogger
    ) {}

    /**
     * Convert a PDF file to high-quality PNG images (one per page).
     * @param pdfFile - The universal file representing the PDF
     * @param targetFolder - The folder to save images to (internal vault path or external)
     * @param createBinary - Function to create a binary file in the vault
     * @param readPdfBinary - Function to read binary data for the PDF
     * @param sharedNotice - Optional notice object for progress updates
     * @returns Array of generated image files
     */
    async convertToImages(
        pdfFile: UniversalFile,
        targetFolder: string,
        createBinary: (path: string, data: Buffer) => Promise<any>,
        readPdfBinary: () => Promise<Buffer> | Buffer,
        sharedNotice?: { setMessage: (msg: string) => void; hide: () => void }
    ): Promise<UniversalFile[]> {
        await this.logger.log("PDF_CONVERT_START", `정밀 렌더링 엔진 가동: ${pdfFile.name}`);

        const generatedImages: UniversalFile[] = [];
        let pdfDocument: any = null;

        let progressNotice: { setMessage: (msg: string) => void; hide: () => void };
        if (sharedNotice) {
            progressNotice = sharedNotice;
            progressNotice.setMessage(`PDF 고화질 변환 중입니다... (${pdfFile.name})`);
        } else {
            const mockNotice = {
                setMessage: (msg: string) => console.log(`[PDF Progress] ${msg}`),
                hide: () => {}
            };
            progressNotice = mockNotice;
        }

        try {
            let data: Buffer | ArrayBuffer;
            try {
                const result = await readPdfBinary();
                data = Buffer.isBuffer(result) ? result : Buffer.from(result);
            } catch (readError) {
                // Try synchronous read as fallback
                try {
                    const syncResult = readPdfBinary();
                    if (Buffer.isBuffer(syncResult)) {
                        data = syncResult;
                    } else {
                        throw new Error("Failed to read PDF data");
                    }
                } catch (syncError) {
                    throw new Error(`Failed to read PDF: ${pdfFile.path}`);
                }
            }

            if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
            }

            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(data as ArrayBuffer),
                disableFontFace: false
            });

            pdfDocument = await loadingTask.promise;
            const numPages = pdfDocument.numPages;

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);

                // High quality rendering: scale at 4.0 for preserving math formulas and small text
                const viewport = page.getViewport({ scale: 4.0 });

                // Create canvas for rendering
                const canvas = this.createCanvas(viewport.width, viewport.height);
                const context = canvas.getContext('2d', { alpha: false });

                if (!context) {
                    throw new Error("Canvas Context 생성 실패");
                }

                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };

                try {
                    await page.render(renderContext).promise;
                } catch (renderErr) {
                    await this.logger.log("RENDER_TASK_ERROR", `페이지 ${pageNum} 렌더링 실패`, renderErr);
                    page.cleanup();
                    continue;
                }

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
                const buffer = Buffer.from(base64Data, 'base64');

                const originalName = path.basename(pdfFile.path, '.pdf').replace(/[^a-zA-Z0-9가-힣]/g, '_');
                const newFileName = `${Date.now()}_${originalName}_p${pageNum}.png`;
                const newInternalPath = `${targetFolder}/${newFileName}`;

                const createdFile = await createBinary(newInternalPath, buffer);

                generatedImages.push({
                    name: createdFile.name || createdFile.path?.split('/').pop() || newFileName,
                    path: createdFile.path || newInternalPath,
                    mtime: createdFile.stat?.mtime || Date.now(),
                    isExternal: false,
                    extension: 'png',
                    originalObject: createdFile
                });

                // Free memory: clear canvas and cleanup PDF page
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }

            await this.logger.log("PDF_CONVERT_SUCCESS", `성공적으로 ${generatedImages.length}개 이미지 생성`);
            return generatedImages;

        } catch (error) {
            await this.logger.log("PDF_CONVERT_FATAL", `PDF 처리 파이프라인 붕괴`, error);

            if (sharedNotice) {
                sharedNotice.setMessage(`❌ PDF 변환 실패: ${pdfFile.name}`);
            } else {
                console.error(`PDF 변환 실패: ${pdfFile.name}`, error);
            }

            return [];
        } finally {
            // Destroy PDF document to free all worker resources
            if (pdfDocument) {
                try {
                    await pdfDocument.destroy();
                } catch (e) {
                    await this.logger.log("PDF_DESTROY_ERROR", `문서 객체 파기 중 오류 발생`, e);
                }
            }
        }
    }

    /**
     * Create a canvas element (browser or node compatible).
     */
    private createCanvas(width: number, height: number): any {
        // Try to use canvas module (available in Node.js via canvas package)
        try {
            const { createCanvas } = require('canvas');
            return createCanvas(width, height);
        } catch {
            // Browser environment - create DOM canvas
            if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
                return document.createElement('canvas');
            }
            // Fallback: minimal canvas-like object
            return {
                width,
                height,
                getContext: () => null
            };
        }
    }
}
