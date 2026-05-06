export const CPA_GRADER_BATCH_PROMPT = `
너는 **CPA 시험 채점관**이야.
나가 여러 장의 시험지 스캔본 이미지를 한 번에 제공할 거야.
각 이미지 앞에는 "[Image Index: 0]" 처럼 해당 이미지의 번호(인덱스)가 텍스트로 주어져.

각 이미지에 포함된 **모든** 문제를 식별해서 풀고, 그 결과를 **단일 JSON Array(1차원 배열)**로 묶어서 반환해.
[🚨 핵심 지시사항: 반환되는 각 문제 객체에는 반드시 자신이 속한 원본 이미지의 번호인 "image_index" 필드를 정수로 포함해야 해.]

[🚨 매우 중요한 지시사항]
1. **학생의 답과 메모를 믿지 마:** 이미지에 있는 동그라미, 체크 표시, 메모는 학생이 남긴 흔적이야. **이건 무시해.**
2. **직접 풀어라:** 문제의 지문과 보기를 읽고, 네가 직접 계산하고 논리적으로 추론해서 **'진짜 정답'**을 도출해.
3. **Step by Step:** 풀이 과정에 누락된 단계 없이 차근차근, 정확하게 설명해.
4. 객관식 문제면 보기 안에 반드시 정답이 있고, 나머지 보기는 함정이므로 주의하라.
5. 답이 보기에 없으면 이렇게 표현해: "$900 (오류)"

[출력 포맷]
오직 **순수 JSON Array**만 출력해. 마크다운 코드블록(\`\`\`)도 쓰지 마.

[JSON Schema]
[
  {
    "image_index": 0,
    "subject": "과목명 > 단원명 (예: 재무회계 > 재고자산)",
    "number": "문제 번호 (예: 41번)",
    "solution": "한국어로 된 상세 풀이 및 오답 분석 (줄바꿈은 <br> 사용, 핵심 용어는 영어 허용)",
    "answer": "네가 도출한 진짜 정답 (예: A. $700) (<b>태그 강조)"
  }
]

[🚨수식 및 특수문자 절대 규칙]
1. 줄바꿈 문자는 무조건 '<br>'로 대체해. JSON 값 안에 \n 넣지 마.
2. '|' (파이프) 기호 절대 사용 금지.
3. 마크다운의 '$' 기호는 오직 "금액"을 표시할 때만 사용해. (예: $50,000)
4. LaTeX 수식은 절대 사용하지 마.
5. 곱하기는 "x"로 표현해. (예: 5 x 4 = 20)
6. 나누기는 "/"로 표현해. (예: 20 / 4 = 5)
`;

export const TABLE_FIX_PROMPT = `
너는 **마크다운 테이블 구조 복원 전문가**야.

아래에 마크다운 테이블을 제공할 거야.
이 테이블의 **구조적 문제**를 찾아서 수정해.

[수정 대상 문제 유형]
1. **컬럼 수 불일치**: 헤더 행, 구분자 행(|---|), 데이터 행의 파이프(|) 개수가 서로 다른 경우 → 가장 많이 등장하는 컬럼 수 기준으로 통일
2. **구분자 행 누락**: 헤더 바로 아래에 |---|---| 형태의 구분자 행이 없는 경우 → 추가
3. **헤더 + 구분자 행 모두 누락**: 테이블 전체에 구분자 행(|---|)이 단 한 줄도 없는 경우 → 첫 번째 행을 헤더로 간주하고 그 아래에 구분자 행을 삽입. 컬럼 수는 첫 번째 행의 파이프(|) 개수에 맞춰 생성.
4. **줄바꿈으로 인한 행 분리**: <br> 태그가 실제 줄바꿈으로 쪼개져 한 행이 여러 줄로 나뉜 경우 → 한 줄로 병합
5. **이스케이프 안 된 파이프(|)**: 셀 내용 안에 이스케이프되지 않은 | 문자 → &#124; 로 교체
6. **빈 셀 누락**: 행 끝에 파이프가 부족하여 컬럼 수가 모자란 경우 → 빈 셀(| |) 추가

[절대 규칙]
1. 셀의 **내용(값)**은 변경하지 마. 구조(파이프, 구분자, 줄바꿈)만 수정해.
2. 위키링크 형식(![[...]])은 절대 건드리지 마.
3. HTML 태그(<div>, <br>, <b> 등)는 내용으로 취급하고 구조만 수정해.
4. 수정된 테이블을 반환해. 수정한 부분만이 아니라 테이블 전체를 반환해야 해.
5. 마크다운 코드블록(\`\`\`)으로 감싸지 마. 순수 테이블 텍스트만 반환해.
6. 설명이나 주석을 추가하지 마. 오직 수정된 테이블만 반환해.
`;

// NEW: Prompts for answer key and explanation extraction
export const OCR_TEXT_EXTRACTION_PROMPT = `
Extract all text from this image of a CPA exam answer section.

Look for:
- Answer keys (e.g., "1.A 2.B 3.C 4.D" or "1. A, 2. B, 3. C")
- Problem explanations with numbers
- Any structured answer lists

Return ONLY the extracted text exactly as it appears.
Do NOT interpret or modify the content.
`;

export const ANSWER_KEY_EXTRACTION_PROMPT = `
You are a CPA exam answer key extractor.

I will provide you with text extracted from the end of a CPA exam PDF.
Your task is to extract the answer key if it exists.

Look for patterns like:
- "1.A 2.B 3.C 4.D ..."
- "1. A, 2. B, 3. C, ..."
- "Answer Key" header followed by numbered answers
- Any numbered list of answers

Return ONLY a JSON array in this format:
[
  {"number": "1", "answer": "A"},
  {"number": "2", "answer": "B"},
  ...
]

If no answer key is found, return an empty array [].
Do NOT wrap in code blocks. Return raw JSON only.
`;

export const EXPLANATION_EXTRACTION_PROMPT = `
You are a CPA exam explanation extractor.

I will provide you with text extracted from the end of a CPA exam PDF.
Your task is to extract explanations for each problem if they exist.

Look for sections that explain how to solve each problem.
Each explanation will be associated with a problem number.

Return ONLY a JSON array in this format:
[
  {
    "number": "1",
    "explanation": "Full explanation text here translated to Korean...",
    "answer": "A"
  },
  ...
]

If no explanations are found, return an empty array [].
Do NOT wrap in code blocks. Return raw JSON only.
`;

// ===== Pre-Analysis Prompt (Step 4.5) =====

/**
 * Pre-analysis prompt sent to Gemini to extract answers, determine parse target,
 * and optionally process explanation pages before batch analysis.
 */
export const PRE_ANALYSIS_PROMPT = `
너는 CPA 시험 문서 분석 전문가야.

내가 여러 장의 시험지 이미지를 제공할 거야.
각 이미지 앞에는 "[Image Index: 0]" 처럼 해당 이미지의 번호(인덱스)가 텍스트로 주어져.

[네가 할 일]
1. **정답 추출**: 답안지가 있으면 모든 정답을 추출해.
   - 예: "1.A 2.B 3.C 4.D ..."
   
2. **해설 추출**: 해설이 있으면:
    - 해설을 추출한 뒤 Korean으로 번역해서 processedContent에 포함해
    - 문제 번호와 정답을 명시
    - 핵심 용어와 표현은 영어로 유지 (예: "재고자산(evaluated at lower of cost or market)")
   
3. **Parse Target 결정**:
   - "explanation-pages": 답안지/해설이 있는 페이지들 (이미 해결됨)
   - "question-pages": 풀어야 할 문제만 있는 페이지들 (아직 처리 안 됨)
   - "both": 둘 다 있음
   - "none": 아무것도 없음

4. **Progress Status**: 각 페이지가 처리됨/남았음 표시

[출력 형식 - JSON만 반환]
마크다운 코드블록 없이 순수 JSON만 반환:

{
  "answers": [{"number": "1", "answer": "A"}],
  "parseTarget": "explanation-pages" | "question-pages" | "both" | "none",
  "processedContent": [
    {
      "image_index": 0,
      "page": 1,
      "subject": "과목명 > 단원명",
      "number": "41번",
      "solution": "한국어 해설 (줄바꿈은 <br> 사용, 핵심 용어는 영어 허용)",
      "answer": "A. $700"
    }
  ],
  "progressStatus": {
    "done": [0, 1],
    "remaining": [2, 3, 4],
    "description": "question pages"
  }
}

[중요 규칙]
- answers는 반드시 먼저, 완전히 반환 (always return answers first)
- processedContent는 가능한 많이 채워 (most of token budget)
- progressStatus는 processedContent의 내용을 정확히 반영
- 줄바꿈은 '<br>' 사용, '|' 기호 절대 사용 금지
- LaTeX 수식 사용 금지, 곱하기는 "x", 나누기는 "/"
- 해설은 한국어로 작성 (핵심 용어와 표현은 영어 허용)
- image_index는 이미지에 붙인 번호와 동일해야 함
- page는 1-based PDF 페이지 번호 (예: image_index 0이 1페이지면 page: 1)
`;

/**
 * Batch analysis prompt used when parseTarget = "explanation-pages"
 * This prompt focuses on extracting explanations in Korean.
 */
export const EXPLANATION_BATCH_PROMPT = `
You are a CPA exam explanation extractor.

I will provide you with images containing Korean exam explanations.
Your job is to extract problem information and keep the explanations in Korean.

[Known Answers]
{knownAnswersText}

[Instructions]
1. Extract subject, problem number, and answer from each image
2. Keep explanations in Korean (핵심 용어와 표현은 영어 허용)
3. Use <br> for line breaks, NEVER use '|' character

[Output Format - JSON Array Only, no code blocks]
[
  {
    "image_index": 0,
    "page": 1,
    "subject": "과목명 > 단원명",
    "number": "41번",
    "solution": "한국어 해설 (줄바꿈은 <br> 사용, 핵심 용어는 영어 허용)",
    "answer": "A. $700"
  }
]

[Rules]
- Use "x" for multiplication, "/" for division
- NEVER use LaTeX math notation
- Keep explanations in Korean while allowing key CPA terminology in English
`;
