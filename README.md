# Error Log Writer for Obsidian 🧠

**Error Log Writer**는 CPA, 고시, 수능 등 수험생을 위해 설계된 **AI 기반 자동 오답노트 생성 플러그인**입니다.
Google Gemini Vision API(Multimodal)를 활용하여, 문제 스크린샷이나 PDF를 분석하고 자동으로 오답노트 표(Table)를 생성해 줍니다.

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.0-green)

## ✨ 주요 기능 (Features)

* **Batch Processing (일괄 처리):** 여러 장의 스크린샷이나 PDF 파일을 한 번에 선택하여 연속으로 분석합니다.
* **1:N Extraction:** 하나의 이미지/PDF에 여러 문제가 포함되어 있어도, 개별 문제(Q1, Q2...)로 분리하여 추출합니다.
* **Smart Formatting:**
    * 마크다운 표가 깨지지 않도록 특수문자(`|`)를 자동으로 이스케이프 처리합니다.
    * 긴 풀이(Solution)는 **스크롤 가능한 영역(Scrollable View)**으로 표시하여 표의 가독성을 유지합니다.
* **Dynamic Model Selection:** API Key만 있으면 사용 가능한 Gemini 모델 목록을 자동으로 불러와 선택할 수 있습니다. (기본값: `gemini-2.0-flash`)

## 🛠️ 설치 방법 (Installation)

### 수동 설치 (Manual)
1.  이 저장소의 [Releases](https://github.com/your-username/error-log-writer/releases) 페이지에서 최신 버전을 다운로드합니다 (`main.js`, `manifest.json`, `styles.css`).
2.  Obsidian 볼트 내 `.obsidian/plugins/error-log-writer` 폴더를 만들고 파일을 넣습니다.
3.  Obsidian 설정 > Community Plugins에서 플러그인을 활성화합니다.

### BRAT을 이용한 베타 설치
1.  Obsidian Community Plugin에서 **BRAT**을 설치합니다.
2.  BRAT 명령어 `Add a beta plugin for testing`을 실행하고 이 리포지토리 주소를 입력합니다.

## ⚙️ 설정 (Configuration)

1.  [Google AI Studio](https://aistudio.google.com/)에서 **API Key**를 발급받습니다. (무료)
2.  Obsidian 설정 > **Error Log Writer** 탭으로 이동합니다.
3.  `Gemini API Key`에 키를 입력합니다.
4.  `Gemini Model`에서 사용할 모델을 선택합니다. (목록이 안 보이면 🔄 버튼 클릭)
5.  `Target Note File`에 오답노트가 저장될 파일명을 입력합니다 (기본값: `CPA_Error_Log.md`).

## 🚀 사용법 (Usage)

1.  틀린 문제의 **스크린샷**을 찍거나 **PDF**를 준비하여 옵시디언 볼트에 넣습니다.
2.  왼쪽 사이드바(Ribbon)의 **'뇌 회로(Brain Circuit)' 아이콘** 🧠을 클릭합니다.
3.  파일 선택 모달이 뜨면 분석할 파일들을 **체크(Toggle)** 합니다. (최근 30개 파일 표시)
4.  하단의 **Start Analysis 🚀** 버튼을 클릭합니다.
5.  설정한 노트(`CPA_Error_Log.md`)에 자동으로 오답노트가 생성되는 것을 확인합니다.

---

## 📝 라이선스 (License)

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.