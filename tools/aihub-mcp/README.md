# AIHub-MCP 연결

[aihub-git/AIHub-MCP](https://github.com/aihub-git/AIHub-MCP)(AI 허브 공식 MCP 서버)를 Claude 에 연결해
"다국어 통번역 데이터셋 5개 보여줘", "71686 데이터의 파일 용량 알려줘" 처럼 말로 AI 허브 **데이터셋 메타데이터**를 찾습니다.
데이터 파일을 내려받지는 않습니다. 교실 통역 앱(apps/desktop)은 같은 AI 허브 API 를 직접 부르므로 이 MCP 없이도 동작합니다.

| 파일 | 하는 일 |
| --- | --- |
| `build.sh` | 정해 둔 커밋(`22593b3`)의 공식 소스를 받아 Maven 으로 `mcp-server.jar` 를 만든다. 같은 커밋이면 건너뜀 |
| `run.sh` | Claude Code 가 stdio 로 띄우는 실행기 (저장소 맨 위 `.mcp.json` 에 등록) |

jar·빌드 폴더·로그는 저장소에 올리지 않습니다 (`.gitignore`).

## 1. Claude Code 클라우드 세션 (이 저장소)
설정은 이미 들어 있습니다 (모두 저장소 맨 위 기준): `.mcp.json`(서버 등록), `.claude/settings.json`(서버 허용 + 세션 시작 훅),
`.claude/hooks/session-start.sh`(세션이 시작될 때 jar 를 만듦).

키는 저장소나 채팅에 넣지 않고 **환경의 네트워크 시크릿**에 둡니다.
- 도메인: `aihub.or.kr`
- 헤더 이름: `X-API-KEY`, 접두어: 없음(빈칸)
- 값: AI 허브에서 발급받은 키 (키를 새로 발급받으면 이전 키는 쓸 수 없으니 여기 값도 바꿔 주세요)

`run.sh` 는 키 자리에 자리표시 값을 넣어 서버를 띄우고, 프록시가 요청마다 실제 키로 바꿔 붙입니다.
새 세션에서 `/mcp` 를 입력하면 `aihub-mcp` 가 연결됐는지 볼 수 있습니다.

## 2. 내 PC 의 Claude Desktop (Windows)
1. **Java 17 이상** 설치 (예: [Eclipse Temurin 17](https://adoptium.net/temurin/releases/?version=17))
2. **서버 jar 받기**: AIHub-MCP [릴리스](https://github.com/aihub-git/AIHub-MCP/releases/tag/AIHub-MCP)에서 jar 파일(공식 안내의 이름: `mcp-server-0.0.1-SNAPSHOT.jar`)을 받아 예: `C:\aihub-mcp\` 에 둡니다.
3. Claude Desktop → **설정 → 개발자 → 구성 편집** → `claude_desktop_config.json` 에 추가:
   ```json
   {
     "mcpServers": {
       "aihub-mcp": {
         "command": "<java.exe 경로>",
         "args": ["-Dfile.encoding=UTF-8", "-jar", "C:\\aihub-mcp\\mcp-server-0.0.1-SNAPSHOT.jar"],
         "env": { "AIHUB_API_KEY": "<발급받은 AI 허브 키>" }
       }
     }
   }
   ```
   - `<java.exe 경로>` 는 명령 프롬프트에서 `where java` 로 나온 경로로 바꾸고 `\` 는 `\\` 로 적습니다
     (예: `C:\\Program Files\\Eclipse Adoptium\\jdk-17…-hotspot\\bin\\java.exe`).
   - 키는 이 파일에만 적고, 다른 사람과 공유하거나 저장소에 올리지 마세요.
4. Claude Desktop 을 완전히 종료했다가 다시 켜면 도구 목록에 `aihub-mcp` 가 보입니다.

## 3. 내 PC 의 Claude Code
이 저장소를 내려받은 폴더에서 `bash tools/aihub-mcp/build.sh` 로 jar 를 만들고,
`AIHUB_API_KEY` 환경 변수에 키를 넣은 뒤 `claude` 를 실행하면 `.mcp.json` 의 서버가 연결됩니다.

## 도구
| 도구 | 하는 일 |
| --- | --- |
| `searchDataSets` | 검색어·분야·유형·구축년도로 목록 (예: "러시아어" 4건) |
| `countDataSets` | 조건에 맞는 개수 |
| `getDataSet` | 번호로 상세 (예: 71686 다국어 일상대화 실시간 통번역 데이터) |
| `describeDataSet` | 이름으로 찾아 간략 소개 |
| `getDataSetsWithGuide` | 데이터 설명서·구축활용가이드(MD)가 있는 데이터셋 |

AI 허브 검색은 낱말이 그대로 들어간 데이터만 찾습니다. "러시아어 번역"보다 "러시아어"처럼 짧게 찾는 편이 더 많이 나옵니다.

## 문제 해결
| 증상 | 해결 |
| --- | --- |
| "유효하지 않은 API 키" | 키를 새로 발급받았다면 이전 키는 막힙니다. 네트워크 시크릿(또는 Desktop 설정)의 값을 새 키로 바꾸기 |
| "API 키가 없습니다" | 시크릿 헤더 이름이 `X-API-KEY`, 접두어가 빈칸인지 확인 |
| `/mcp` 에 aihub-mcp 가 실패로 보임 | `bash tools/aihub-mcp/build.sh` 실행 후 다시 연결. Java 17+·Maven 필요 |
