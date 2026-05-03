import { TFile } from 'obsidian';
import { LLMService } from './llm-service';
import { DebugLogger } from '../utils/logger';

/**
 * Service for markdown table fixing operations.
 * Handles table extraction, validation, and LLM-based structure repair.
 */
export class TableService {
    constructor(
        private llmService: LLMService,
        private logger: DebugLogger
    ) {}

    /**
     * Fix table formatting in a markdown file using LLM assistance.
     * @param targetPath - Path to the target markdown file
     * @param app - Obsidian app instance for file operations
     */
    async fixTableFormatting(
        targetPath: string,
        app: any
    ): Promise<void> {
        const progressNotice = { setMessage: (msg: string) => console.log(`[Table Fix] ${msg}`), hide: () => {} };

        try {
            const file = app.vault.getAbstractFileByPath(targetPath);
            if (!(file instanceof TFile)) {
                if (progressNotice.hide) progressNotice.hide();
                new (require('obsidian').Notice || ((msg: string) => console.log(msg)))(`파일을 찾을 수 없습니다: ${targetPath}`, 5000);
                return;
            }

            const originalContent = await app.vault.read(file);

            if (!this.containsMarkdownTable(originalContent)) {
                if (progressNotice.hide) progressNotice.hide();
                new (require('obsidian').Notice || ((msg: string) => console.log(msg)))('이 파일에는 마크다운 테이블이 없습니다.', 5000);
                return;
            }

            // Create backup
            const backupPath = targetPath.replace(/\.md$/, '_backup.md');
            if (progressNotice.setMessage) progressNotice.setMessage('백업 파일 생성 중...');

            const backupExists = await app.vault.adapter.exists(backupPath);
            if (backupExists) {
                const backupFile = app.vault.getAbstractFileByPath(backupPath);
                if (backupFile instanceof TFile) {
                    await app.vault.modify(backupFile, originalContent);
                }
            } else {
                await app.vault.create(backupPath, originalContent);
            }
            await this.logger.log("TABLE_FIX_BACKUP", `백업 생성: ${backupPath}`);

            // Extract table blocks
            const tableBlocks = this.extractTableBlocks(originalContent);
            if (tableBlocks.length === 0) {
                if (progressNotice.hide) progressNotice.hide();
                new (require('obsidian').Notice || ((msg: string) => console.log(msg)))('테이블 블록을 추출할 수 없습니다.', 5000);
                return;
            }

            let result = originalContent;
            let offset = 0;
            let fixedCount = 0;
            let skippedCount = 0;

            for (let i = 0; i < tableBlocks.length; i++) {
                const block = tableBlocks[i]!;
                if (progressNotice.setMessage) progressNotice.setMessage(`테이블 ${i + 1}/${tableBlocks.length} 수정 중...`);

                const fixedTable = await this.llmService.fixTableViaLLM(block.text);

                // Row count validation: reject if less than 80% of original
                const originalRows = block.text.split('\n').filter(l => l.trim().startsWith('|')).length;
                const fixedRows = fixedTable.split('\n').filter(l => l.trim().startsWith('|')).length;

                if (fixedRows < originalRows * 0.8) {
                    await this.logger.log("TABLE_FIX_REJECTED", `테이블 ${i + 1}: 행 수 검증 실패 (원본 ${originalRows}행 → 응답 ${fixedRows}행). 원본 유지.`);
                    skippedCount++;
                    continue;
                }

                const adjustedStart = block.start + offset;
                const adjustedEnd = block.end + offset;
                result = result.substring(0, adjustedStart) + fixedTable + result.substring(adjustedEnd);
                offset += fixedTable.length - block.text.length;
                fixedCount++;

                if (i < tableBlocks.length - 1) {
                    if (progressNotice.setMessage) progressNotice.setMessage(`API 쿨타임 대기 중... (${i + 1}/${tableBlocks.length})`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (result === originalContent) {
                if (progressNotice.hide) progressNotice.hide();
                new (require('obsidian').Notice || ((msg: string) => console.log(msg)))('테이블 구조에 문제가 없습니다. 수정 사항 없음.', 5000);
                return;
            }

            if (progressNotice.setMessage) progressNotice.setMessage('수정된 내용을 저장하는 중...');
            await app.vault.modify(file, result);

            if (progressNotice.hide) progressNotice.hide();
            let msg = `테이블 수정 완료! (${fixedCount}개 수정`;
            if (skippedCount > 0) msg += `, ${skippedCount}개 검증 실패로 건너뜀`;
            msg += `)`;
            new (require('obsidian').Notice || ((msg: string) => console.log(msg)))(msg, 5000);

            // Open/focus the file
            const leaves = app.workspace.getLeavesOfType('markdown');
            const existingLeaf = leaves.find((leaf: any) => {
                const view = leaf.view as any;
                return view.file && view.file.path === file.path;
            });
            if (existingLeaf) {
                app.workspace.setActiveLeaf(existingLeaf, { focus: true });
            } else {
                await app.workspace.getLeaf('tab').openFile(file);
            }

        } catch (error: unknown) {
            if (progressNotice.hide) progressNotice.hide();
            let errorMessage = "알 수 없는 오류가 발생했습니다.";
            if (error instanceof Error) errorMessage = error.message;
            else if (typeof error === "string") errorMessage = error;
            else errorMessage = String(error);

            new (require('obsidian').Notice || ((msg: string) => console.log(msg)))(`테이블 수정 중 오류 발생: ${errorMessage}`, 10000);
            console.error("Table Fix Error:", error);
            await this.logger.log("TABLE_FIX_ERROR", `테이블 수정 실패`, error);
        }
    }

    /**
     * Extract table blocks from markdown content.
     */
    extractTableBlocks(content: string): Array<{ start: number; end: number; text: string }> {
        const lines = content.split('\n');
        const blocks: Array<{ start: number; end: number; text: string }> = [];
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
                    end: charPos - 1,
                    text: content.substring(tableStart, charPos - 1)
                });
                tableStart = -1;
            }

            charPos += line.length + 1; // +1 for \n
        }

        // Handle case where file ends with a table
        if (tableStart !== -1) {
            blocks.push({
                start: tableStart,
                end: content.length,
                text: content.substring(tableStart)
            });
        }

        return blocks;
    }

    /**
     * Check if content contains a markdown table.
     */
    containsMarkdownTable(content: string): boolean {
        return /^\|.+\|$/m.test(content);
    }
}
