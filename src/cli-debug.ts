/**
 * CLI Debug Runner - Uses existing service classes for debugging.
 * 
 * This CLI entry point reuses all existing service classes:
 * - LLMService (src/services/llm-service.ts)
 * - MarkdownService (src/services/markdown-service.ts)
 * 
 * For PDF files, Gemini can process them directly (no PDF-to-image conversion needed).
 * For image files, they are sent directly to Gemini for processing.
 * 
 * Usage:
 *   npm run debug -- --input ./test.pdf --output ./output/result.md
 */

import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

// Import existing types
import { UniversalFile, ProblemItem } from './types';

// Import existing services
import { LLMService } from './services/llm-service';
import { MarkdownService } from './services/markdown-service';

// Import adapters
import { NodeLogger } from './adapters/node-logger';
import {
    readBinaryFile,
    writeFileSync,
    ensureDirectory,
    NodeVaultAdapter,
    NodeVault
} from './adapters/node-fs';

// Import CLI-compatible logger
import { CLIDebugLogger } from './utils/cli-logger';

/**
 * Parse command line arguments from process.argv.
 */
function parseArgs(args: string[]): {
    input?: string;
    output?: string;
    apiKey?: string;
    model?: string;
    help?: boolean;
} {
    const result: any = {};
    
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--input':
            case '-i':
                result.input = args[++i];
                break;
            case '--output':
            case '-o':
                result.output = args[++i];
                break;
            case '--api-key':
            case '-k':
                result.apiKey = args[++i];
                break;
            case '--model':
                result.model = args[++i];
                break;
            case '--help':
            case '-h':
                result.help = true;
                break;
        }
    }
    
    return result;
}

/**
 * Load .env file from project root or specified path.
 */
function loadEnv(): void {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const lines = envContent.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            
            const key = trimmed.substring(0, eqIndex).trim();
            const value = trimmed.substring(eqIndex + 1).trim();
            
            // Only set if not already in process.env
            if (!(key in process.env)) {
                process.env[key] = value;
            }
        }
    }
}

/**
 * Print CLI help message.
 */
function printHelp(): void {
    console.log(`
Error Log Writer CLI - Debug Runner
Uses existing service classes for PDF processing and LLM extraction.

Usage:
  npm run debug -- [options]

Options:
  --input, -i <path>      Input PDF or image file path (required)
  --output, -o <path>     Output markdown file path (default: output/error-log.md)
  --api-key, -k <key>     Gemini API key (overrides GEMINI_API_KEY env var)
  --model <name>          Gemini model name (default: gemini-2.0-flash)
  --help, -h              Show this help message

Examples:
  # Process a single PDF (sent directly to Gemini)
  npm run debug -- --input ./test-files/AUD1-Wiley_Module3.pdf

  # Process with custom output path
  npm run debug -- --input ./exam.pdf --output ./output/result.md

  # Process with explicit API key
  npm run debug -- --input ./exam.pdf -k "AIza..."

  # Process an image file
  npm run debug -- --input ./image.png --output ./output/result.md

Environment:
  GEMINI_API_KEY          Gemini API key (from .env file)
    `);
}

/**
 * Create a UniversalFile from a file path.
 */
function createUniversalFile(filePath: string): UniversalFile {
    const absolutePath = path.resolve(filePath);
    const ext = path.extname(absolutePath).replace('.', '').toLowerCase();
    
    return {
        name: path.basename(absolutePath),
        path: absolutePath,
        mtime: fs.statSync(absolutePath).mtime.getTime(),
        isExternal: true,
        extension: ext
    };
}

/**
 * Main CLI pipeline.
 */
async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    
    // Show help if requested
    if (args.help) {
        printHelp();
        return;
    }
    
    // Validate input
    if (!args.input) {
        console.error('Error: --input is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    // Load .env file
    loadEnv();
    
    // Get API key from args or environment
    const apiKey = args.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('Error: GEMINI_API_KEY is not set');
        console.error('Set it in .env file or use --api-key option');
        console.error('Get your API key from: https://aistudio.google.com/apikey');
        process.exit(1);
    }
    
    // Get model name
    const modelName = args.model || 'gemini-2.0-flash';
    
    // Set default output
    const outputPath = args.output || 'output/error-log.md';
    
    console.log('='.repeat(60));
    console.log('Error Log Writer CLI - Debug Runner');
    console.log('='.repeat(60));
    console.log(`Input: ${args.input}`);
    console.log(`Output: ${outputPath}`);
    console.log(`Model: ${modelName}`);
    console.log('');
    
    // Validate input file exists
    const inputPath = path.resolve(args.input);
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
    }
    
    // Initialize services (same as in main.ts:39-41)
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Create CLI vault for logger
    const baseDir = process.cwd();
    const cliVault = {
        adapter: {
            exists: (filePath: string) => require('fs').existsSync(path.join(baseDir, filePath)),
        },
        getAbstractFileByPath: () => null,
    };
    
    const cliLogger = new CLIDebugLogger({ debugLogPath: 'debug-log.md' }, cliVault);
    const llmService = new LLMService(genAI, modelName, cliLogger as any);
    const markdownService = new MarkdownService(cliLogger as any);
    
    const universalFile = createUniversalFile(inputPath);
    console.log(`File: ${universalFile.name} (${universalFile.extension})`);
    console.log('');
    
    // Setup output directories
    const outputDir = path.dirname(outputPath);
    ensureDirectory(outputPath);
    const normalizedOutputPath = path.resolve(outputDir);
    
    const attachmentsFolder = 'CPA_Attachments';
    
    try {
        // Step 1: Process input (PDF or Image)
        console.log('[Step 1] Preparing input file...');
        
        const fileExt = universalFile.extension.toLowerCase();
        
        if (fileExt === 'pdf') {
            // For PDF: Send directly to Gemini via LLMService
            // Gemini can process PDF files natively
            console.log('  PDF detected - sending directly to Gemini');
            
            // Create a special UniversalFile with PDF for direct processing
            const pdfUniversalFile: UniversalFile = {
                ...universalFile,
                extension: 'pdf'
            };
            
            // Use LLMService with PDF file
            // The LLMService will handle the PDF as inlineData with application/pdf mimeType
            const problems = await extractProblemsFromPdf(
                llmService,
                pdfUniversalFile,
                modelName,
                apiKey
            );
            
            if (!problems || problems.length === 0) {
                console.error('Error: No problems extracted from PDF');
                process.exit(1);
            }
            
            console.log(`  Extracted ${problems.length} problems`);
            console.log('');
            
            // Step 2: Save to markdown
            console.log('[Step 2] Saving to markdown...');
            
            const readItemBinary = async (item: ProblemItem): Promise<Buffer> => {
                return readBinaryFile(item.imagePath);
            };
            
            const adapter = new NodeVaultAdapter(normalizedOutputPath);
            const vault = new NodeVault(adapter);
            
            await markdownService.saveToMarkdown(
                problems,
                path.basename(outputPath),
                vault,
                attachmentsFolder,
                readItemBinary
            );
            
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(fileExt)) {
            // For images: Process normally
            console.log('  Image detected - processing normally');
            
            const processableFiles: UniversalFile[] = [universalFile];
            
            // Create readImageBinary callback for LLMService
            const readImageBinary = async (file: UniversalFile): Promise<string> => {
                const data = readBinaryFile(file.path);
                return Buffer.from(data).toString('base64');
            };
            
            console.log('[Step 2] Extracting problems via LLM...');
            
            const problems = await llmService.fetchProblemsFromLLM(
                processableFiles,
                readImageBinary
            );
            
            if (!problems || problems.length === 0) {
                console.error('Error: No problems extracted');
                console.error('Check the API key and try again.');
                process.exit(1);
            }
            
            console.log(`  Extracted ${problems.length} problems`);
            console.log('');
            
            // Step 3: Save to markdown
            console.log('[Step 3] Saving to markdown...');
            
            const readItemBinary = async (item: ProblemItem): Promise<Buffer> => {
                return readBinaryFile(item.imagePath);
            };
            
            const adapter = new NodeVaultAdapter(normalizedOutputPath);
            const vault = new NodeVault(adapter);
            
            await markdownService.saveToMarkdown(
                problems,
                path.basename(outputPath),
                vault,
                attachmentsFolder,
                readItemBinary
            );
            
        } else {
            console.error(`Error: Unsupported file type: ${fileExt}`);
            console.error('Supported types: PDF, PNG, JPG, JPEG, GIF, WEBP, BMP');
            process.exit(1);
        }
        
        console.log(`  Saved to: ${outputPath}`);
        console.log('');
        
        console.log('='.repeat(60));
        console.log('Done!');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('');
        console.error('Error during processing:');
        if (error instanceof Error) {
            console.error(`  ${error.message}`);
            if (error.stack) {
                console.error(`\nStack trace:`);
                console.error(error.stack);
            }
        } else {
            console.error(error);
        }
        
        process.exit(1);
    }
}

/**
 * Extract problems directly from PDF using Gemini's native PDF support.
 * Gemini can process PDF files directly without conversion to images.
 */
async function extractProblemsFromPdf(
    llmService: LLMService,
    pdfFile: UniversalFile,
    modelName: string,
    apiKey: string
): Promise<ProblemItem[] | null> {
    // Read PDF file
    const pdfBuffer = readBinaryFile(pdfFile.path);
    const base64Pdf = pdfBuffer.toString('base64');
    
    console.log('  Preparing PDF for Gemini API...');
    
    // Create Gemini API request directly
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    
    // Prepare prompt for problem extraction
    const prompt = `
You are a **CPA Exam Grader**.

I will provide a PDF file of a CPA exam. Each page contains multiple-choice questions.

Your task:
1. Identify ALL problems in the PDF
2. Solve each problem independently
3. Return results as a single JSON Array

[CRITICAL INSTRUCTIONS]
1. **Ignore student markings**: Circles, checks, notes are student traces - IGNORE them
2. **Solve independently**: Read each problem and derive the TRUE correct answer
3. **Step by Step**: Provide complete solution steps without skipping logic
4. **Multiple choice**: Find the correct answer among choices

[Output Format]
Return ONLY a raw JSON Array (no code blocks):

[
  {
    "subject": "과목명 > 단원명 (예: 재무회계 > 재고자산)",
    "number": "문제 번호 (예: 41번)",
    "solution": "한국어로 된 상세 풀이 (줄바꿈은 <br> 사용)",
    "answer": "정답 (예: A. $700)"
  }
]

[Critical Symbol Rules]
1. Use <br> for line breaks (NO \\n)
2. NEVER use | (pipe) character - use &#124; if needed
3. Use $ only for monetary amounts (e.g., $50,000)
4. Use "x" for multiplication, "/" for division
`;
    
    console.log('  Sending PDF to Gemini API...');
    
    const pdfPart = {
        inlineData: {
            data: base64Pdf,
            mimeType: 'application/pdf'
        }
    };
    
    const result = await model.generateContent([prompt, pdfPart]);
    const response = result.response.text();
    
    console.log('  Response received, parsing JSON...');
    console.log('  Raw response length:', response.length);
    
    // Save raw response for debugging
    const debugPath = path.join(process.cwd(), 'debug-response.txt');
    fs.writeFileSync(debugPath, response);
    console.log('  Raw response saved to:', debugPath);
    
    // Parse JSON response (reuse parseRoughJson logic from MarkdownService)
    const parsed = parseRoughJson(response);
    
    if (!Array.isArray(parsed)) {
        console.error('Error: Response is not a valid JSON array');
        console.error('Raw response:', response);
        return null;
    }
    
    // Map parsed results to ProblemItem array
    // Since we're sending PDF directly, we don't have image paths
    // We'll store the PDF path as the image reference
    const problems: ProblemItem[] = parsed.map((item: any, index: number) => ({
        subject: item.subject || '기타',
        answer: item.answer || '',
        number: item.number || '',
        solution: item.solution || '',
        imagePath: pdfFile.path,  // Reference to PDF file
        isExternal: true,
        image_index: index
    }));
    
    return problems;
}

/**
 * Parse JSON from LLM response, handling common formatting issues.
 * Reused from MarkdownService.parseRoughJson
 */
function parseRoughJson(text: string): any[] {
    let clean = text.trim();
    
    // Remove markdown code blocks (```json ... ``` or just ```)
    clean = clean.replace(/^```json\s*/i, '');
    clean = clean.replace(/^```\s*/i, '');
    clean = clean.replace(/\s*```\s*$/g, '');
    clean = clean.trim();
    
    const start = clean.indexOf('[');
    if (start === -1) {
        throw new Error("JSON Array bracket not found");
    }
    
    // Find the matching closing bracket by counting nested brackets
    let bracketCount = 0;
    let end = -1;
    for (let i = start; i < clean.length; i++) {
        if (clean[i] === '[') bracketCount++;
        if (clean[i] === ']') {
            bracketCount--;
            if (bracketCount === 0) {
                end = i;
                break;
            }
        }
    }
    
    if (end === -1) {
        // Response may be truncated - try to use what we have and add closing bracket
        console.log('  Warning: Could not find matching ] bracket, trying to fix...');
        end = clean.length - 1;
        // Remove any trailing text after the last complete object
        if (clean.endsWith(',')) {
            clean = clean.slice(0, -1);
        }
        // Add closing bracket
        clean = clean + ']';
    }
    
    let jsonStr = clean.substring(start, end + 1);
    console.log('  Extracted JSON length:', jsonStr.length);
    
    // Fix trailing commas before closing brackets
    jsonStr = jsonStr.replace(/,(\s*\])/g, '$1');
    
    // Fix unterminated strings at the end (truncated response)
    // Find the last complete JSON object in the array
    const lastObjectMatch = jsonStr.match(/\{\s*"subject"[^}]*\}/g);
    if (lastObjectMatch) {
        // Rebuild JSON from complete objects only
        const completeObjects: string[] = [];
        for (const obj of lastObjectMatch) {
            // Check if object has closing brace
            if (obj.includes('}')) {
                // Find the actual closing brace position
                const lastBrace = obj.lastIndexOf('}');
                const completeObj = obj.substring(0, lastBrace + 1);
                completeObjects.push(completeObj);
            }
        }
        
        if (completeObjects.length > 0) {
            console.log(`  Found ${completeObjects.length} complete objects, rebuilding JSON...`);
            jsonStr = '[' + completeObjects.join(',') + ']';
        }
    }
    
    // Escape backslashes that aren't followed by quotes or other backslashes
    jsonStr = jsonStr.replace(/\\(?=[^\\"])/g, '\\\\');
    
    try {
        const parsed = JSON.parse(jsonStr);
        console.log('  JSON parse successful, array length:', Array.isArray(parsed) ? parsed.length : 'N/A');
        return parsed;
    } catch (e) {
        console.error('  JSON parse failed, trying with additional fixes...');
        // Try to extract all complete objects using regex
        const objectRegex = /\{\s*"subject"\s*:\s*"[^"]*"[^}]*\}/g;
        const matches = jsonStr.match(objectRegex);
        if (matches && matches.length > 0) {
            console.log(`  Extracted ${matches.length} objects using regex`);
            jsonStr = '[' + matches.join(',') + ']';
            return JSON.parse(jsonStr);
        }
        jsonStr = jsonStr.replace(/,\s*}/g, '}');
        jsonStr = jsonStr.replace(/,\s*]/g, ']');
        return JSON.parse(jsonStr);
    }
}

// Run CLI
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
