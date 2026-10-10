# translatorinclass — 교실 실시간 통역 오버레이

교사가 한국어로 설명하면 **다른 창들 위에 떠 있는 자막**으로 한국어 원문과 학생 언어 번역이 나타나고,
외국어를 쓰는 학생이 말하면 **언어를 자동 인식**해서 한국어로 통역해 보여주는 데스크톱 앱입니다.

- 전체 구상: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 데이터 조사 도구: [AIHub-MCP](https://github.com/aihub-git/AIHub-MCP) — AI 허브 **데이터셋 메타데이터** 조회용 MCP 서버
  (실시간 STT/번역 엔진이 아니라, 평가·용어집·미세조정에 쓸 데이터를 찾는 개발 단계 도구)

## 구성 요약

| 구성요소 | 역할 |
| --- | --- |
| `apps/desktop` (Electron) | 항상 위·투명·클릭 통과 자막 오버레이 + 교사용 컨트롤 패널 |
| `services/speech-gateway` (FastAPI) | VAD → 언어 식별 → STT → 번역, **API 키는 여기에만 보관** |
| `tools/aihub-mcp`, `tools/data-pipeline` | AIHub MCP로 데이터 조사 → 평가셋·교과 용어집·미세조정 |

## API 키

`.env.example`을 복사해 `.env`를 만들고 값을 채웁니다. `.env`는 커밋하지 않습니다.
`AIHUB_API_KEY`는 개발·데이터 파이프라인 전용이며 앱 배포물에 넣지 않습니다.
