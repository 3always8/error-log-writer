import * as fs from 'fs';
import * as path from 'path';

/**
 * Node.js filesystem helper functions for CLI usage.
 * Provides file I/O operations to replace Obsidian vault APIs.
 */

/**
 * Read a binary file from the filesystem.
 * @param filePath - Path to the file
 * @returns Buffer containing file contents
 */
export function readBinaryFile(filePath: string): Buffer {
    return fs.readFileSync(filePath);
}

/**
 * Read a text file from the filesystem.
 * @param filePath - Path to the file
 * @returns String containing file contents
 */
export function readTextFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Write content to a file, creating directories if needed.
 * @param filePath - Path to the file
 * @param content - Content to write
 */
export function writeFileSync(filePath: string, content: string): void {
    ensureDirectory(filePath);
    fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Write binary data to a file, creating directories if needed.
 * @param filePath - Path to the file
 * @param data - Buffer to write
 * @param fileName - Display name (for logging)
 */
export function writeBinaryFile(filePath: string, data: Buffer, fileName?: string): string {
    ensureDirectory(filePath);
    fs.writeFileSync(filePath, data);
    return filePath;
}

/**
 * Ensure the directory for a file path exists.
 * @param filePath - Path to create directories for
 */
export function ensureDirectory(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Check if a file exists.
 * @param filePath - Path to check
 * @returns true if file exists
 */
export function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

/**
 * Recursively find all files with given extensions in a directory.
 * @param dir - Directory to scan
 * @param extensions - Array of extensions to find (e.g., ['.pdf', '.png'])
 * @returns Array of file paths
 */
export function findFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    
    if (!fs.existsSync(dir)) {
        return results;
    }

    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
            results.push(...findFiles(fullPath, extensions));
        } else {
            const ext = path.extname(item.name).toLowerCase();
            if (extensions.includes(ext)) {
                results.push(fullPath);
            }
        }
    }

    return results;
}

/**
 * Get file modification time as timestamp.
 * @param filePath - Path to the file
 * @returns Modification time as timestamp
 */
export function getFileMtime(filePath: string): number {
    return fs.statSync(filePath).mtime.getTime();
}

/**
 * Get file extension (lowercase, without dot).
 * @param filePath - Path to the file
 * @returns Extension without dot
 */
export function getFileExtension(filePath: string): string {
    return path.extname(filePath).replace('.', '').toLowerCase();
}

/**
 * Get file basename without extension.
 * @param filePath - Path to the file
 * @returns Filename without extension
 */
export function getBasename(filePath: string): string {
    return path.basename(filePath, path.extname(filePath));
}

/**
 * Get just the filename with extension.
 * @param filePath - Path to the file
 * @returns Filename
 */
export function getFilename(filePath: string): string {
    return path.basename(filePath);
}

/**
  * NodeVault wraps NodeVaultAdapter methods on an `adapter` property
  * to match Obsidian's Vault interface (vault.adapter.exists(), etc.)
  */
export class NodeVault {
    adapter: {
        exists: (filePath: string) => boolean | Promise<boolean>;
        read: (filePath: string) => Promise<string>;
        write: (filePath: string, content: string) => Promise<void>;
        createFolder: (folderPath: string) => Promise<void>;
        createBinary: (filePath: string, data: Buffer) => Promise<{ path: string }>;
        getAbstractFileByPath: (filePath: string) => any;
        process: (filePath: string, callback: (data: string) => string) => Promise<void>;
    };

    constructor(adapter: NodeVaultAdapter) {
        this.adapter = {
            exists: (filePath: string) => adapter.exists(filePath),
            read: (filePath: string) => adapter.read(filePath),
            write: (filePath: string, content: string) => adapter.write(filePath, content),
            createFolder: (folderPath: string) => adapter.createFolder(folderPath),
            createBinary: (filePath: string, data: Buffer) => adapter.createBinary(filePath, data),
            getAbstractFileByPath: (filePath: string) => adapter.getAbstractFileByPath(filePath),
            process: (filePath: string, callback: (data: string) => string) => adapter.process(filePath, callback),
        };
    }

    async create(filePath: string, content: string): Promise<void> {
        return this.adapter.write(filePath, content);
    }

    async createBinary(filePath: string, data: Buffer): Promise<{ path: string }> {
        return this.adapter.createBinary(filePath, data);
    }

    async createFolder(folderPath: string): Promise<void> {
        return this.adapter.createFolder(folderPath);
    }

    getAbstractFileByPath(filePath: string): any {
        return this.adapter.getAbstractFileByPath(filePath);
    }

    async process(filePath: string, callback: (data: string) => string): Promise<void> {
        return this.adapter.process(filePath, callback);
    }
}

/**
  * Simple vault-like adapter for MarkdownService.saveToMarkdown.
  * Provides the interface expected by MarkdownService.
  */
 export class NodeVaultAdapter {
     private baseDir: string;

     constructor(baseDir: string = process.cwd()) {
         this.baseDir = baseDir;
     }

     exists(filePath: string): boolean {
         return fs.existsSync(path.join(this.baseDir, filePath));
     }

     async create(filePath: string, content: string): Promise<void> {
         const fullPath = path.join(this.baseDir, filePath);
         ensureDirectory(fullPath);
         fs.writeFileSync(fullPath, content, 'utf-8');
     }

     async createBinary(filePath: string, data: Buffer): Promise<{ path: string }> {
         const fullPath = path.join(this.baseDir, filePath);
         ensureDirectory(fullPath);
         fs.writeFileSync(fullPath, data);
         return { path: filePath };
     }

     getAbstractFileByPath(filePath: string): any {
         const fullPath = path.join(this.baseDir, filePath);
         if (fs.existsSync(fullPath)) {
             return { path: filePath };
         }
         return null;
     }

     async createFolder(folderPath: string): Promise<void> {
         const fullPath = path.join(this.baseDir, folderPath);
         fs.mkdirSync(fullPath, { recursive: true });
     }

     async read(filePath: string): Promise<string> {
         const fullPath = path.join(this.baseDir, filePath);
         return fs.readFileSync(fullPath, 'utf-8');
     }

     async write(filePath: string, content: string): Promise<void> {
         const fullPath = path.join(this.baseDir, filePath);
         ensureDirectory(fullPath);
         fs.writeFileSync(fullPath, content, 'utf-8');
     }

     async process(filePath: string, callback: (data: string) => string): Promise<void> {
         const fullPath = path.join(this.baseDir, filePath);
         const currentContent = fs.readFileSync(fullPath, 'utf-8');
         const newContent = callback(currentContent);
         fs.writeFileSync(fullPath, newContent, 'utf-8');
     }
 }
