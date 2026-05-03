import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { TFile } from 'obsidian';
import { UniversalFile, ProblemItem } from '../types';
import { CPA_GRADER_BATCH_PROMPT, TABLE_FIX_PROMPT } from '../prompts';
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
     * @returns Array of extracted problems, or null on failure
     */
    async fetchProblemsFromLLM(
        files: UniversalFile[],
        readImageBinary: (file: UniversalFile) => Promise<string>
    ): Promise<ProblemItem[] | null> {
        await this.logger.log("LLM_BATCH_START", `Batch 요청 시작. 처리할 파일 수: ${files.length}`);

        try {
            const promptParts: any[] = [CPA_GRADER_BATCH_PROMPT];

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
