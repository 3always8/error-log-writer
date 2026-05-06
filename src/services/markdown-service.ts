import { TFile } from 'obsidian';
import { ProblemItem } from '../types';
import { DebugLogger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Service for markdown file operations.
 * Handles saving problems to markdown, sanitizing content, and JSON parsing.
 */
export class MarkdownService {
    constructor(
        private logger: DebugLogger
    ) {}

    /**
     * Save extracted problems to a markdown file.
     * @param items - Array of problem items to save
     * @param targetPath - Path to the target markdown file
     * @param vault - Obsidian vault instance for file operations
     * @param attachmentsPath - Folder name for attachments
     * @param readImageBinary - Function to read image binary data
     */
    async saveToMarkdown(
        items: ProblemItem[],
        targetPath: string,
        vault: any,
        attachmentsPath: string,
        readImageBinary: (item: ProblemItem) => Promise<Buffer>
    ): Promise<void> {
        if (!targetPath || targetPath.trim() === "") targetPath = "CPA_Error_Log.md";
        if (!targetPath.endsWith(".md")) targetPath += ".md";

        const fileExists = await vault.adapter.exists(targetPath);
        const assetsFolder = attachmentsPath || "CPA_Attachments";
        if (!(await vault.adapter.exists(assetsFolder))) {
            await vault.createFolder(assetsFolder);
        }

        let chunk = "";
        let currentPath: string | null = null;

        for (const item of items) {
            const safeSubject = this.sanitizeForTable(item.subject || "기타");
            const safeAnswer = this.sanitizeForTable(item.answer || "");
            const safeSolution = this.sanitizeForTable(item.solution || "");
            const safeNumber = this.sanitizeForTable(item.number || "");
            const scrollableSolution = `<div class="cpa-solution cpa-text">${safeSolution}</div>`;

            // Add page number to remarks if available
            const pageRemark = item.page ? `P${item.page}` : '';
            const remarkColumn = pageRemark ? `${pageRemark}` : '';

            const showImage = (item.imagePath !== currentPath);
            currentPath = item.imagePath;

            let imgTag = "";
            if (showImage) {
                try {
                    let data: Buffer;
                    try {
                        data = await readImageBinary(item);
                    } catch {
                        // Fallback to synchronous read
                        data = fs.readFileSync(item.imagePath);
                    }

                    const originalName = path.basename(item.imagePath);
                    const safeName = originalName.replace(/[^a-zA-Z0-9가-힣.]/g, '_');
                    const newFileName = `${Date.now()}_${safeName}`;
                    const newInternalPath = `${assetsFolder}/${newFileName}`;

                    const createdFile = await vault.createBinary(newInternalPath, data);
                    imgTag = `![[${createdFile.path}]]`;

                    if (item.isExternal) {
                        try {
                            fs.unlinkSync(item.imagePath);
                        } catch (delErr) {
                            console.error(`원본 삭제 실패`, delErr);
                        }
                    }
                } catch (e) {
                    console.error("이미지 처리 실패:", e);
                    imgTag = `❌ 이미지 로드 실패`;
                }
            }
            chunk += `| ${safeSubject} | ${imgTag} | ${safeNumber}: ${safeAnswer} | ${scrollableSolution} |  ${remarkColumn} |\n`;
        }

        if (!fileExists) {
            const header = `---\ncssclasses: cpa-log\n---\n\n| 과목 | 문제 | 정답 | 풀이 | 비고 |\n|:---:|:---|:---|:---|:---|\n`;
            await vault.create(targetPath, header + chunk);
        } else {
            // Check if file exists (works for both Obsidian Vault and NodeVault)
            const file = vault.getAbstractFileByPath(targetPath);
            if (file || fileExists) {
                await vault.process(targetPath, (data: string) => data + chunk);
            }
        }
    }

    /**
     * Parse JSON from LLM response, handling common formatting issues.
     */
    parseRoughJson(text: string): any[] {
        let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const start = clean.indexOf('[');
        const end = clean.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error("JSON Array brackets not found");
        clean = clean.substring(start, end + 1);
        clean = clean.replace(/,(\s*\])/g, '$1');

        // Escape backslashes that aren't followed by quotes or other backslashes
        clean = clean.replace(/\\(?=[^\\"])/g, '\\\\');

        try {
            return JSON.parse(clean);
        } catch (e) {
            clean = clean.replace(/,\s*}/g, '}');
            return JSON.parse(clean);
        }
    }

    /**
     * Sanitize text for use in markdown tables.
     * Handles pipes, newlines, LaTeX, and special characters.
     */
    sanitizeForTable(text: string): string {
        if (!text) return "";

        let clean = text;

        // Remove code fence markers
        clean = clean.replace(/^```(json|markdown|text)?/i, '').replace(/```$/i, '');
        // Remove inline code markers
        clean = clean.replace(/^`/, '').replace(/`$/, '');
        // Escape pipe characters
        clean = clean.replace(/\|/g, '&#124;');

        // 1. [MATH] tag internal refinement
        clean = clean.replace(/\[MATH\]([\s\S]*?)\[\/MATH\]/g, (match, mathInner) => {
            // A. Replace newlines/spacers in math content with spaces
            let refined = mathInner.replace(/(\r\n|\n|\r|<br>|\\n)/gm, '  ');
            // B. Escape dollar signs (for amounts like $10,000)
            refined = refined.replace(/(?<!\\)\$/g, '\\$');
            // C. Replace asterisks with LaTeX multiplication
            refined = refined.replace(/\*/g, '\\times ');
            return `$${refined}$`;
        });

        // 2. Escape remaining dollar signs (always amounts at this point)
        clean = clean.replace(/(?<!\\)\$/g, '\\$');

        // 3. Replace regular newlines with <br> for table cells
        clean = clean.replace(/(\r\n|\n|\r)/gm, '<br>').replace(/\\n/g, '<br>');

        return clean.trim();
    }
}
