# translatorinclass — 교실 실시간 통역 오버레이

교사가 한국어로 설명하면 **다른 창들 위에 떠 있는 자막**으로 한국어 원문과 학생 언어 번역이 나타나고,
외국어를 쓰는 학생이 말하면 **언어를 자동 인식**해서 한국어로 통역해 보여주는 데스크톱 앱입니다.
**교사 PC(Windows) 전용**이며 교사만 조작합니다. 학생 PC 는 선택 기능인 링크로 자막만 볼 수 있습니다.

## 내려받기 (Windows)

| | |
| --- | --- |
| **설치판** | [ClassroomInterpreter-Setup.exe](https://github.com/7guwol7-max/translatorinclass/releases/latest/download/ClassroomInterpreter-Setup.exe) |
| **설치 없는 판** | [ClassroomInterpreter-Portable-win-x64.zip](https://github.com/7guwol7-max/translatorinclass/releases/latest/download/ClassroomInterpreter-Portable-win-x64.zip) |

GitHub 계정 없이 누구나 받을 수 있습니다. 사용법은 [교사용 안내](docs/TEACHER_GUIDE.md)를 보세요.

## 문서
- **사용 안내(교사용)**: [docs/TEACHER_GUIDE.md](docs/TEACHER_GUIDE.md)
- 앱 코드: [apps/desktop](apps/desktop/README.md)
- 전체 구상: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 무료 모드(교사 본인 Gemini 키): [docs/GEMINI_BYOK.md](docs/GEMINI_BYOK.md)
- 데이터 조사 도구: [AIHub-MCP](https://github.com/aihub-git/AIHub-MCP) — AI 허브 **데이터셋 메타데이터** 조회용 MCP 서버
  → Claude 에 연결하는 방법: [tools/aihub-mcp](tools/aihub-mcp/README.md) (Claude Code 클라우드 세션은 자동, Claude Desktop 은 설정 예시)
  (실시간 STT/번역 엔진이 아니라, 평가·용어집·미세조정에 쓸 데이터를 찾는 개발 단계 도구)

## 구성 요약

| 구성요소 | 상태 | 역할 |
| --- | --- | --- |
| `apps/desktop` (Electron) | ✅ MVP | 자막 오버레이(항상 위·투명·클릭 통과) + 컨트롤 패널 + Gemini 무료 받아쓰기·번역 + (시험) Gemini Live 모드 + (선택) Claude 번역 + (선택) 학생 PC 링크 |
| `services/speech-gateway` | 예정 (선택) | 로컬 Whisper 등 음성을 밖으로 보내지 않는 모드용 사이드카 |
| `apps/desktop` → **AI 허브 데이터** | ✅ | 교사 본인 AI 허브 키로 학급 언어 번역 데이터셋 검색·상세(메타데이터만, AIHub-MCP 와 같은 `/mcp/*.do` API) |
| `tools/data-pipeline` | 예정 | AI 허브 데이터로 평가셋·교과 용어집 (교사 PC 로컬 전용, 재배포 금지) |

## API 키

- **Gemini·Claude·AI 허브 키**: 선생님이 앱 설정 화면에 직접 넣습니다. 교사 PC 의 Windows 암호화 저장소(DPAPI)에만 저장되고, 저장소나 설치 파일에는 들어가지 않습니다.
- **개발용 키**: `.env.example`을 복사해 `.env`를 만들고 값을 채웁니다. `.env`는 커밋하지 않습니다.
  `AIHUB_API_KEY`는 개발·데이터 파이프라인 전용이며 앱 배포물에 넣지 않습니다.
