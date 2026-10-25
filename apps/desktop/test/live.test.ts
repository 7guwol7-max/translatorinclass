import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { guessLanguage, joinTranscript, liveTargets, liveTranslateModels, pickLiveModel } from '../src/shared/live';
import {
  ServerMessageReader,
  classifyLiveClose,
  connectLive,
  liveSetupMessage,
  parseDurationMs,
  pcm16Base64,
  type LiveConnection,
  type LiveHandlers,
} from '../src/main/providers/gemini-live';
import { LiveEngine } from '../src/main/live';
import { ProviderError } from '../src/main/providers/errors';
import type { CaptionSlot } from '../src/main/pipeline';
import { sanitizeSettings } from '../src/main/settings';
import { DEFAULT_SETTINGS, type Caption, type Channel, type LiveStatus, type Settings, type StatusMessage } from '../src/shared/types';

const second = (n: number) => new Float32Array(Math.round(16000 * n));

function noopHandlers(overrides: Partial<LiveHandlers> = {}): LiveHandlers {
  return {
    onInput: () => undefined,
    onOutput: () => undefined,
    onTurnEnd: () => undefined,
    onUsage: () => undefined,
    onGoAway: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

describe('Live 도움 함수', () => {
  it('채널마다 열 세션의 목표 언어', () => {
    expect(liveTargets('teacher', ['vi', 'zh'])).toEqual(['vi', 'zh']);
    expect(liveTargets('student', ['vi', 'zh'])).toEqual(['ko']);
    expect(liveTargets('auto', ['vi', 'zh', 'vi'])).toEqual(['vi', 'zh', 'ko']);
  });

  it('Live 모델 중 실시간 번역 모델만, 안정판·최신 먼저', () => {
    const names = ['models/gemini-3.8-live', 'gemini-3.5-live-translate-preview', 'gemini-3.5-transcribe-live', 'gemini-4-live-translate', 'gemini-3.5-flash'];
    expect(liveTranslateModels(names)).toEqual(['gemini-4-live-translate', 'gemini-3.5-live-translate-preview']);
    expect(pickLiveModel(names, 'gemini-3.5-live-translate-preview')).toBe('gemini-3.5-live-translate-preview');
    expect(pickLiveModel(names, 'gemini-9-live-translate')).toBe('gemini-4-live-translate');
    expect(pickLiveModel([], 'gemini-9-live-translate')).toBe('gemini-9-live-translate'); // 목록을 아직 모르면 그대로
  });

  it('받아쓰기 조각을 잇는다 (지금까지 전체를 다시 보내면 바꿔 쓴다)', () => {
    expect(joinTranscript('', '오늘은')).toBe('오늘은');
    expect(joinTranscript('오늘은', ' 광합성')).toBe('오늘은 광합성');
    expect(joinTranscript('오늘은', '오늘은 광합성')).toBe('오늘은 광합성');
  });

  it('글자로 언어를 짐작한다', () => {
    const langs = ['ko', 'vi', 'zh', 'ru', 'mn', 'uz'];
    expect(guessLanguage('오늘은 광합성을 배워요', langs)).toBe('ko');
    expect(guessLanguage('Thưa cô, em không hiểu', langs)).toBe('vi');
    expect(guessLanguage('老师，我不明白', langs)).toBe('zh');
    expect(guessLanguage('Учитель, я не понимаю', langs)).toBe('ru');
    expect(guessLanguage('Багш аа, би ойлгохгүй байна. Өнөөдөр', langs)).toBe('mn');
    expect(guessLanguage('Ustoz, men tushunmadim', langs)).toBe('uz'); // 베트남어 성조 표시가 없는 라틴 글자 → 남은 라틴 언어 하나
    expect(guessLanguage('Teacher, I do not understand', ['ko', 'uz', 'en'])).toBe('');
    expect(guessLanguage('?!', langs)).toBe('');
  });
});

describe('Gemini Live 메시지', () => {
  it('설정 메시지: 목표 언어 하나, 따라 말하기 끔, 받아쓰기·번역 글자 받기', () => {
    expect(liveSetupMessage('gemini-3.5-live-translate-preview', 'vi')).toEqual({
      setup: {
        model: 'models/gemini-3.5-live-translate-preview',
        generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: 'vi', echoTargetLanguage: false } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  });

  it('소리를 16비트 PCM 으로 바꾼다', () => {
    const bytes = Buffer.from(pcm16Base64(Float32Array.from([0, 1, -1, 2])), 'base64');
    expect([...new Int16Array(bytes.buffer, bytes.byteOffset, 4)]).toEqual([0, 32767, -32768, 32767]);
    expect(parseDurationMs('9.5s')).toBe(9500);
    expect(parseDurationMs(undefined)).toBe(0);
  });

  it('서버 메시지를 읽고, generationComplete 뒤 turnComplete 는 한 번으로 친다', () => {
    const events: string[] = [];
    const reader = new ServerMessageReader({
      onInput: (t, l, f) => events.push(`in:${t}:${l}:${f}`),
      onOutput: (t, f) => events.push(`out:${t}:${f}`),
      onTurnEnd: () => events.push('turn'),
      onUsage: (n) => events.push(`usage:${n}`),
      onGoAway: (ms) => events.push(`goaway:${ms}`),
    });
    reader.read({ serverContent: { inputTranscription: { text: '안녕', languageCode: 'ko-KR' } } });
    reader.read({ serverContent: { outputTranscription: { text: 'Xin chào' } } });
    reader.read({ serverContent: { generationComplete: true } });
    reader.read({ serverContent: { turnComplete: true }, usageMetadata: { totalTokenCount: 120 } });
    reader.read({ serverContent: { turnComplete: true } }); // generationComplete 없이 끝난 차례
    reader.read({ goAway: { timeLeft: '10s' } });
    expect(events).toEqual(['in:안녕:ko:false', 'out:Xin chào:false', 'turn', 'usage:120', 'turn', 'goaway:10000']);
  });

  it('서버가 닫은 이유를 오류 종류로 나눈다', () => {
    expect(classifyLiveClose(1000, '')).toBeNull();
    expect(classifyLiveClose(1011, 'You exceeded your current quota')?.kind).toBe('rate_limit');
    expect(classifyLiveClose(1008, 'API key not valid. Please pass a valid API key.')?.kind).toBe('auth');
    expect(classifyLiveClose(1008, 'models/foo is not found for API version v1beta')?.kind).toBe('model_not_found');
    expect(classifyLiveClose(1007, 'Invalid JSON payload received. Unknown name "translationConfig"')?.kind).toBe('bad_request');
    expect(classifyLiveClose(1006, '')?.kind).toBe('network');
    expect(classifyLiveClose(1011, 'Internal error encountered.')?.kind).toBe('server');
  });
});

describe('connectLive (가짜 Live 서버)', () => {
  let wss: WebSocketServer | null = null;

  async function serve(onSocket: (socket: ServerSocket, messages: Record<string, unknown>[]) => void, verify?: () => number | null) {
    wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: verify ? (_info, cb) => {
        const status = verify();
        if (status) cb(false, status);
        else cb(true);
      } : undefined,
    });
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    const messages: Record<string, unknown>[] = [];
    const urls: string[] = [];
    wss.on('connection', (socket, req) => {
      urls.push(req.url ?? '');
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      onSocket(socket, messages);
    });
    return { endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/live`, messages, urls };
  }

  afterEach(async () => {
    const server = wss;
    wss = null;
    if (!server) return;
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it('설정을 보내고 setupComplete 를 받으면 연결된다. 소리·말 끝을 보내고 서버 글자를 받는다', async () => {
    const { endpoint, messages, urls } = await serve((socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify({ setupComplete: {} }));
        socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: '오늘은' } } }));
        socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Hôm nay' } } }));
      });
    });
    const got: string[] = [];
    const conn = await connectLive('KEY-1', { model: 'gemini-3.5-live-translate-preview', target: 'vi', endpoint }, noopHandlers({
      onInput: (t) => got.push(`in:${t}`),
      onOutput: (t) => got.push(`out:${t}`),
    }));
    expect(urls[0]).toBe('/live?key=KEY-1');
    expect(messages[0]).toEqual(liveSetupMessage('gemini-3.5-live-translate-preview', 'vi'));
    conn.sendAudio(second(0.1));
    conn.endAudio();
    await until(() => messages.length >= 3 && got.length >= 2);
    const audio = (messages[1].realtimeInput as { audio: { data: string; mimeType: string } }).audio;
    expect(audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(audio.data, 'base64').length).toBe(3200);
    expect(messages[2]).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(got).toEqual(['in:오늘은', 'out:Hôm nay']);
    conn.close();
  });

  it('서버가 설정을 거절하고 닫으면 그 이유로 실패한다', async () => {
    const { endpoint } = await serve((socket) => {
      socket.once('message', () => socket.close(1008, 'models/gemini-x is not found for API version v1beta'));
    });
    const error = await connectLive('k', { model: 'gemini-x', target: 'vi', endpoint }, noopHandlers()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('model_not_found');
  });

  it('setupComplete 가 오지 않으면 시간 초과로 실패한다 (멈춰 있지 않는다)', async () => {
    const { endpoint } = await serve(() => undefined);
    const error = await connectLive('k', { model: 'm', target: 'vi', endpoint, setupTimeoutMs: 150 }, noopHandlers()).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('network');
  });

  it('연결 단계에서 HTTP 로 거절되면(프록시·방화벽 등) 네트워크 문제로 알린다', async () => {
    const { endpoint } = await serve(() => undefined, () => 404);
    const error = await connectLive('k', { model: 'm', target: 'vi', endpoint }, noopHandlers()).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('network');
    expect((error as ProviderError).message).toContain('HTTP 404');
  });

  it('연결된 뒤 서버가 오류로 닫으면 onClose 로 알리고, 우리가 닫으면 알리지 않는다', async () => {
    let server!: ServerSocket;
    const { endpoint } = await serve((socket) => {
      server = socket;
      socket.once('message', () => socket.send(JSON.stringify({ setupComplete: {} })));
    });
    const closed: (ProviderError | null)[] = [];
    await connectLive('k', { model: 'm', target: 'vi', endpoint }, noopHandlers({ onClose: (e) => closed.push(e) }));
    server.close(1011, 'Internal error encountered.');
    await until(() => closed.length === 1);
    expect(closed[0]?.kind).toBe('server');

    const conn2 = await connectLive('k', { model: 'm', target: 'zh', endpoint }, noopHandlers({ onClose: (e) => closed.push(e) }));
    conn2.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toHaveLength(1);
  });
});

// ── 엔진 ─────────────────────────────────────────────────────────

class FakeConn implements LiveConnection {
  samples = 0;
  ends = 0;
  closed = false;
  constructor(readonly target: string, readonly h: LiveHandlers) {}
  sendAudio(pcm: Float32Array): void {
    this.samples += pcm.length;
  }
  endAudio(): void {
    this.ends++;
  }
  close(): void {
    this.closed = true;
  }
}

type Connect = (model: string, target: string, handlers: LiveHandlers) => Promise<LiveConnection>;

function engineSetup(overrides: Partial<Settings> = {}, connect?: Connect) {
  const settings: Settings = { ...DEFAULT_SETTINGS, liveMode: true, studentLanguages: ['vi', 'zh'], ...overrides };
  const conns: FakeConn[] = [];
  const captions: Caption[] = [];
  const statuses: StatusMessage[] = [];
  const liveStatuses: LiveStatus[] = [];
  const fallbacks: { channel: Channel; samples: number; slot?: CaptionSlot }[] = [];
  const latencies: number[] = [];
  let seq = 0;
  const engine = new LiveEngine({
    getSettings: () => settings,
    connect: connect ?? (async (_model, target, h) => {
      const c = new FakeConn(target, h);
      conns.push(c);
      return c;
    }),
    onCaption: (c) => captions.push(c),
    onStatus: (m) => statuses.push(m),
    onLiveStatus: (s) => liveStatuses.push(s),
    fallback: (channel, pcm, slot) => fallbacks.push({ channel, samples: pcm.length, slot }),
    nextSeq: () => seq++,
    noteLatency: (ms) => latencies.push(ms),
  });
  const conn = (target: string) => conns.filter((c) => c.target === target).at(-1)!;
  /** 말 한 덩이를 0.1초씩 흘려 보낸다 */
  const speak = (channel: Channel, id: number, sec: number) => {
    for (let i = 0; i < Math.round(sec * 10); i++) engine.audio(channel, id, second(0.1));
  };
  const finals = () => captions.filter((c) => c.final);
  return { engine, settings, conns, conn, captions, finals, statuses, liveStatuses, fallbacks, latencies, speak };
}

describe('LiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-25T01:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('교사 말: 학생 언어마다 세션을 열고, 말하는 동안 자막을 보여 준 뒤 서버가 마치면 확정한다', async () => {
    const t = engineSetup();
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.conns.map((c) => c.target)).toEqual(['vi', 'zh']);
    expect(t.engine.status()).toMatchObject({ state: 'on', ready: 2, wanted: 2 });

    t.speak('teacher', 1, 1);
    expect(t.conn('vi').samples).toBe(16000);
    t.conn('vi').h.onInput('오늘은 ', 'ko', false);
    t.conn('zh').h.onInput('오늘은 광합성을', 'ko', false); // 받아쓰기는 먼저 보낸 세션 것만 쓴다
    t.conn('vi').h.onInput('광합성을 배워요', '', false);
    t.conn('vi').h.onOutput('Hôm nay ', false);
    t.conn('zh').h.onOutput('今天', false);
    await vi.advanceTimersByTimeAsync(150);
    const partial = t.captions.at(-1)!;
    expect(partial).toMatchObject({ final: false, speaker: 'teacher', lang: 'ko', transcript: '오늘은 광합성을 배워요', translations: { vi: 'Hôm nay', zh: '今天' } });

    t.engine.segment('teacher', 1, second(1));
    t.engine.end('teacher', 1);
    expect(t.conn('vi').ends).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    t.conn('vi').h.onOutput('chúng ta học quang hợp', false);
    t.conn('vi').h.onTurnEnd();
    t.conn('zh').h.onOutput('学习光合作用', false);
    t.conn('zh').h.onTurnEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.finals()).toHaveLength(1);
    expect(t.finals()[0]).toMatchObject({
      id: partial.id,
      seq: 0,
      transcript: '오늘은 광합성을 배워요',
      translations: { vi: 'Hôm nay chúng ta học quang hợp', zh: '今天学习光合作用' },
    });
    expect(t.latencies).toEqual([300]); // 말이 끝나고 마지막 번역 글자까지
    expect(t.fallbacks).toHaveLength(0);
  });

  it('서버가 끝을 알리지 않아도 글자가 멈추면 확정한다', async () => {
    const t = engineSetup({ studentLanguages: ['vi'] });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 1, 1);
    t.conn('vi').h.onInput('네', 'ko', false);
    t.conn('vi').h.onOutput('Vâng', false);
    t.engine.end('teacher', 1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(t.finals()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.finals()).toHaveLength(1);
    expect(t.finals()[0].translations).toEqual({ vi: 'Vâng' });
  });

  it('답이 없으면 그 말의 구간을 기존 방식으로 넘기고 같은 자막 자리를 쓰게 한다', async () => {
    const t = engineSetup();
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 7, 2);
    t.engine.segment('teacher', 7, second(1.5));
    t.engine.segment('teacher', 7, second(0.5)); // 길어서 강제로 잘린 같은 말
    t.engine.end('teacher', 7);
    const endedAt = Date.now();
    await vi.advanceTimersByTimeAsync(3_900);
    expect(t.fallbacks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.fallbacks).toHaveLength(1);
    expect(t.fallbacks[0]).toMatchObject({ channel: 'teacher', samples: 32000, slot: { seq: 0, endedAt } });
    expect(t.fallbacks[0].slot?.id).toMatch(/^live-/);
  });

  it('받아쓰기만 오고 번역이 하나도 없으면 기존 방식이 같은 자리를 다시 쓴다', async () => {
    const t = engineSetup();
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 1, 1);
    t.engine.segment('teacher', 1, second(1));
    t.conn('vi').h.onInput('자 여러분', 'ko', false);
    t.engine.end('teacher', 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.finals()).toHaveLength(0);
    expect(t.fallbacks).toHaveLength(1);
    expect(t.fallbacks[0].slot?.id).toBe(t.captions[0].id);
  });

  it('잡음(구간이 버려진 말)에 답이 없는 것은 놓침으로 세지 않는다', async () => {
    const t = engineSetup();
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    for (let id = 1; id <= 5; id++) {
      t.speak('teacher', id, 0.5);
      t.engine.end('teacher', id);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(t.fallbacks).toHaveLength(0);
    expect(t.engine.handles('teacher')).toBe(true);
  });

  it('연달아 3번 답이 없으면 이번 수업은 기존 방식으로 바꾼다', async () => {
    const t = engineSetup();
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    for (let id = 1; id <= 3; id++) {
      t.speak('teacher', id, 2);
      t.engine.segment('teacher', id, second(2));
      t.engine.end('teacher', id);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(t.fallbacks).toHaveLength(3);
    expect(t.engine.handles('teacher')).toBe(false);
    expect(t.engine.status()).toMatchObject({ state: 'fallback' });
    expect(t.statuses.at(-1)?.text).toContain('지금까지 쓰던 방식');
    expect(t.conns.every((c) => c.closed)).toBe(true);
    // 그 뒤의 말은 바로 기존 방식으로
    t.speak('teacher', 4, 1);
    t.engine.segment('teacher', 4, second(1));
    expect(t.fallbacks).toHaveLength(4);
    expect(t.fallbacks[3].slot).toBeUndefined();
    // 다음 수업에서는 다시 해 본다
    t.engine.stop();
    t.engine.start(['teacher']);
    expect(t.engine.handles('teacher')).toBe(true);
  });

  it('모델을 쓸 수 없으면 바로 기존 방식으로 바꾸고 이유를 알린다', async () => {
    const t = engineSetup({}, async () => {
      throw new ProviderError('model_not_found', '이 키로 쓸 수 없는 Live 모델입니다');
    });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engine.handles('teacher')).toBe(false);
    expect(t.engine.status()).toMatchObject({ state: 'fallback', message: '이 키로 쓸 수 없는 Live 모델입니다' });
    expect(t.statuses).toHaveLength(1);
    t.engine.segment('teacher', 1, second(1));
    expect(t.fallbacks).toHaveLength(1);
  });

  it('연결 오류는 한 번 다시 해 보고, 연결되는 동안 들어온 소리는 연결되면 보낸다', async () => {
    let attempts = 0;
    const conns: FakeConn[] = [];
    const t = engineSetup({ studentLanguages: ['vi'] }, async (_m, target, h) => {
      attempts++;
      if (attempts === 1) throw new ProviderError('network', '인터넷 연결을 확인해 주세요');
      const c = new FakeConn(target, h);
      conns.push(c);
      return c;
    });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.engine.status().state).toBe('connecting');
    t.speak('teacher', 1, 0.5);
    t.engine.end('teacher', 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    expect(conns[0].samples).toBe(8000);
    expect(conns[0].ends).toBe(1);
    expect(t.engine.handles('teacher')).toBe(true);
  });

  it('함께 쓰는 마이크: 교사 말은 학생 언어로, 학생 말은 한국어 세션 번역만 쓴다', async () => {
    const t = engineSetup({ teacherMicMode: 'auto' });
    t.engine.start(['auto']);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.conns.map((c) => c.target)).toEqual(['vi', 'zh', 'ko']);

    // 교사 (한국어 세션은 자기 언어라 아무것도 내지 않는다)
    t.speak('auto', 1, 1);
    t.conn('vi').h.onInput('질문 있어요?', 'ko', false);
    t.conn('vi').h.onOutput('Có câu hỏi không?', false);
    t.conn('zh').h.onOutput('有问题吗？', false);
    t.engine.end('auto', 1);
    t.conn('vi').h.onTurnEnd();
    t.conn('zh').h.onTurnEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.finals()[0]).toMatchObject({ speaker: 'teacher', lang: 'ko', translations: { vi: 'Có câu hỏi không?', zh: '有问题吗？' } });

    // 학생 (베트남어)
    t.speak('auto', 2, 1);
    t.conn('vi').h.onInput('Thưa cô, em không hiểu', '', false);
    t.conn('ko').h.onOutput('선생님, 이해가 안 돼요', false); // 앞 교사 말은 이 세션과 상관없으므로 건너뛴다
    t.conn('zh').h.onOutput('老师，我不明白', false); // 학생 말의 중국어 번역은 쓰지 않는다
    t.engine.end('auto', 2);
    t.conn('ko').h.onTurnEnd();
    t.conn('vi').h.onTurnEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.finals()).toHaveLength(2);
    expect(t.finals()[1]).toMatchObject({ speaker: 'student', lang: 'vi', transcript: 'Thưa cô, em không hiểu', translations: { ko: '선생님, 이해가 안 돼요' } });
    expect(t.finals()[0].translations.ko).toBeUndefined();
  });

  it('앞 말 번역이 늦게 와도 그 말에 붙이고, 서버가 그 차례를 마친 뒤 온 글자는 다음 말에 붙인다', async () => {
    const t = engineSetup({ studentLanguages: ['vi'] });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    const vi1 = () => t.conn('vi').h;
    t.speak('teacher', 1, 1);
    vi1().onInput('첫 문장', 'ko', false);
    t.engine.end('teacher', 1);
    t.speak('teacher', 2, 0.5); // 바로 다음 말
    vi1().onOutput('Câu đầu', false); // 늦게 온 첫 문장 번역
    vi1().onInput('', '', true);
    vi1().onTurnEnd();
    vi1().onInput('둘째 문장', 'ko', false);
    vi1().onOutput('Câu thứ hai', false);
    t.engine.end('teacher', 2);
    vi1().onTurnEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.finals().map((c) => [c.transcript, c.translations.vi])).toEqual([['첫 문장', 'Câu đầu'], ['둘째 문장', 'Câu thứ hai']]);
    expect(t.finals().map((c) => c.seq)).toEqual([0, 1]);
  });

  it('서버가 곧 끊는다고 하면 말이 없을 때 세션을 새로 연다', async () => {
    const t = engineSetup({ studentLanguages: ['vi'] });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 1, 1);
    t.conn('vi').h.onGoAway(10_000); // 말하는 중에는 기다린다
    expect(t.conns).toHaveLength(1);
    t.conn('vi').h.onInput('네', 'ko', false);
    t.conn('vi').h.onOutput('Vâng', false);
    t.engine.end('teacher', 1);
    t.conn('vi').h.onTurnEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.conns).toHaveLength(2);
    expect(t.conns[0].closed).toBe(true);
    // 예전 연결에서 늦게 온 글자는 무시한다
    t.conns[0].h.onOutput('늦은 글자', false);
    t.speak('teacher', 2, 0.5);
    expect(t.conns[1].samples).toBe(8000);
  });

  it('수업을 끝내면 남은 자막을 잠시 기다렸다가 세션을 닫는다', async () => {
    const t = engineSetup({ studentLanguages: ['vi'] });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 1, 1);
    t.conn('vi').h.onInput('끝', 'ko', false);
    t.engine.stop(); // 끝나지 않은 말은 여기서 끝낸다
    expect(t.conn('vi').ends).toBe(1);
    t.conn('vi').h.onOutput('Hết', false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.finals()[0]?.translations).toEqual({ vi: 'Hết' });
    expect(t.conns[0].closed).toBe(true);
    expect(t.engine.status().state).toBe('idle');
  });

  it('Live 모드가 꺼져 있으면 소리를 보내지 않는다', async () => {
    const t = engineSetup({ liveMode: false });
    t.engine.start(['teacher']);
    await vi.advanceTimersByTimeAsync(0);
    t.speak('teacher', 1, 1);
    expect(t.conns).toHaveLength(0);
    expect(t.engine.status().state).toBe('off');
  });
});

describe('LiveEngine + connectLive (가짜 Live 서버, 실제 WebSocket)', () => {
  it('말하는 동안 번역을 받아 자막을 확정한다', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    // 목표 언어를 기억했다가, 소리가 오면 받아쓰기·번역을, 말 끝이 오면 차례 끝을 보낸다
    wss.on('connection', (socket) => {
      let target = '';
      let answered = false;
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { setup?: { generationConfig: { translationConfig: { targetLanguageCode: string } } }; realtimeInput?: { audio?: unknown; audioStreamEnd?: boolean } };
        if (msg.setup) {
          target = msg.setup.generationConfig.translationConfig.targetLanguageCode;
          socket.send(JSON.stringify({ setupComplete: {} }));
        } else if (msg.realtimeInput?.audio && !answered) {
          answered = true;
          socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: '안녕하세요', languageCode: 'ko' } } }));
          socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: `[${target}] hello` } } }));
        } else if (msg.realtimeInput?.audioStreamEnd) {
          socket.send(JSON.stringify({ serverContent: { generationComplete: true } }));
          socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        }
      });
    });
    const endpoint = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const captions: Caption[] = [];
    const fallbacks: number[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, liveMode: true, studentLanguages: ['vi', 'zh'] };
    const engine = new LiveEngine({
      getSettings: () => settings,
      connect: (model, target, h) => connectLive('k', { model, target, endpoint }, h),
      onCaption: (c) => captions.push(c),
      onStatus: () => undefined,
      onLiveStatus: () => undefined,
      fallback: (_c, pcm) => fallbacks.push(pcm.length),
      nextSeq: () => 0,
      noteLatency: () => undefined,
    });
    try {
      engine.start(['teacher']);
      for (let i = 0; i < 100 && engine.status().state !== 'on'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(engine.status()).toMatchObject({ state: 'on', ready: 2 });
      for (let i = 0; i < 5; i++) engine.audio('teacher', 1, second(0.1));
      engine.segment('teacher', 1, second(0.5));
      engine.end('teacher', 1);
      for (let i = 0; i < 200 && !captions.some((c) => c.final); i++) await new Promise((r) => setTimeout(r, 10));
      expect(captions.find((c) => c.final)).toMatchObject({ speaker: 'teacher', transcript: '안녕하세요', translations: { vi: '[vi] hello', zh: '[zh] hello' } });
      expect(fallbacks).toHaveLength(0);
    } finally {
      engine.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});

describe('Live 설정', () => {
  it('Live 모드·모델·모델 목록을 검증해 저장한다', () => {
    expect(DEFAULT_SETTINGS.liveMode).toBe(false);
    const s = sanitizeSettings({ liveMode: true, liveModel: 'models/gemini-3.5-live-translate-preview', liveModels: ['gemini-3.8-live', 'bad id!', 3 as never] });
    expect(s).toMatchObject({ liveMode: true, liveModel: 'gemini-3.5-live-translate-preview', liveModels: ['gemini-3.8-live'] });
    expect(sanitizeSettings({ liveModel: '../etc' }).liveModel).toBe(DEFAULT_SETTINGS.liveModel);
  });
});
