/**
 * Console-based logger adapter for CLI usage.
 * Replaces DebugLogger from src/utils/logger.ts for CLI context.
 * Provides the same log() interface but outputs to console instead of vault file.
 */
export class NodeLogger {
    private logFile: string;

    constructor(logFile: string = 'debug-log.md') {
        this.logFile = logFile;
    }

    /**
     * Log a message to console and optionally to a debug file.
     * @param context - The context/category of the log
     * @param message - The log message
     * @param data - Optional additional data to include
     */
    async log(context: string, message: string, data: any = ""): Promise<void> {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] ${context}`;

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

        const logEntry = `\n### ${prefix}\n- **Message**: ${message}\n- **Data**:\n\`\`\`text\n${dataString}\n\`\`\`\n`;

        // Write to console
        console.log(`[DEBUG:${context}] ${message}`);
        if (dataString) {
            console.log(dataString);
        }
    }

    /**
     * Log an error message.
     */
    async error(context: string, message: string, data: any = undefined): Promise<void> {
        const timestamp = new Date().toISOString();
        console.error(`[ERROR:${timestamp}] ${context}: ${message}`);
        if (data !== undefined) {
            console.error(data);
        }
    }

    /**
     * Log a progress message.
     */
    progress(message: string): void {
        console.log(`[PROGRESS] ${message}`);
    }
}

/**
 * Simple notice implementation for compatibility with PDFService.
 * Mimics the Obsidian Notice interface.
 */
export class SimpleNotice {
    private message: string = '';

    constructor(private maxDisplayTime = 5000) {}

    setMessage(msg: string): void {
        this.message = msg;
        console.log(`[PROGRESS] ${msg}`);
    }

    hide(): void {
        // No-op for CLI
    }
}
