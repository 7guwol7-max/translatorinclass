import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { StudentLinkServer } from '../src/main/lan/server';
import type { Caption } from '../src/shared/types';

const staticDir = path.join(__dirname, '..', 'src', 'student'); // index.html, student.css (student.js 는 빌드 산출물)
let server: StudentLinkServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

function get(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
}

/** SSE 를 열고 원하는 텍스트가 올 때까지 읽는다 */
function readEvents(url: string, until: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (until(text)) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
  });
}

const caption: Caption = { id: 'c1', seq: 0, ts: 1, speaker: 'teacher', lang: 'ko', transcript: '안녕하세요', translations: { vi: 'Xin chào' }, latencyMs: 900, final: true };

describe('StudentLinkServer', () => {
  it('토큰이 맞을 때만 학생 화면을 준다', async () => {
    server = new StudentLinkServer(staticDir, () => ['vi']);
    await server.start(0, '127.0.0.1');
    const ok = await get(server.localUrl());
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('수업 자막');
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
    const wrong = await get(server.localUrl().replace(/\/s\/[a-z0-9]+\//, '/s/wrongtoken/'));
    expect(wrong.status).toBe(404);
    expect((await get(server.localUrl() + '../../../package.json')).status).toBe(404);
  });

  it('접속하면 언어 목록과 지난 자막을 보내고, 새 자막을 실시간으로 보낸다', async () => {
    const counts: number[] = [];
    server = new StudentLinkServer(staticDir, () => ['vi', 'ko', 'ar'], (n) => counts.push(n));
    await server.start(0, '127.0.0.1');
    server.broadcast(caption);
    const first = await readEvents(server.localUrl() + 'events', (t) => t.includes('"id":"c1"'));
    expect(first).toContain('event: config');
    expect(first).toContain('"code":"vi"');
    expect(first).toContain('"code":"ar","native":"العربية","ko":"아랍어","rtl":true');
    expect(first).not.toContain('"code":"ko"');
    expect(first).not.toContain('latencyMs');

    const live = readEvents(server.localUrl() + 'events', (t) => t.includes('"id":"c2"'));
    await new Promise((r) => setTimeout(r, 50));
    server.broadcast({ ...caption, id: 'c2', transcript: '다음 문장' });
    expect(await live).toContain('다음 문장');
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(1);
  });

  it('받는 중 자막이 확정되면 기록을 바꿔 둔다 (나중에 들어온 학생은 확정본만 받는다)', async () => {
    server = new StudentLinkServer(staticDir, () => ['vi']);
    await server.start(0, '127.0.0.1');
    server.broadcast({ ...caption, id: 'p1', seq: 3, transcript: '오늘은', final: false });
    server.broadcast({ ...caption, id: 'p1', seq: 3, transcript: '오늘은 광합성', final: true });
    server.broadcast({ ...caption, id: 'p0', seq: 2, transcript: '앞 문장', final: true });
    const text = await readEvents(server.localUrl() + 'events', (t) => (t.match(/event: caption/g) ?? []).length >= 2);
    expect(text).not.toContain('"transcript":"오늘은"');
    expect(text.indexOf('앞 문장')).toBeLessThan(text.indexOf('오늘은 광합성')); // seq 순서
  });

  it('다시 시작하면 토큰이 바뀌어 이전 링크가 막힌다', async () => {
    server = new StudentLinkServer(staticDir, () => ['vi']);
    await server.start(0, '127.0.0.1');
    const before = server.localUrl();
    await server.stop();
    await server.start(0, '127.0.0.1');
    expect(server.localUrl()).not.toBe(before);
  });
});
