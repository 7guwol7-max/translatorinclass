// 학생 PC 용 자막 링크: 교사 PC 에서 작은 웹 서버를 열고, 같은 학교 네트워크의 학생 PC 가
// http://<교사PC IP>:<포트>/s/<토큰>/ 을 열면 자기 언어 자막을 실시간(SSE)으로 본다.
// 읽기 전용이고, 링크를 켤 때마다 주소의 토큰이 새로 바뀐다.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Caption } from '../../shared/types';
import { languageInfo } from '../../shared/languages';

const MAX_CLIENTS = 200;
const HISTORY = 30;
const PING_MS = 20_000;

const STATIC_FILES: Record<string, string> = {
  '': 'index.html',
  'student.js': 'student.js',
  'student.css': 'student.css',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export interface StudentLanguage {
  code: string;
  native: string;
  ko: string;
  rtl: boolean;
}

export class StudentLinkServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private history: Caption[] = [];
  private token = makeToken();
  private port = 0;
  private ping: NodeJS.Timeout | null = null;

  constructor(
    private readonly staticDir: string,
    private readonly getLanguages: () => string[],
    private readonly onClientsChanged: (count: number) => void = () => undefined,
  ) {}

  get running(): boolean {
    return this.server !== null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(port: number, host = '0.0.0.0'): Promise<void> {
    if (this.server) return;
    this.token = makeToken();
    this.history = [];
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : port;
    this.ping = setInterval(() => this.writeAll(': ping\n\n'), PING_MS);
  }

  async stop(): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.onClientsChanged(0);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 학생에게 알려줄 주소들 (네트워크 카드가 여러 개면 여러 개) */
  urls(): string[] {
    if (!this.server) return [];
    return lanAddresses().map((ip) => `http://${ip}:${this.port}/s/${this.token}/`);
  }

  /** 테스트용: 이 PC 안에서 여는 주소 */
  localUrl(): string {
    return `http://127.0.0.1:${this.port}/s/${this.token}/`;
  }

  /** 받는 중인 자막(final=false)도 보내고, 같은 id 가 다시 오면 기록을 바꿔 둔다 */
  broadcast(caption: Caption): void {
    const slim = {
      id: caption.id,
      seq: caption.seq,
      ts: caption.ts,
      speaker: caption.speaker,
      lang: caption.lang,
      transcript: caption.transcript,
      translations: caption.translations,
      final: caption.final,
    };
    const index = this.history.findIndex((c) => c.id === slim.id);
    if (index >= 0) this.history[index] = slim as Caption;
    else this.history.push(slim as Caption);
    this.history.sort((a, b) => a.seq - b.seq);
    while (this.history.length > HISTORY) this.history.shift();
    this.writeAll(sse('caption', slim));
  }

  /** 학생 언어 목록이 바뀌었을 때 */
  refreshConfig(): void {
    this.writeAll(sse('config', this.config()));
  }

  private config(): { languages: StudentLanguage[] } {
    const languages = this.getLanguages()
      .map((code) => languageInfo(code))
      .filter((l): l is NonNullable<typeof l> => l !== undefined && l.code !== 'ko')
      .map((l) => ({ code: l.code, native: l.native, ko: l.ko, rtl: Boolean(l.rtl) }));
    return { languages };
  }

  private writeAll(chunk: string): void {
    for (const res of this.clients) res.write(chunk);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.text(res, 405, 'Method Not Allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/');
    // ['', 's', token, ...rest]
    if (parts[1] !== 's' || parts[2] !== this.token) {
      return this.text(res, 404, '링크가 맞지 않거나 수업이 끝났습니다. 선생님께 새 링크를 받으세요.\nThis link is not valid. Please ask your teacher for a new link.');
    }
    if (parts.length === 3) {
      res.writeHead(301, { Location: `/s/${this.token}/`, ...SECURITY_HEADERS });
      return void res.end();
    }
    const rest = parts.slice(3).join('/');
    if (rest === 'events') return this.openStream(req, res);
    const file = STATIC_FILES[rest];
    if (!file) return this.text(res, 404, 'Not Found');
    try {
      const body = await fs.readFile(path.join(this.staticDir, file));
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      this.text(res, 500, '학생 화면 파일을 찾을 수 없습니다');
    }
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.clients.size >= MAX_CLIENTS) return this.text(res, 503, '접속자가 너무 많습니다');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 3000\n\n');
    res.write(sse('config', this.config()));
    for (const caption of this.history) res.write(sse('caption', caption));
    this.clients.add(res);
    this.onClientsChanged(this.clients.size);
    req.on('close', () => {
      this.clients.delete(res);
      this.onClientsChanged(this.clients.size);
    });
  }

  private text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(body);
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeToken(): string {
  // 읽기 쉬운 문자만 (0/O, 1/l 제외) 8자리
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** 학교 내부망(사설 IP) 주소를 우선으로 정렬 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal || addr.address.startsWith('169.254.')) continue;
      out.push(addr.address);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}
