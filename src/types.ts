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
    // NEW: Reference to parsed answer key
    expectedAnswer?: string;       // From PDF answer key, if available
    // NEW: Reference to parsed explanation
    referenceExplanation?: string; // From PDF explanation, if available
}
