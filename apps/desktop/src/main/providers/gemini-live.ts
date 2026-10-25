// Gemini Live API (WebSocket): 말하는 동안 소리를 흘려 보내고 받아쓰기·번역을 글자로 바로 받는다.
// 실시간 번역 모델(…-live-translate-…)은 세션 하나가 목표 언어 하나만 맡는다.
// 번역된 음성도 오지만 쓰지 않고, 그 음성의 글자(outputTranscription)만 자막으로 쓴다.
// SDK 의 live.connect 는 서버가 설정을 거절하고 끊으면 끝나지 않고 멈춰 있어서, 같은 메시지를 직접 주고받는다.
import WebSocket from 'ws';
import { normalizeLanguageCode } from '../../shared/languages';
import { ProviderError, classifyGeminiError, parseQuotaHint, shorten } from './errors';

export const LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const SETUP_TIMEOUT_MS = 10_000;

export interface LiveHandlers {
  /** 들어온 말의 받아쓰기 조각 (lang: 서버가 알려 준 언어, 없으면 '') */
  onInput(text: string, lang: string, finished: boolean): void;
  /** 번역 조각 */
  onOutput(text: string, finished: boolean): void;
  /** 모델이 한 차례 답을 마침 */
  onTurnEnd(): void;
  /** 지금까지 이 세션이 쓴 토큰 */
  onUsage(totalTokens: number): void;
  /** 서버가 곧 연결을 끊겠다고 알림 */
  onGoAway(timeLeftMs: number): void;
  /** 연결이 끊김 (error 가 null 이면 정상 종료). 우리가 close() 한 경우에는 부르지 않는다 */
  onClose(error: ProviderError | null): void;
}

export interface LiveConnection {
  /** 16kHz mono */
  sendAudio(pcm: Float32Array): void;
  /** 말 한 덩이가 끝남 → 서버가 남은 번역을 바로 마무리한다 */
  endAudio(): void;
  close(): void;
}

export interface LiveOptions {
  model: string;
  /** 번역할 언어 (BCP-47) */
  target: string;
  endpoint?: string;
  setupTimeoutMs?: number;
}

export function liveSetupMessage(model: string, target: string): object {
  return {
    setup: {
      model: `models/${model.replace(/^models\//, '')}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        // 목표 언어로 말하면(예: 한국어 세션에 한국어) 따라 말하지 않는다
        translationConfig: { targetLanguageCode: target, echoTargetLanguage: false },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/** Float32 → 16-bit little-endian PCM → base64 */
export function pcm16Base64(samples: Float32Array): string {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out.toString('base64');
}

/** "9.5s" → 9500 */
export function parseDurationMs(value: unknown): number {
  const m = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value.trim()) : null;
  return m ? Math.round(Number(m[1]) * 1000) : 0;
}

interface TranscriptionMsg {
  text?: string;
  finished?: boolean;
  languageCode?: string;
}

interface ServerMsg {
  setupComplete?: object;
  serverContent?: {
    inputTranscription?: TranscriptionMsg;
    outputTranscription?: TranscriptionMsg;
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
  };
  usageMetadata?: { totalTokenCount?: number };
  goAway?: { timeLeft?: string };
}

/**
 * 서버 메시지를 읽어 handlers 로 넘긴다.
 * generationComplete 뒤에 오는 turnComplete 는 (음성을 재생하는 시간만큼 늦게 오므로) 같은 차례로 보고 한 번만 알린다.
 */
export class ServerMessageReader {
  private generationDone = false;

  constructor(private readonly handlers: Omit<LiveHandlers, 'onClose'>) {}

  read(msg: ServerMsg): void {
    const h = this.handlers;
    const sc = msg.serverContent;
    if (sc) {
      const input = sc.inputTranscription;
      if (input && (input.text || input.finished)) h.onInput(input.text ?? '', normalizeLanguageCode(input.languageCode ?? ''), Boolean(input.finished));
      const output = sc.outputTranscription;
      if (output && (output.text || output.finished)) h.onOutput(output.text ?? '', Boolean(output.finished));
      if (sc.generationComplete) {
        this.generationDone = true;
        h.onTurnEnd();
      }
      if (sc.turnComplete) {
        if (!this.generationDone) h.onTurnEnd();
        this.generationDone = false;
      }
    }
    if (typeof msg.usageMetadata?.totalTokenCount === 'number') h.onUsage(msg.usageMetadata.totalTokenCount);
    if (msg.goAway) h.onGoAway(parseDurationMs(msg.goAway.timeLeft));
  }
}

/** 서버가 연결을 닫은 이유(close code + reason)를 오류 종류로 */
export function classifyLiveClose(code: number, reason: string): ProviderError | null {
  const text = reason.trim();
  if ((code === 1000 || code === 1005) && !/error|exceed|invalid|denied|not found/i.test(text)) return null;
  const message = `Live 연결이 끊겼습니다 (${code}${text ? `: ${shorten(text, 120)}` : ''})`;
  if (/quota|RESOURCE_EXHAUSTED|exceeded|rate limit|too many/i.test(text)) {
    const hint = parseQuotaHint(text);
    return hint?.scope === 'daily' || /per ?day|daily/i.test(text)
      ? new ProviderError('daily_quota', `오늘 Live 무료 한도를 다 썼습니다 (${shorten(text, 120)})`, undefined, hint)
      : new ProviderError('rate_limit', `Live 사용 한도에 걸렸습니다 (${shorten(text, 120)})`, undefined, hint);
  }
  if (/API key|API_KEY|PERMISSION_DENIED|permission|unauthenticated|UNAUTHENTICATED/i.test(text)) {
    return new ProviderError('auth', 'Gemini API 키로 Live 를 쓸 권한이 없습니다');
  }
  if (/not found|NOT_FOUND|not supported|unsupported|is not available/i.test(text)) {
    return new ProviderError('model_not_found', `이 키로 쓸 수 없는 Live 모델입니다 (${shorten(text, 120)})`);
  }
  if (code === 1007 || /invalid|INVALID_ARGUMENT|Unknown name|Cannot find field/i.test(text)) {
    return new ProviderError('bad_request', `Live 설정을 서버가 받지 않았습니다 (${shorten(text, 120)})`);
  }
  if (code === 1006) return new ProviderError('network', 'Live 연결이 갑자기 끊겼습니다');
  return new ProviderError('server', message);
}

/** 연결 단계(HTTP)에서 거절된 경우 */
function classifyHandshake(status: number | undefined): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', 'Gemini API 키로 Live 를 쓸 권한이 없습니다');
  if (status === 429) return new ProviderError('rate_limit', 'Live 사용 한도에 걸렸습니다');
  // 학교·회사 네트워크의 프록시·방화벽이 WebSocket 을 막으면 404/400 등으로 거절되기도 한다
  return new ProviderError('network', `Live 서버에 연결하지 못했습니다 (HTTP ${status ?? '?'}). 학교 네트워크가 WebSocket 연결을 막고 있을 수 있어요`);
}

/** Live 세션을 연다. 서버가 설정을 받아들이면(setupComplete) resolve, 아니면 ProviderError 로 reject */
export function connectLive(apiKey: string, opts: LiveOptions, handlers: LiveHandlers): Promise<LiveConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${opts.endpoint ?? LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
    const reader = new ServerMessageReader(handlers);
    let ready = false;
    let done = false; // 실패했거나 우리가 닫음
    const timer = setTimeout(() => fail(new ProviderError('network', 'Live 연결이 너무 늦습니다')), opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS);

    const fail = (error: ProviderError) => {
      if (ready || done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    };
    const send = (message: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const connection: LiveConnection = {
      sendAudio: (pcm) => send({ realtimeInput: { audio: { data: pcm16Base64(pcm), mimeType: 'audio/pcm;rate=16000' } } }),
      endAudio: () => send({ realtimeInput: { audioStreamEnd: true } }),
      close: () => {
        done = true;
        clearTimeout(timer);
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000);
      },
    };

    ws.on('open', () => send(liveSetupMessage(opts.model, opts.target)));
    ws.on('unexpected-response', (_req, res) => fail(classifyHandshake(res.statusCode)));
    ws.on('error', (error) => {
      if (ready) return; // 연결된 뒤의 오류는 close 에서 다룬다
      const e = classifyGeminiError(error);
      fail(e.kind === 'other' ? new ProviderError('network', `Live 서버에 연결하지 못했습니다 (${e.message})`) : e);
    });
    ws.on('close', (code, reason) => {
      const error = classifyLiveClose(code, reason.toString());
      if (!ready) {
        fail(error ?? new ProviderError('server', 'Live 서버가 연결을 바로 닫았습니다'));
        return;
      }
      if (done) return;
      done = true;
      handlers.onClose(error);
    });
    ws.on('message', (raw) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(raw.toString()) as ServerMsg;
      } catch {
        return;
      }
      if (msg.setupComplete && !ready) {
        if (done) return;
        ready = true;
        clearTimeout(timer);
        resolve(connection);
        return;
      }
      if (ready && !done) reader.read(msg);
    });
  });
}
