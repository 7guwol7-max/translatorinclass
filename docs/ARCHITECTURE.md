# 교실 실시간 통역 오버레이 — 전체 구상

> 교사가 한국어로 설명하면 다른 창들 위에 **떠 있는 자막**으로 한국어 원문과 학생 언어 번역이 나타나고,
> 외국어를 쓰는 학생이 말하면 **언어를 자동 인식**해서 한국어로 통역해 보여주는 데스크톱 앱.

---

## 0. 먼저 짚고 갈 점 — AIHub MCP는 "번역 엔진"이 아니다

[aihub-git/AIHub-MCP](https://github.com/aihub-git/AIHub-MCP) 코드를 확인한 결과입니다.

| 항목 | 내용 |
| --- | --- |
| 정체 | Spring AI 기반 **MCP 서버** (Java 17, stdio 방식) |
| 하는 일 | AI 허브 **데이터셋 메타데이터** 조회 (검색, 상세, 건수, 데이터 설명서 MD) |
| 제공 도구 | `searchDataSets`, `countDataSets`, `getDataSet`, `describeDataSet`, `getDataSetsWithGuide` |
| 호출 대상 | `https://aihub.or.kr/mcp/dataSetList.do`, `dataSetDetail.do` 등 (헤더 `X-API-KEY: <AIHUB_API_KEY>`) |
| **안 하는 일** | 음성 인식(STT), 언어 식별, 번역, 음성 합성 — **추론 API가 없음** |

따라서 이 앱에서 AIHub MCP의 역할은 아래처럼 나눠서 생각해야 합니다.

```
[개발 단계]  Claude + AIHub MCP  →  "어떤 데이터를 쓸까?" 조사·선정
             AI 허브 데이터       →  평가셋 · 교과 용어집 · (선택) 모델 미세조정 재료
[운영 단계]  실시간 통역 엔진     →  STT/번역 API 또는 로컬 모델 (AIHub MCP는 관여하지 않음)
```

발화가 나올 때마다 AIHub MCP를 호출하는 구조는 의미가 없습니다. AIHub MCP는 **"좋은 엔진을 고르고, 검증하고, 교실에 맞게 다듬기 위한 데이터 조사 도구"**로 씁니다.

---

## 1. 전체 시스템 구성

```
┌──────────────────────────── 개발 단계 (개발자 PC) ────────────────────────────┐
│                                                                              │
│  Claude Desktop / Claude Code ──MCP(stdio)──▶ aihub-mcp.jar ──X-API-KEY──▶ AI 허브 │
│        │  "외국인 발화 음성 데이터 찾아줘"                                       │
│        ▼                                                                     │
│  docs/datasets.md (후보 데이터셋 목록)                                          │
│        │  웹에서 이용 신청·승인 → aihubshell / 웹 다운로드 (같은 API 키)           │
│        ▼                                                                     │
│  tools/data-pipeline ─▶ ① 평가셋(WER/CER, BLEU/COMET)  ② 교과 용어집           │
│                         ③ (선택) Whisper·번역 모델 미세조정                    │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── 운영 단계 (교실) ─────────────────────────────────┐
│                                                                              │
│  🎤 교사 마이크 ─┐                                                            │
│  🎤 학생 마이크 ─┼─▶ [Electron 데스크톱 앱]                                     │
│                 │     ├─ 컨트롤 패널 (교사 모니터)                              │
│                 │     └─ 자막 오버레이 (프로젝터/TV, 항상 위·투명·클릭 통과)       │
│                 │            ▲                                               │
│                 │   PCM 16kHz│ WebSocket        │ 자막 이벤트                    │
│                 ▼            │                  ▼                             │
│           [Speech Gateway]  ── VAD → 언어식별 → STT → 번역(+용어집) ──           │
│            (로컬 사이드카 또는 학교 서버, API 키는 여기에만 보관)                  │
│                 │                                                            │
│                 ▼                                                            │
│      클라우드 STT/번역 API   또는   로컬 Whisper/번역 모델                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 사용 시나리오

**A. 교사 → 학생**
1. 교사가 한국어로 설명 → 교사 마이크 채널은 한국어 고정 STT (언어 식별 생략 → 빠르고 정확)
2. 오버레이 1줄: 한국어 원문 (실시간 부분 결과 → 확정 문장)
3. 오버레이 2~3줄: 학급에 등록된 학생 언어로 번역 (화면에는 최대 2~3개 언어, 언어가 더 많으면 교사가 전환)

**B. 학생 → 교사**
1. 학생이 모국어로 말함 → 학생 마이크 채널에서 **언어 자동 식별** (학급 등록 언어 후보로만 제한)
2. 해당 언어로 STT → 한국어 번역
3. 오버레이에 `🇻🇳 학생: (한국어 번역)` 형태로 다른 색상 표시, 컨트롤 패널 로그에 원문 보관

**마이크 구성별 처리**

| 구성 | 화자 구분 방식 | 비고 |
| --- | --- | --- |
| 권장: 2채널 (교사 무선 핀마이크 + 학생용 탁상/핸드 마이크) | 채널 = 역할 | 가장 안정적. 교사 채널은 한국어 고정 |
| 마이크 1개 | 언어 식별 결과로 라우팅 (ko → 교사, 그 외 → 학생) | 짧은 발화 오인식 대비 신뢰도 기준값, 1초 미만 무시 |
| 보조 | 단축키(예: `F8` 누르는 동안 "학생 발화" 모드) | 1개 마이크일 때 오분류 보정 |

---

## 3. 플로팅 오버레이 설계 (핵심 요구사항)

"다른 창 위에 떠 있어야 의미가 있다"는 요구사항 때문에 **브라우저 웹앱이 아닌 데스크톱 앱**이어야 합니다.

**권장: Electron + React/TypeScript** (투명 창, 항상 위, 클릭 통과, 다중 모니터 API가 검증되어 있음.
더 가벼운 대안은 Tauri)

### 3.1 창 두 개 구조
- **자막 오버레이 창**: 프로젝터/TV 화면 하단에 고정. 투명, 테두리 없음, 작업표시줄 숨김, 항상 위, 마우스 클릭 통과
- **컨트롤 패널 창**: 교사 모니터. 시작/정지, 언어 선택, 글자 크기, 대화 로그, 용어집 편집

### 3.2 핵심 코드 스케치 (Electron main process)

```ts
import { app, BrowserWindow, screen, globalShortcut } from 'electron';

function createOverlay() {
  // 프로젝터(보조 디스플레이)가 있으면 그쪽에, 없으면 주 화면에
  const displays = screen.getAllDisplays();
  const target = displays.find(d => d.id !== screen.getPrimaryDisplay().id) ?? displays[0];
  const { x, y, width, height } = target.workArea;

  const overlay = new BrowserWindow({
    x, y: y + height - 220, width, height: 220,
    transparent: true, frame: false, resizable: false,
    skipTaskbar: true, focusable: false, hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: `${__dirname}/preload.js` },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');                       // 전체화면 PPT·영상 위에도 표시
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // macOS 전체화면 대응
  overlay.setIgnoreMouseEvents(true, { forward: true });              // 클릭이 아래 창으로 통과

  // 단축키: 오버레이 숨기기/보이기, 위치 조정 모드
  globalShortcut.register('Control+Alt+H', () =>
    overlay.isVisible() ? overlay.hide() : overlay.showInactive());
  globalShortcut.register('Control+Alt+M', () => overlay.setIgnoreMouseEvents(false)); // 드래그 이동 모드
  return overlay;
}
```

### 3.3 확인해야 할 실제 환경 이슈
- PowerPoint 슬라이드쇼, 유튜브 전체화면, 한글 뷰어 위에서 실제로 뜨는지 **교실 PC에서 실측** (일부 독점 전체화면 앱은 위에 못 뜸)
- 화면 복제(미러링) 모드면 교사 모니터와 프로젝터가 같은 화면 → 컨트롤 패널은 작게 접히도록
- 교육청 PC의 보안 프로그램이 마이크 접근·프로그램 설치를 막는지 확인
- 가독성: 반투명 검정 배경 + 흰 글씨, 최소 32pt, 최근 2~3문장만 표시, 언어별 색상

---

## 4. 음성 파이프라인 (Speech Gateway)

```
PCM 16kHz mono (20ms 프레임)
  → VAD (Silero VAD): 발화 시작/끝 감지, 무음 구간 버림
  → 언어 식별: 교사 채널은 생략(ko 고정), 학생 채널은 등록 언어 후보 3~5개로 제한
  → STT 스트리밍: 부분 결과(partial) 즉시 전달, 문장 확정(final) 시 번역으로
  → 번역: 교사 → 등록 언어 N개 / 학생 → 한국어, 교과 용어집 적용
  → 앱으로 자막 이벤트 전송
```

### 4.1 앱 ↔ Gateway 메시지 (WebSocket `/ws/stream`)

```jsonc
// 앱 → Gateway (시작 시 1회, 이후 바이너리 PCM 프레임)
{ "type": "start", "channel": "student", "candidates": ["vi", "zh", "ru"], "targets": ["ko"] }

// Gateway → 앱
{ "type": "partial", "segId": 17, "lang": "vi", "text": "Thưa cô, em không hiểu..." }
{ "type": "final",   "segId": 17, "lang": "vi", "confidence": 0.93,
  "text": "Thưa cô, em không hiểu phần này.",
  "translations": { "ko": "선생님, 이 부분이 이해가 안 돼요." }, "latencyMs": 1420 }
```

### 4.2 목표 지연 시간
- 교사 한국어 부분 자막: 1초 이내
- 번역 확정 자막: 발화 종료 후 2.5초 이내 (p95)

### 4.3 엔진 선택 (어댑터 구조로 교체 가능하게)

`SttProvider`, `TranslateProvider` 인터페이스를 두고 구현체를 바꿔 끼웁니다.

| 구분 | 후보 | 장점 | 주의 |
| --- | --- | --- | --- |
| STT + 언어식별 | 클라우드 (Azure Speech, Google Cloud STT, Naver CLOVA Speech 등) | 스트리밍·연속 언어 식별 지원, 구축 빠름 | 학생 음성이 외부로 전송됨, 사용량 과금 |
| STT + 언어식별 | 로컬 Whisper (faster-whisper) | 99개 언어 식별 내장, 음성이 교실 밖으로 안 나감 | GPU 권장, 실시간성 튜닝 필요 |
| 번역 | Papago, DeepL, Google 번역 | 빠르고 저렴 | **엔진마다 지원 언어가 다름** (우즈베크어·몽골어·크메르어 등 반드시 확인) |
| 번역 | LLM (Claude 등) | 앞뒤 문맥·용어집·존댓말 반영, 언어 폭 넓음 | 지연·비용 관리 필요 (짧은 문장 단위 호출) |
| STT + 언어식별 + 번역 한 번에 | **Gemini (교사 본인 키, 무료 등급)** | 0원, 엔진·서버 하나로 끝 | 일일 요청 한도, 학생 음성이 Google로 전송(무료 등급은 제품 개선에 활용 가능) → [GEMINI_BYOK.md](GEMINI_BYOK.md) |

**권장 순서**
- **무료 MVP (기본)**: 교사 본인 Gemini 키(BYOK) 무료 등급 → 설계는 [GEMINI_BYOK.md](GEMINI_BYOK.md)
- **무료·완전 로컬 (선택)**: 로컬 Whisper + 로컬 번역 모델 (음성이 교실 밖으로 안 나감, GPU PC 권장)
- **유료 MVP**: 클라우드 STT(언어 식별 지원) + 번역 API → 빠르게 교실 테스트
- **2단계**: AI 허브 데이터로 만든 평가셋으로 엔진 비교 → 언어별 최적 엔진 조합
- **3단계(선택)**: 로컬 Whisper + 미세조정 → 개인정보 측면에서 유리한 오프라인 모드

---

## 5. AIHub MCP 활용 방법

### 5.1 API 키 발급
1. [AI 허브](https://aihub.or.kr) 회원가입·로그인
2. [API Key 발급 페이지](https://aihub.or.kr/devsport/apishell/list.do?currMenu=403&topMenu=100)에서 발급
   (연속 시도 시 5분 제한, 하루 발급 시도 횟수 제한 있음 — aihubshell 가이드 기준)
3. 이 키 하나로 **① AIHub MCP(메타데이터 조회)**와 **② aihubshell(데이터 다운로드)**를 모두 사용
   단, 다운로드는 데이터셋별로 **웹사이트에서 이용 신청·승인**을 받아야 함

### 5.2 MCP 서버 준비
```bash
# Java 17 필요
git clone https://github.com/aihub-git/AIHub-MCP.git
cd AIHub-MCP && mvn -q package -DskipTests      # → target/mcp-server-0.0.1-SNAPSHOT.jar
# 또는 GitHub Release의 스냅샷 jar 다운로드
```

### 5.3 등록

**Claude Code** (키를 저장소에 남기지 않도록 user 범위로 등록 권장)
```bash
claude mcp add aihub-mcp --scope user \
  -e AIHUB_API_KEY="$AIHUB_API_KEY" \
  -- java -Dfile.encoding=UTF-8 -jar /절대경로/mcp-server-0.0.1-SNAPSHOT.jar
```

팀이 같이 쓰려면 저장소에 `.mcp.json`을 두되 키는 환경변수로 참조합니다 (키 자체는 커밋 금지).
```json
{
  "mcpServers": {
    "aihub-mcp": {
      "command": "java",
      "args": ["-Dfile.encoding=UTF-8", "-jar", "${AIHUB_MCP_JAR}"],
      "env": { "AIHUB_API_KEY": "${AIHUB_API_KEY}" }
    }
  }
}
```

**Claude Desktop**: AIHub-MCP의 `support/config.json` 형식을 `claude_desktop_config.json`에 추가
(이 파일은 개인 PC에만 있으므로 키를 직접 적어도 되지만, 화면 공유·백업 시 노출 주의)

### 5.4 이 프로젝트에서 던질 질문 예시
```
- 오디오 유형 데이터 중에 '외국인' 한국어 발화 음성 데이터셋 10개 보여줘
- '번역 말뭉치'로 텍스트 데이터셋을 찾아서 언어쌍(한-베, 한-중, 한-러 …)별로 표로 정리해줘
- 교육 분야(REALM010)에 강의·수업 음성 데이터 있어? 5개만
- '통번역' 또는 '다국어' 키워드로 음성 데이터 몇 건이야?
- ○○ 데이터의 데이터 설명서에서 오디오 포맷(샘플레이트, 채널), 라벨 구조, 화자 수 요약해줘
- 우즈베크어·몽골어·타갈로그어가 포함된 데이터셋이 있는지 찾아줘
```
결과는 `docs/datasets.md`에 **이름 · url · 언어 · 분량 · 용도(평가/용어집/학습) · 이용조건 확인 여부**로 정리합니다.

### 5.5 찾아야 할 데이터 유형과 쓰임새

| 찾을 데이터 | 쓰임새 |
| --- | --- |
| 한국어 강의·수업·대화 음성 | 교사 STT 정확도(CER) 평가, 미세조정 |
| 다국어 음성 (통번역·낭독·대화) | 학생 측 언어 식별 정확도·STT(WER) 평가 |
| 외국인의 한국어 발화 | 학생이 서툰 한국어로 말할 때 인식 품질 평가 |
| 한국어 ↔ 다국어 번역 말뭉치 | 번역 품질(BLEU/chrF/COMET) 평가, 엔진 선택 근거 |
| 교육 분야 텍스트 (교과·학습 용어) | 교과 용어집 → 번역 시 용어 고정 |

> AI 허브 다국어 데이터는 주요 언어(영·중·일·베 등)에 몰려 있을 가능성이 큽니다.
> 다문화 학생이 많이 쓰는 러시아어·우즈베크어·몽골어 등은 데이터가 부족할 수 있으니
> MCP로 먼저 확인하고, 부족한 언어는 상용 엔진에 맡기는 식으로 언어별 전략을 정합니다.

### 5.6 앱 안에서 AIHub MCP를 쓰지 않는 이유
- 실시간 통역 경로에 필요한 기능(STT/번역)이 MCP에 없음
- MCP 서버는 Java 프로세스 + 개인 API 키 → 교사 PC 배포물에 넣으면 키가 노출됨
- 데이터 조사는 개발자가 한 번 하면 되는 일

---

## 6. API 키 관리 설계

### 6.1 키 종류와 보관 위치

| 키 | 쓰는 곳 | 보관 위치 | 앱 배포물에 포함 |
| --- | --- | --- | --- |
| `AIHUB_API_KEY` | AIHub MCP, aihubshell, 데이터 파이프라인 | 개발자 PC 환경변수 / `.env` / CI 시크릿 | ❌ 절대 금지 |
| STT 키 (Azure/Google/CLOVA 등) | Speech Gateway | Gateway 환경변수 또는 OS 보안 저장소 | ❌ |
| 번역 키 (Papago/DeepL/LLM 등) | Speech Gateway | Gateway 환경변수 또는 OS 보안 저장소 | ❌ |
| 교사 본인 Gemini 키 (BYOK 모드) | Electron main 프로세스 | 교사 PC의 OS 암호화 저장소 (`safeStorage`) — 교사가 직접 입력 | ❌ (개발자 키를 넣지 않음, 교사가 각자 입력) |

### 6.2 원칙
1. **저장소에 커밋 금지**: `.env`는 `.gitignore`에 포함, 형식은 `.env.example`로만 공유
2. **Electron 번들에 하드코딩 금지**: 앱 패키지(asar)는 쉽게 풀어볼 수 있음
3. 키는 **Gateway만** 들고 있고, 앱은 Gateway와만 통신

### 6.3 배포 형태별 방식
- **A. 교사 개인 사용 (1대)**: Gateway를 로컬 사이드카로 실행. 첫 실행 때 교사가 키 입력
  → Electron `safeStorage`(Windows는 DPAPI)로 암호화해 저장 → 사이드카 시작 시 환경변수로 전달
- **B. 학교·교육청 배포 (여러 대)**: Gateway를 학교 서버/클라우드에 두고 키는 서버 시크릿 저장소에 보관.
  앱은 학교 계정으로 로그인 → Gateway가 발급하는 짧은 수명 토큰 사용.
  STT 서비스가 단기 토큰 발급을 지원하면 앱이 STT에 직접 붙어도 원본 키는 노출되지 않음
- 공통: 키별 사용량 한도·알림 설정, 유출 시 즉시 재발급(교체) 절차 문서화

---

## 7. 개인정보·학교 도입 고려사항
- 학생 음성·발화 내용은 개인정보. 기본값은 **원음 저장 안 함**, 텍스트 로그는 수업 종료 시 삭제(교사가 필요할 때만 저장)
- 클라우드 엔진 사용 시 데이터 국외 이전 여부·보관 정책 확인, 학생·보호자 고지
  (만 14세 미만은 법정대리인 동의 필요 — 개인정보보호법)
- 학교 정식 도입 시 교육부 **학습지원 소프트웨어 선정 기준** 검토 대상이 될 수 있음 → 3단계 로컬 모드가 유리
- AI 허브 데이터는 **데이터셋별 이용조건**(AI 학습 목적 한정, 재배포 금지, 출처 표기 등)을 확인하고 원본 데이터는 저장소에 올리지 않음

---

## 8. 저장소 구조 제안

```
translatorinclass/
├── apps/
│   └── desktop/              # Electron + React: 자막 오버레이 + 컨트롤 패널 (Gemini BYOK 모드는 여기서 완결)
├── services/
│   └── speech-gateway/       # (선택) 로컬 Whisper·유료 엔진용 사이드카: VAD, 언어식별, STT·번역 어댑터
│       └── providers/        #   stt_azure.py, stt_whisper.py, mt_papago.py, mt_llm.py …
├── tools/
│   ├── aihub-mcp/            # MCP 등록 방법·설정 예시 (jar·키는 커밋하지 않음)
│   └── data-pipeline/        # AI 허브 데이터 → 평가셋, 용어집, 미세조정 데이터
├── data/                     # 로컬 전용 (gitignore) — 다운로드한 AI 허브 데이터
├── docs/
│   ├── ARCHITECTURE.md       # 이 문서
│   ├── datasets.md           # AIHub MCP로 조사한 후보 데이터셋 목록
│   └── evaluation.md         # 엔진별 평가 결과
├── .env.example
└── .gitignore
```

---

## 9. 단계별 로드맵

| 단계 | 기간(예상) | 할 일 | 완료 기준 |
| --- | --- | --- | --- |
| **0. 준비** | 1주 | AI 허브 키 발급, AIHub MCP 등록, 후보 데이터셋 조사, 학급 대상 언어 확정, 교실 PC·마이크 환경 확인 | `docs/datasets.md` 작성, 대상 언어 목록 확정 |
| **1. MVP** | 2~3주 | Electron 오버레이(항상 위·투명·클릭 통과), 교사 한국어 STT → 1~2개 언어 번역, 클라우드 엔진 1종 | 실제 수업 10분 동안 PPT 전체화면 위에서 자막 유지, 지연 2.5초 이내 |
| **2. 양방향** | 2~3주 | 학생 채널 + 언어 자동 식별 → 한국어, 2채널 마이크, 교과 용어집, AI 허브 평가셋으로 엔진 비교 | 언어 식별 정확도·번역 품질 수치 확보(`docs/evaluation.md`) |
| **3. 확장** | 4주~ | 로컬 Whisper 오프라인 모드, AI 허브 데이터로 미세조정, 교사 PC용 설치 파일 배포(교사마다 본인 키 입력) | 인터넷 없이 동작, 다수 언어 동시 지원 |

---

## 10. 결정이 필요한 사항
1. **대상 언어**: 실제 학급 학생들의 모국어 (엔진·데이터 선택의 출발점)
2. **교실 PC OS**: Windows 위주인지 (오버레이 동작 검증 대상)
3. **마이크 구성**: 2채널(권장)이 가능한지, 1개로 시작할지
4. **클라우드 허용 여부**: 학교·교육청 정책상 학생 음성을 외부 API로 보내도 되는지
5. **예산**: 사용량 과금 API vs GPU가 있는 로컬 PC

---

## 참고
- AIHub-MCP: <https://github.com/aihub-git/AIHub-MCP>
- AI 허브 API Key 발급: <https://aihub.or.kr/devsport/apishell/list.do?currMenu=403&topMenu=100>
- aihubshell 가이드(PDF): <https://www.aihub.or.kr/static/pdf/aihubshell_가이드.pdf>
