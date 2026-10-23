#!/bin/bash
# AIHub-MCP 서버(jar)를 정해 둔 커밋의 공식 소스로 만든다. 같은 커밋으로 이미 만들었으면 건너뛴다.
# 필요: git, Java 17+, Maven. 결과: tools/aihub-mcp/mcp-server.jar (저장소에는 올리지 않음)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/aihub-git/AIHub-MCP.git"
COMMIT="22593b3cc82b84c0407c5281cd9613ed8e0c7580"
SRC="$HERE/.build/AIHub-MCP"
JAR="$HERE/mcp-server.jar"
STAMP="$HERE/.build/commit"

if [ -f "$JAR" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$COMMIT" ]; then
  echo "aihub-mcp: 이미 만들어져 있습니다 (${COMMIT:0:7})" >&2
  exit 0
fi
for tool in git java mvn; do
  command -v "$tool" >/dev/null || { echo "aihub-mcp: $tool 이(가) 필요합니다" >&2; exit 1; }
done

rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$SRC" init -q
git -C "$SRC" fetch -q --depth 1 "$REPO_URL" "$COMMIT"
git -C "$SRC" checkout -q FETCH_HEAD
(cd "$SRC" && mvn -q -B -DskipTests package) >&2
cp "$SRC/target/mcp-server-0.0.1-SNAPSHOT.jar" "$JAR"
echo "$COMMIT" > "$STAMP"
echo "aihub-mcp: $JAR 를 만들었습니다 (${COMMIT:0:7})" >&2
