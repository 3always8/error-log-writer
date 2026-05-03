import { TFile } from 'obsidian';
import { ErrorLogSettings } from '../types';

/**
 * Debug logging utility for the CPA plugin.
 * Writes debug logs to a markdown file in the vault.
 */
export class DebugLogger {
    constructor(
        private settings: ErrorLogSettings,
        private vault: any
    ) {}

    /**
     * Write a debug log entry to the vault.
     * @param context - The context/category of the log
     * @param message - The log message
     * @param data - Optional additional data to include
     */
    async log(context: string, message: string, data: any = ""): Promise<void> {
        const logPath = this.settings.debugLogPath || 'CPA_Debug_Log.md';
        const timestamp = window.moment().format("YYYY-MM-DD HH:mm:ss");

        let dataString = "";
        if (data instanceof Error) {
            dataString = `${data.name}: ${data.message}\n${data.stack || ''}`;
        } else if (typeof data === 'object') {
            try {
                dataString = JSON.stringify(data, null, 2);
            } catch (e) {
                dataString = String(data);
            }
        } else {
            dataString = String(data);
        }

        const logEntry = `\n### [${timestamp}] ${context}\n- **Message**: ${message}\n- **Data**:\n\`\`\`text\n${dataString}\n\`\`\`\n`;

        try {
            const fileExists = await this.vault.adapter.exists(logPath);
            if (!fileExists) {
                await this.vault.create(logPath, `# 🐞 CPA Plugin Debug Log\n${logEntry}`);
            } else {
                const file = this.vault.getAbstractFileByPath(logPath);
                if (file instanceof TFile) {
                    await this.vault.process(file, (content: string) => content + logEntry);
                }
            }
            console.log(`[CPA Debug: ${context}]`, message);
        } catch (e) {
            console.error("Log write failed:", e);
        }
    }
}
