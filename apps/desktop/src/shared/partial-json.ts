// 스트리밍으로 받는 중인 (아직 끝나지 않은) JSON 앞부분을 최대한 읽어낸다.
// 예) {"lang":"ko","transcript":"오늘은 광합  →  { lang: 'ko', transcript: '오늘은 광합' }

/** 열린 문자열·배열·객체를 닫아서 JSON.parse 해 본다. 안 되면 마지막 쉼표 앞까지 줄여서 다시 */
export function parsePartialJson(prefix: string): unknown {
  let text = prefix.trim();
  for (let attempt = 0; attempt < 6 && text.length > 0; attempt++) {
    const repaired = close(text);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired);
      } catch {
        // 끝에 값이 없는 키 등 → 아래에서 잘라낸다
      }
    }
    const cut = lastTopLevelCut(text);
    if (cut === null) return undefined;
    text = text.slice(0, cut);
  }
  return undefined;
}

function close(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  let out = text;
  if (inString) {
    if (escaped) out = out.slice(0, -1); // 끊긴 \ 는 버린다
    out += '"';
  }
  out = out.replace(/[\s,:]+$/, '');
  return out + stack.reverse().join('');
}

/** 문자열 밖에 있는 마지막 쉼표 위치 */
function lastTopLevelCut(text: string): number | null {
  let inString = false;
  let escaped = false;
  let last: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ',') last = i;
  }
  return last;
}
