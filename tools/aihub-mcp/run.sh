#!/bin/bash
# Claude Code 가 stdio 로 띄우는 AIHub-MCP 실행기 (.mcp.json 에서 호출).
# 표준출력은 MCP 프로토콜 전용이라 안내 문구는 모두 stderr 로 쓴다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$HERE/mcp-server.jar"

[ -f "$JAR" ] || "$HERE/build.sh" >&2

# 서버는 AIHUB_API_KEY 가 비어 있으면 시작하지 않는다.
# - 클라우드 세션: 환경의 네트워크 시크릿이 X-API-KEY 헤더를 실제 키로 바꿔 붙이므로 자리표시 값이면 된다.
# - 내 PC: AIHUB_API_KEY 환경 변수에 AI 허브에서 발급받은 키를 넣는다 (저장소에는 넣지 않는다).
if [ -z "${AIHUB_API_KEY:-}" ]; then
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    export AIHUB_API_KEY="set-by-network-secret"
  else
    echo "aihub-mcp: AIHUB_API_KEY 환경 변수를 설정해 주세요" >&2
    exit 1
  fi
fi

# 서버가 현재 폴더에 logs/ 를 만들므로 전용 폴더에서 실행한다
mkdir -p "$HERE/.run"
cd "$HERE/.run"
exec java -Dfile.encoding=UTF-8 -jar "$JAR"
