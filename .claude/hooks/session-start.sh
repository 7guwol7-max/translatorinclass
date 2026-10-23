#!/bin/bash
# 클라우드 세션 시작 시: 데스크톱 앱 테스트·타입 검사용 의존성 + AIHub-MCP 서버 jar 준비
# 안내는 stderr 로만 쓴다 (stdout 은 세션 문맥에 들어간다).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# 데스크톱 앱 (vitest·tsc·esbuild·electron)
(cd apps/desktop && npm install --no-audit --no-fund) >&2

# AIHub-MCP (.mcp.json 의 aihub-mcp). 실패해도 세션은 계속한다.
bash tools/aihub-mcp/build.sh || echo "aihub-mcp: jar 를 만들지 못했습니다 — 'bash tools/aihub-mcp/build.sh' 로 다시 시도하세요" >&2
