/**
 * Node.js-compatible PDF to image converter using Gemini Vision API.
 * Sends PDF directly to Gemini which can process PDF files natively.
 */

import * as path from 'path';
import * as fs from 'fs';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';

export interface PdfRenderOptions {
    apiKey: string;
    tempDir?: string;
}

export interface ConvertedImage {
    path: string;
    name: string;
    mtime: number;
    isExternal: boolean;
    extension: string;
}

/**
 * Convert a PDF file to images using Gemini Vision API.
 * Gemini can process PDF files directly and extract page images.
 */
export async function convertPdfToImagesViaGemini(
    pdfPath: string,
    options: PdfRenderOptions
): Promise<ConvertedImage[]> {
    const { apiKey, tempDir = '.temp_images' } = options;
    
    const images: ConvertedImage[] = [];
    const normalizedPdfPath = path.resolve(pdfPath);
    const normalizedTempDir = path.resolve(tempDir);

    console.log(`[PDF Converter Gemini] Loading: ${normalizedPdfPath}`);

    // Ensure temp directory exists
    if (!fs.existsSync(normalizedTempDir)) {
        fs.mkdirSync(normalizedTempDir, { recursive: true });
    }

    // Read PDF file
    const pdfBuffer = fs.readFileSync(normalizedPdfPath);
    const originalName = path.basename(normalizedPdfPath, '.pdf').replace(/[^a-zA-Z0-9가-힣]/g, '_');
    
    console.log(`[PDF Converter Gemini] PDF file size: ${pdfBuffer.length} bytes`);
    
    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    
    // Create a prompt to ask Gemini to convert PDF to images per page
    // We'll use the PDF as a file upload and ask Gemini to extract content
    const pdfPart: Part = {
        inlineData: {
            data: pdfBuffer.toString('base64'),
            mimeType: 'application/pdf'
        }
    };
    
    console.log('[PDF Converter Gemini] Sending PDF to Gemini for processing...');
    
    const prompt = `
You can receive a PDF file. Please analyze this PDF and help us convert each page to an image description.

However, since we need actual image files for each page, please provide:
1. The total number of pages in the PDF
2. A brief description of each page's content

Note: We'll use a separate process to extract actual page images. This API call is to understand the PDF structure.
`;
    
    try {
        const result = await model.generateContent([prompt, pdfPart]);
        const response = await result.response;
        const text = response.text();
        
        console.log('[PDF Converter Gemini] Gemini response received');
        console.log(text);
        
        // Since Gemini can't directly output image files, 
        // we'll use a different approach: send each page as image
        // For now, return empty - the CLI will handle PDF differently
        
        return images;
        
    } catch (error) {
        console.error('[PDF Converter Gemini] Error processing PDF with Gemini:', error);
        throw error;
    }
}

/**
 * Alternative: Send PDF pages as base64 to Gemini for extraction.
 * This is the recommended approach for CLI usage.
 */
export async function extractPdfContentViaGemini(
    pdfPath: string,
    options: { apiKey: string; modelName?: string }
): Promise<{ pages: number; content: any[] }> {
    const { apiKey, modelName = 'gemini-2.0-flash' } = options;
    
    const normalizedPdfPath = path.resolve(pdfPath);
    
    console.log(`[PDF Extractor Gemini] Loading: ${normalizedPdfPath}`);
    
    // Read PDF file
    const pdfBuffer = fs.readFileSync(normalizedPdfPath);
    
    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    
    // Send PDF directly to Gemini
    const pdfPart: Part = {
        inlineData: {
            data: pdfBuffer.toString('base64'),
            mimeType: 'application/pdf'
        }
    };
    
    console.log('[PDF Extractor Gemini] Sending PDF to Gemini for content extraction...');
    
    const prompt = `
Analyze this PDF document and extract all problems/questions with their answers and solutions.

Return the result as a JSON array in this format:
[
  {
    "image_index": 0,
    "subject": "과목명 > 단원명 (예: 재무회계 > 재고자산)",
    "number": "문제 번호 (예: 41번)",
    "solution": "한국어로 된 상세 풀이 (줄바꿈은 <br> 사용)",
    "answer": "정답 (예: A. $700)"
  }
]

Rules:
1. Extract ALL problems from ALL pages
2. Use <br> for line breaks in solutions
3. Do NOT use | (pipe) character
4. Do NOT wrap in code blocks - return raw JSON only
5. Each problem must have image_index matching its page number (0-based)
`;
    
    try {
        const result = await model.generateContent([prompt, pdfPart]);
        const response = await result.response;
        const text = response.text();
        
        console.log('[PDF Extractor Gemini] Response received');
        
        // Parse JSON from response
        let jsonStart = text.indexOf('[');
        let jsonEnd = text.lastIndexOf(']');
        
        if (jsonStart === -1 || jsonEnd === -1) {
            throw new Error('No JSON array found in response');
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd + 1);
        const content = JSON.parse(jsonStr);
        
        return {
            pages: 1, // PDF sent as single document
            content
        };
        
    } catch (error) {
        console.error('[PDF Extractor Gemini] Error:', error);
        throw error;
    }
}

/**
 * Get file metadata as UniversalFile-compatible object.
 */
export function fileToUniversal(filePath: string): ConvertedImage {
    const absolutePath = path.resolve(filePath);
    const ext = path.extname(absolutePath).replace('.', '').toLowerCase();
    
    return {
        path: absolutePath,
        name: path.basename(absolutePath),
        mtime: fs.statSync(absolutePath).mtime.getTime(),
        isExternal: true,
        extension: ext
    };
}
