import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { TFile } from 'obsidian';
import {
    UniversalFile, ProblemItem, PreAnalysisResponse, PreAnalysisContext,
    AnswerItem, ParseTarget, ProgressStatus, RenderedPage, PreAnalysisInputFile
} from '../types';
import { CPA_GRADER_BATCH_PROMPT, TABLE_FIX_PROMPT, PRE_ANALYSIS_PROMPT, EXPLANATION_BATCH_PROMPT } from '../prompts';
import { DebugLogger } from '../utils/logger';
import * as fs from 'fs';

/**
 * Service for handling all LLM API communication.
 * Responsible for sending requests to Gemini and parsing responses.
 */
export class LLMService {
    private model: GenerativeModel;

    constructor(
        genAI: GoogleGenerativeAI,
        private modelName: string,
        private logger: DebugLogger
    ) {
        this.model = genAI.getGenerativeModel({ model: modelName });
    }

    /**
     * Send images to LLM for problem extraction and return parsed problems.
     * @param files - Array of universal files (images or PDFs converted to images)
     * @param readImageBinary - Function to read binary data for a file
     * @param preAnalysisContext - Optional pre-analysis context with extracted answers
     * @returns Array of extracted problems, or null on failure
     */
    async fetchProblemsFromLLM(
        files: UniversalFile[],
        readImageBinary: (file: UniversalFile) => Promise<string>,
        preAnalysisContext?: PreAnalysisContext | null
    ): Promise<ProblemItem[] | null> {
        await this.logger.log("LLM_BATCH_START", `Batch 요청 시작. 처리할 파일 수: ${files.length}`);

        try {
            // Determine which prompt to use based on pre-analysis context
            let batchPrompt = CPA_GRADER_BATCH_PROMPT;
            let useExplanationPrompt = false;

            if (preAnalysisContext) {
                // Use explanation batch prompt if parseTarget indicates explanation pages
                if (preAnalysisContext.parseTarget === 'explanation-pages' || preAnalysisContext.parseTarget === 'both') {
                    useExplanationPrompt = true;
                }

                // Format known answers as prefix text
                let knownAnswersText = '';
                if (preAnalysisContext.answers.length > 0) {
                    knownAnswersText = preAnalysisContext.answers
                        .map(a => `${a.number}.${a.answer}`)
                        .join(', ');
                }

                if (useExplanationPrompt) {
                    batchPrompt = EXPLANATION_BATCH_PROMPT.replace('{knownAnswersText}', knownAnswersText || 'None');
                } else {
                    // Standard batch with known answers as context
                    if (knownAnswersText) {
                        batchPrompt = `[Known answers: ${knownAnswersText}]\n\n${CPA_GRADER_BATCH_PROMPT}`;
                    }
                }
            }
            
            const promptParts: any[] = [batchPrompt];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                if (!file || !file.path) {
                    await this.logger.log("BATCH_WARNING", `인덱스 ${i}의 파일 객체가 비어있습니다. 건너뜁니다.`);
                    continue;
                }

                let base64Data = "";

                try {
                    base64Data = await readImageBinary(file);
                } catch (readError) {
                    await this.logger.log("IMAGE_READ_ERROR", `이미지 읽기 실패: ${file.path}`, readError);
                    continue;
                }

                const mimeType = 'image/png';
                promptParts.push({ text: `\n--- [Image Index: ${i}] ---\n` });
                promptParts.push({ inlineData: { data: base64Data, mimeType: mimeType } });
            }

            const result = await this.model.generateContent(promptParts);
            const textResponse = result.response.text();

            await this.logger.log("LLM_RESPONSE_RAW", `LLM 원문 응답 수신 완료`, textResponse);

            let extractedData: any[] = [];
            try {
                extractedData = this.parseRoughJson(textResponse);
            } catch (e) {
                await this.logger.log("JSON_PARSE_ERROR", `JSON 파싱 실패`, e);
                return null;
            }

            if (!Array.isArray(extractedData)) {
                await this.logger.log("JSON_FORMAT_ERROR", `결과가 배열 형식이 아님`, extractedData);
                return null;
            }

            const mappedProblems: ProblemItem[] = [];
            for (const item of extractedData) {
                const idx = item.image_index;
                if (typeof idx === 'number' && idx >= 0 && idx < files.length) {
                    const matchedFile = files[idx];

                    if (!matchedFile) {
                        await this.logger.log("MAPPING_WARNING", `인덱스 ${idx}에 매핑할 원본 파일이 존재하지 않습니다.`, item);
                        continue;
                    }

                    mappedProblems.push({
                        ...item,
                        imagePath: matchedFile.path,
                        isExternal: matchedFile.isExternal
                    });
                } else {
                    await this.logger.log("MAPPING_WARNING", `유효하지 않은 image_index: ${idx}`, item);
                }
            }

            mappedProblems.sort((a, b) => {
                const idxA = a.image_index !== undefined ? a.image_index : 0;
                const idxB = b.image_index !== undefined ? b.image_index : 0;
                return idxA - idxB;
            });

            await this.logger.log("BATCH_SUCCESS", `추출 및 매핑된 문제 수: ${mappedProblems.length}`);
            return mappedProblems;

        } catch (error) {
            await this.logger.log("LLM_API_ERROR", `Batch API 호출 실패`, error);
            console.error(`Batch API 호출 실패:`, error);
            return null;
        }
    }

    /**
     * Pre-Analysis: Receive raw images, extract answers/explanations, determine parse target
     * @param inputs - Array of pre-analysis inputs with sequential page numbers
     * @returns PreAnalysisResponse or null on failure (fallback behavior)
     */
    async preAnalysis(
        inputs: PreAnalysisInputFile[]
    ): Promise<PreAnalysisResponse | null> {
        const totalPages = inputs.reduce((sum, i) => sum + i.pages.length, 0);
        await this.logger.log("PRE_ANALYSIS_START", `Pre-Analysis 시작. 총 페이지 수: ${totalPages}`);

        try {
            // Build prompt parts using PRE_ANALYSIS_PROMPT
            const promptParts: any[] = [PRE_ANALYSIS_PROMPT];

            // Assign sequential image indices across all inputs
            let imageIndex = 0;
            for (const input of inputs) {
                for (const page of input.pages) {
                    promptParts.push({ text: `\n--- [Image Index: ${imageIndex}] ---\n` });
                    promptParts.push({ inlineData: { data: page.imageData, mimeType: page.mimeType } });
                    imageIndex++;
                }
            }

            // Generate content
            const result = await this.model.generateContent(promptParts);
            const textResponse = result.response.text();

            await this.logger.log("PRE_ANALYSIS_RESPONSE", `Pre-Analysis 응답 수신`, textResponse);

            // Parse response
            const parsed = this.parsePreAnalysisResponse(textResponse);

            if (parsed) {
                await this.logger.log("PRE_ANALYSIS_SUCCESS", `Pre-Analysis 완료`, {
                    parseTarget: parsed.parseTarget,
                    answersCount: parsed.answers.length,
                    processedContentCount: parsed.processedContent.length,
                    progressStatus: parsed.progressStatus
                });
            } else {
                await this.logger.log("PRE_ANALYSIS_FAILED", `Pre-Analysis 실패 - fallback 활성화`);
            }

            return parsed;

        } catch (error) {
            await this.logger.log("PRE_ANALYSIS_ERROR", `Pre-Analysis API 실패`, error);
            console.error(`Pre-Analysis API 호출 실패:`, error);
            return null; // Fallback: return null, caller handles it
        }
    }

    /**
     * Parse Pre-Analysis JSON response
     * Handles the simplified format with done/remaining progressStatus
     */
    private parsePreAnalysisResponse(text: string): PreAnalysisResponse | null {
        try {
            const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const start = clean.indexOf('{');
            const end = clean.lastIndexOf('}');
            if (start === -1 || end === -1) throw new Error("JSON object brackets not found");

            let jsonStr = clean.substring(start, end + 1);
            const parsed = JSON.parse(jsonStr) as PreAnalysisResponse;

            // Validate and normalize required fields
            if (!parsed.answers) parsed.answers = [];
            if (!parsed.parseTarget) parsed.parseTarget = 'none';
            
            // Ensure progressStatus has the correct format
            if (!parsed.progressStatus) {
                throw new Error("Missing progressStatus");
            }

            // Handle both old and new progressStatus formats
            let progressStatus: ProgressStatus;
            const ps = parsed.progressStatus as any;
            
            if (ps.done !== undefined && ps.remaining !== undefined) {
                // New format
                progressStatus = {
                    done: Array.isArray(ps.done) ? ps.done : [],
                    remaining: Array.isArray(ps.remaining) ? ps.remaining : [],
                    description: ps.description || ''
                };
            } else if (ps.pageNumbers !== undefined) {
                // Old format - convert to new format
                const totalPages = ps.totalPages || ps.pageNumbers.length;
                progressStatus = {
                    done: ps.pageNumbers || [],
                    remaining: Array.from({ length: totalPages }, (_, i) => i).filter(i => !(ps.pageNumbers || []).includes(i)),
                    description: ps.status === 'completed' ? 'all processed' : 'processing needed'
                };
            } else {
                throw new Error("Invalid progressStatus format");
            }

            if (!parsed.processedContent) parsed.processedContent = [];
            parsed.progressStatus = progressStatus;

            return parsed;

        } catch (e) {
            console.error("Pre-Analysis JSON parse error:", e);
            return null;
        }
    }

    /**
     * Send a table to LLM for structure fixing.
     * @param tableText - The markdown table text to fix
     * @returns The fixed table text
     */
    async fixTableViaLLM(tableText: string): Promise<string> {
        try {
            const result = await this.model.generateContent([
                TABLE_FIX_PROMPT,
                `\n--- [테이블 시작] ---\n${tableText}\n--- [테이블 끝] ---\n`
            ]);

            let response = result.response.text();
            await this.logger.log("TABLE_FIX_RAW", "테이블 수정 LLM 응답 수신", response);

            // Remove code fences
            response = response.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

            return response;
        } catch (error) {
            await this.logger.log("TABLE_FIX_API_ERROR", "테이블 수정 LLM API 호출 실패", error);
            throw error;
        }
    }

    /**
     * Parse JSON from LLM response, handling common formatting issues.
     */
    private parseRoughJson(text: string): any[] {
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
}
