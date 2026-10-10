# 교실 통역 데스크톱 앱 (Electron)

교사 PC(Windows)용 실시간 통역 자막 앱. 사용법은 [교사용 안내](../../docs/TEACHER_GUIDE.md), 설계는 [GEMINI_BYOK.md](../../docs/GEMINI_BYOK.md).

## 명령
```bash
npm ci              # 의존성 설치
npm run typecheck   # 타입 검사
npm test            # 단위 테스트 (vitest)
npm start           # 빌드 후 실행 (개발용)
npm run dist:win    # Windows 설치 파일 (release/*.exe) — Windows 에서 실행하거나 GitHub Actions 사용
```
Linux/macOS 에서는 NSIS 설치 파일을 만들 때 wine 이 필요하므로 `.github/workflows/build-windows.yml`(windows-latest)로 만든다.

## 새 버전 배포 (누구나 받을 수 있는 Release)
1. `package.json` 의 `version` 을 올린다 (예: `0.1.1`)
2. 커밋 후 같은 버전의 태그를 올린다: `git tag v0.1.1 && git push origin v0.1.1`
3. GitHub Actions 가 Windows 에서 설치판·설치 없는 판을 만들어 Release 에 붙인다.
   파일 이름이 버전과 상관없이 같아서 `releases/latest/download/ClassroomInterpreter-Setup.exe` 링크가 항상 최신판을 가리킨다.

## 구조
```
src/
├── main/                    # Electron main 프로세스
│   ├── main.ts              # 창(컨트롤 패널·오버레이), IPC, app:// 프로토콜, 단축키
│   ├── pipeline.ts          # 구간 대기열 → Gemini → (선택) Claude → 자막. 한 번에 1요청, 밀리면 합침
│   ├── quota.ts             # 무료 한도: 모델별 일일 사용량(태평양 시간 자정 초기화), 분당 간격, 429 대기
│   ├── keystore.ts          # 교사 키를 safeStorage(DPAPI)로 암호화 저장
│   ├── settings.ts          # 설정 검증·저장
│   ├── providers/
│   │   ├── gemini.ts        # 오디오 → 받아쓰기·언어 판별·번역 (JSON 스키마 응답)
│   │   ├── claude.ts        # (선택) 문장 번역
│   │   └── errors.ts        # 오류 분류 (분당/일일 한도, 키, 모델, 네트워크)
│   └── lan/server.ts        # 학생 PC 링크: HTTP + SSE, 토큰 주소, 읽기 전용
├── preload/preload.ts       # window.api (키는 화면으로 넘기지 않음)
├── renderer/
│   ├── audio/               # AudioWorklet 캡처 → 16kHz 다운샘플 → 에너지 VAD·구간 묶기
│   ├── control/             # 교사용 컨트롤 패널
│   └── overlay/             # 투명·항상 위·클릭 통과 자막 창
├── student/                 # 학생 PC 화면 (LAN 서버가 제공)
└── shared/                  # 타입, 언어 목록, 지시문·응답 해석, WAV
```

## 동작 요약
- 마이크 → `capture-worklet` → `StreamingDownsampler`(16kHz) → `Segmenter`(쉼 기준으로 3~12초 구간, 절약 모드 8~20초, 일정한 소음은 버림)
- 구간 → IPC(`audio:segment`) → `Pipeline` → `GeminiClient.transcribe`(WAV inline + 지시문 + 직전 문맥 + 용어집)
- 결과 → 컨트롤 패널·오버레이·학생 링크로 전달
- 무료 한도: SDK 자동 재시도는 끄고(`retryOptions.attempts = 1`) 파이프라인이 429 의 `retryDelay` 를 보고 기다린다
