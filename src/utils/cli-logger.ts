import * as fs from 'fs';
import * as path from 'path';

/**
 * Partial settings type for CLI logger.
 */
interface CLILoggerSettings {
    debugLogPath?: string;
}

/**
 * CLI-compatible Debug logging utility.
 * Writes debug logs to a markdown file in the current working directory.
 * This is a Node.js alternative to the Obsidian-based DebugLogger.
 */
export class CLIDebugLogger {
    private settings: CLILoggerSettings;
    private vault: any;

    constructor(
        settings: CLILoggerSettings,
        vault: any
    ) {
        this.settings = settings;
        this.vault = vault;
    }

    /**
     * Write a debug log entry to the vault.
     * @param context - The context/category of the log
     * @param message - The log message
     * @param data - Optional additional data to include
     */
    async log(context: string, message: string, data: any = ""): Promise<void> {
        const logPath = this.settings.debugLogPath || 'CPA_Debug_Log.md';
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

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
                if (file || fileExists) {
                    await this.vault.process(logPath, (content: string) => content + logEntry);
                }
            }
            console.log(`[CPA Debug: ${context}]`, message);
        } catch (e) {
            console.error("Log write failed:", e);
        }
    }
}
