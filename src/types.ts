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

export interface ProblemItem {
    subject: string;
    answer: string;
    number: string;
    solution: string;
    imagePath: string;
    isExternal: boolean;
    image_index?: number; // Batch 처리용 인덱스
}