import { TFile } from 'obsidian';

export interface ErrorLogSettings {
    geminiApiKey: string;
    lastUsedPath: string;
    modelName: string;
    imageSourcePath: string;
    attachmentsPath: string;
    debugLogPath: string;
}

export const DEFAULT_SETTINGS: ErrorLogSettings = {
    geminiApiKey: '',
    lastUsedPath: 'CPA_Error_Log.md',
    modelName: 'gemini-2.0-flash',
    imageSourcePath: '',
    attachmentsPath: 'CPA_Attachments',
    debugLogPath: 'CPA_Debug_Log.md'
}

export const DEFAULT_MODELS: Record<string, string> = {
    'gemini-2.0-flash': 'Gemini 2.0 Flash',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    'gemini-1.5-pro': 'Gemini 1.5 Pro'
};

export interface UniversalFile {
    name: string;
    path: string;
    mtime: number;
    isExternal: boolean;
    extension: string;
    originalObject?: TFile;
}

// NEW: Data structures for answer key and explanation extraction
export interface AnswerItem {
    number: string;    // Problem number (e.g., "1", "41", "Question 1")
    answer: string;    // Answer (e.g., "A", "B", "D")
}

export interface ExplanationItem {
    number: string;    // Problem number (e.g., "1", "41", "Question 1")
    explanation: string; // Full explanation text
    answer?: string;   // Optional: the correct answer from explanation
}

export interface ParsedAnswers {
    answerKey: AnswerItem[];       // Direct answer key (e.g., [{number: "1", answer: "A"}])
    explanations: ExplanationItem[]; // Detailed explanations per problem
    sourceFormat: 'format1' | 'format2' | 'format3' | 'none';
}

export interface PdfTextContent {
    fullText: string;           // All text from PDF
    pages: PdfPageText[];       // Text per page
    answerSectionText: string;  // Text from answer/explanation section
    questionSectionText: string; // Text from question section
    isScanned: boolean;         // Whether PDF was scanned (required OCR)
    extractionMethod: 'pdf-parse' | 'gemini-vision' | 'hybrid';
}

export interface PdfPageText {
    pageNumber: number;
    text: string;
}

export interface ProblemItem {
    subject: string;
    answer: string;
    number: string;
    solution: string;
    imagePath: string;
    isExternal: boolean;
    image_index?: number; // Batch 처리용 인덱스
    page?: number;        // PDF page number (1-based) for tracking
    // NEW: Reference to parsed answer key
    expectedAnswer?: string;       // From PDF answer key, if available
    // NEW: Reference to parsed explanation
    referenceExplanation?: string; // From PDF explanation, if available
}

// ===== Pre-Analysis Types (Step 4.5) =====

/**
 * Progress status with sequential page numbers
 * Used to track which pages were processed in pre-analysis
 */
export interface ProgressStatus {
    done: number[];               // Sequential page indices already processed (e.g., [0, 1, 2])
    remaining: number[];          // Sequential page indices still need processing (e.g., [3, 4, 5])
    description: string;          // Human-readable description (e.g., "question pages")
}

/**
 * Determines what content was found and how to parse it
 */
export type ParseTarget = 'explanation-pages' | 'question-pages' | 'both' | 'none';

/**
 * Response from the Pre-Analysis Gemini Call (Step 4.5)
 * Received raw binary/images, returns structured pre-analysis
 */
export interface PreAnalysisResponse {
    answers: AnswerItem[];                    // Extracted answers (e.g., [{number: "1", answer: "A"}])
    parseTarget: ParseTarget;                 // What type of content was found
    processedContent: ProblemItem[];          // ProblemItems if explanation-pages found (CPA_GRADER_BATCH_PROMPT format)
    progressStatus: ProgressStatus;           // Progress with page numbers
}

/**
 * Input file with rendered pages for Pre-Analysis
 */
export interface PreAnalysisInputFile {
    fileName: string;                         // Original file name/path
    fileType: 'image' | 'pdf';                // Source type
    pages: RenderedPage[];                    // Pages from this input
    startPage: number;                        // First page number (sequential)
    endPage: number;                          // Last page number (sequential)
}

/**
 * A single rendered page with sequential page number
 */
export interface RenderedPage {
    pageNumber: number;                       // Sequential page number across all inputs
    imageData: string;                        // Base64 encoded image
    mimeType: string;                         // image/png
}

/**
 * Context passed from pre-analysis to batch analysis
 */
export interface PreAnalysisContext {
    answers: AnswerItem[];                    // Known answers from pre-analysis
    parseTarget: ParseTarget;                 // What type of content was found
    processedContent: ProblemItem[];          // Problems already solved in pre-analysis
    progressStatus: ProgressStatus;           // Which pages to skip in batch analysis
}
