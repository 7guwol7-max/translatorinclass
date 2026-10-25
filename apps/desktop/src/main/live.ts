// Live 모드: 말하는 동안 소리를 Gemini Live(실시간 번역 모델)로 흘려 보내 자막을 바로 만든다.
// - 목표 언어마다 세션 하나 (교사 말 → 학생 언어들, 학생 말 → 한국어). 소리는 말하는 동안만 보낸다
// - 화면이 쉼에서 끊은 '말 한 덩이'가 자막 한 줄이 된다. 덩이가 끝나면 서버에 알려 남은 번역을 바로 받는다
// - 같은 말의 구간 녹음도 받아 두었다가, Live 가 그 말에 답하지 않으면 기존 방식(구간 → 요청)이 같은 자막 자리에 쓴다
// - 연결이 안 되거나 여러 번 연달아 답이 없으면 이번 수업은 기존 방식으로 바꾼다
// - 서버가 세션 길이·문맥 크기를 제한하므로, 오래됐거나 곧 끊는다고 알려 오면 말이 없을 때 새로 연다

import type { Caption, Channel, LiveStatus, Settings, Speaker, StatusMessage } from '../shared/types';
import { guessLanguage, joinTranscript, liveTargets } from '../shared/live';
import { speakerFor } from '../shared/prompts';
import { concatWithGap, durationSec } from '../shared/wav';
import type { LiveConnection, LiveHandlers } from './providers/gemini-live';
import { ProviderError } from './providers/errors';
import type { CaptionSlot } from './pipeline';

/** 받는 중 자막을 다시 그리는 최소 간격 */
const PARTIAL_INTERVAL_MS = 120;
/** 말이 끝난 뒤 이만큼 새 글자가 없으면 그 자막을 확정한다 */
const SETTLE_MS = 1_200;
/** 말이 끝나고 이 안에 글자가 하나도 없으면 그 말은 기존 방식으로 넘긴다 */
const NO_TEXT_MS = 4_000;
/** 한 말에 글자가 오다가 이만큼 멈춘 뒤 온 글자는 다음 말 것으로 본다 */
const QUIET_MS = 1_500;
/** 한 글자도 없이 말이 끝나고 이만큼 지났으면, 그 뒤 글자는 다음 말 것으로 본다 (자기 언어라 번역이 없는 세션 등) */
const SILENT_ADVANCE_MS = 3_000;
/** 이만큼 길게 말했는데 답이 없으면 '놓침'으로 센다 (기침·잡음은 세지 않음) */
const MISS_MIN_SEC = 1.5;
const MAX_MISSES = 3;
/** 연결 실패가 이만큼 이어지면 이번 수업은 기존 방식으로 */
const MAX_CONNECT_FAILURES = 2;
const RECONNECT_DELAY_MS = 1_000;
const ROTATE_AGE_MS = 8 * 60_000;
const ROTATE_TOKENS = 10_000;
/** 연결되는 동안 모아 둘 최대 소리 */
const MAX_PENDING_SEC = 20;
/** 수업을 끝낸 뒤 남은 자막을 기다리는 시간 */
const STOP_GRACE_MS = 5_000;
const KEEP_UTTERANCES = 30;

export interface LiveEngineDeps {
  getSettings(): Settings;
  /** 세션을 연다. 실패하면 ProviderError 로 reject */
  connect(model: string, target: string, handlers: LiveHandlers): Promise<LiveConnection>;
  onCaption(caption: Caption): void;
  onStatus(message: StatusMessage): void;
  onLiveStatus(status: LiveStatus): void;
  /** 기존 방식으로 처리 (slot 이 있으면 같은 자막 자리에 쓴다) */
  fallback(channel: Channel, pcm: Float32Array, slot?: CaptionSlot): void;
  /** 자막 순서 번호 (기존 방식과 같은 순서를 쓴다) */
  nextSeq(): number;
  /** 말이 끝난 뒤 자막이 다 나오기까지 걸린 시간 (화면의 '자막 지연') */
  noteLatency(ms: number): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Track {
  /** 지금 글자를 받는 말 */
  cur: number | null;
  lastAt: number;
  /** 서버가 끝났다고 알린 말 */
  done: Set<number>;
}

interface Session {
  target: string;
  conn: LiveConnection | null;
  state: 'connecting' | 'ready' | 'closed';
  /** 연결할 때마다 올린다 (예전 연결에서 늦게 온 메시지 무시) */
  gen: number;
  openedAt: number;
  tokens: number;
  rotate: boolean;
  failures: number;
  /** 연결되는 동안 모은 소리 (null = 말 끝) */
  pending: { utterance: number; pcm: Float32Array | null }[];
  pendingSec: number;
  input: Track;
  output: Track;
  retryTimer: unknown;
}

interface Utterance {
  id: number;
  slot: CaptionSlot;
  endedAt: number | null;
  transcript: string;
  /** 받아쓰기를 가져오는 세션 (처음 보낸 세션 하나만 쓴다) */
  transcriptFrom: string | null;
  lang: string;
  outputs: Record<string, string>;
  inAt: number;
  outAt: Record<string, number>;
  /** 받아쓰기를 보낸 세션들 */
  inBy: Set<string>;
  inDone: boolean;
  outDone: Set<string>;
  segments: Float32Array[];
  state: 'open' | 'final' | 'fallback';
  shownAt: number;
  showTimer: unknown;
  checkTimer: unknown;
}

interface ChannelState {
  channel: Channel;
  sessions: Map<string, Session>;
  utterances: Utterance[];
  /** 포기한 이유 (null 이면 Live 로 처리 중) */
  failed: string | null;
  misses: number;
}

interface View {
  speaker: Speaker;
  lang: string;
  translations: Record<string, string>;
  /** 번역이 있어야 하는 언어 */
  needed: string[];
}

function newTrack(): Track {
  return { cur: null, lastAt: 0, done: new Set() };
}

export class LiveEngine {
  private channels = new Map<Channel, ChannelState>();
  private running = false;
  private stopTimer: unknown = null;
  private lastStatus = '';
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: LiveEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** 이 채널의 소리를 Live 로 처리하는지 (아니면 구간은 기존 방식으로 바로 간다) */
  handles(channel: Channel): boolean {
    return this.running && this.deps.getSettings().liveMode && !this.channels.get(channel)?.failed;
  }

  /** 수업 시작: 쓸 채널의 세션을 미리 연다 (다른 채널은 소리가 오면 연다) */
  start(channels: Channel[]): void {
    if (this.stopTimer !== null) this.clearTimer(this.stopTimer);
    this.stopTimer = null;
    this.running = true;
    for (const ch of this.channels.values()) {
      ch.failed = null; // 새 수업에서는 다시 해 본다
      ch.misses = 0;
    }
    if (this.deps.getSettings().liveMode) for (const c of channels) this.sync(this.channel(c));
    this.publish();
  }

  /** 수업 끝: 남은 자막을 조금 기다렸다가 세션을 닫는다 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const ch of this.channels.values()) {
      for (const u of ch.utterances) if (u.state === 'open' && u.endedAt === null) this.end(ch.channel, u.id);
    }
    if (this.stopTimer !== null) this.clearTimer(this.stopTimer);
    this.stopTimer = this.setTimer(() => {
      this.stopTimer = null;
      this.closeAll();
    }, STOP_GRACE_MS);
    this.publish();
  }

  /** 말하는 동안의 소리 (약 0.1초씩) */
  audio(channel: Channel, id: number, pcm: Float32Array): void {
    if (!this.handles(channel) || pcm.length === 0) return;
    const ch = this.channel(channel);
    this.sync(ch);
    const u = this.find(ch, id) ?? this.begin(ch, id);
    if (u.endedAt !== null) return;
    for (const s of ch.sessions.values()) this.send(ch, s, id, pcm);
  }

  /** 쉼에서 말 한 덩이가 끝남 */
  end(channel: Channel, id: number): void {
    const ch = this.channels.get(channel);
    const u = ch ? this.find(ch, id) : undefined;
    if (!ch || !u || u.endedAt !== null) return;
    u.endedAt = this.now();
    for (const s of ch.sessions.values()) this.send(ch, s, id, null);
    this.check(ch, u);
  }

  /** 같은 말을 구간으로도 받는다: Live 가 그 말을 못 받으면 이걸로 기존 방식 처리 */
  segment(channel: Channel, id: number, pcm: Float32Array): void {
    const ch = this.channels.get(channel);
    const u = ch ? this.find(ch, id) : undefined;
    if (!u) {
      this.deps.fallback(channel, pcm);
      return;
    }
    if (u.state === 'open') u.segments.push(pcm);
    else if (u.state === 'fallback') this.deps.fallback(channel, pcm);
    // final: Live 가 이미 자막을 만들었다
  }

  status(): LiveStatus {
    const s = this.deps.getSettings();
    const base = { model: s.liveModel, ready: 0, wanted: 0, message: '' };
    if (!s.liveMode) return { ...base, state: 'off' };
    const chans = [...this.channels.values()];
    const failed = chans.find((c) => c.failed);
    if (failed) return { ...base, state: 'fallback', message: failed.failed ?? '' };
    if (!this.running) return { ...base, state: 'idle' };
    const sessions = chans.flatMap((c) => [...c.sessions.values()]);
    const ready = sessions.filter((x) => x.state === 'ready').length;
    const connecting = sessions.some((x) => x.state === 'connecting' || x.retryTimer !== null);
    return { ...base, state: connecting || sessions.length === 0 ? 'connecting' : 'on', ready, wanted: sessions.length };
  }

  // ── 세션 ─────────────────────────────────────────────────────

  private channel(channel: Channel): ChannelState {
    let ch = this.channels.get(channel);
    if (!ch) {
      ch = { channel, sessions: new Map(), utterances: [], failed: null, misses: 0 };
      this.channels.set(channel, ch);
    }
    return ch;
  }

  /** 학생 언어 설정에 맞춰 세션을 열고 닫는다 */
  private sync(ch: ChannelState): void {
    if (ch.failed) return;
    const targets = liveTargets(ch.channel, this.deps.getSettings().studentLanguages);
    for (const [target, s] of ch.sessions) {
      if (!targets.includes(target)) {
        this.drop(s);
        ch.sessions.delete(target);
      }
    }
    for (const target of targets) {
      if (ch.sessions.has(target)) continue;
      const s: Session = {
        target, conn: null, state: 'closed', gen: 0, openedAt: 0, tokens: 0, rotate: false, failures: 0,
        pending: [], pendingSec: 0, input: newTrack(), output: newTrack(), retryTimer: null,
      };
      ch.sessions.set(target, s);
      this.connect(ch, s);
    }
  }

  private connect(ch: ChannelState, s: Session): void {
    const gen = ++s.gen;
    s.state = 'connecting';
    s.conn = null;
    s.retryTimer = null;
    s.input = newTrack();
    s.output = newTrack();
    const alive = () => gen === s.gen && !ch.failed;
    const handlers: LiveHandlers = {
      onInput: (text, lang, finished) => {
        if (alive()) this.onInput(ch, s, text, lang, finished);
      },
      onOutput: (text, finished) => {
        if (alive()) this.onOutput(ch, s, text, finished);
      },
      onTurnEnd: () => {
        if (alive()) this.onTurnEnd(ch, s);
      },
      onUsage: (tokens) => {
        if (!alive()) return;
        s.tokens = tokens;
        if (tokens > ROTATE_TOKENS) s.rotate = true;
      },
      onGoAway: () => {
        if (!alive()) return;
        s.rotate = true;
        this.maybeRotate(ch);
      },
      onClose: (error) => {
        if (!alive()) return;
        s.state = 'closed';
        s.conn = null;
        if (error) this.connectFailed(ch, s, error);
        else if (s.pending.length > 0 || this.speaking(ch)) this.connect(ch, s); // 말하는 중이면 바로 다시 연다
        this.publish();
      },
    };
    this.publish();
    this.deps.connect(this.deps.getSettings().liveModel, s.target, handlers).then(
      (conn) => {
        if (!alive()) {
          conn.close();
          return;
        }
        s.conn = conn;
        s.state = 'ready';
        s.openedAt = this.now();
        s.tokens = 0;
        s.rotate = false;
        s.failures = 0;
        const pending = s.pending;
        s.pending = [];
        s.pendingSec = 0;
        for (const p of pending) this.send(ch, s, p.utterance, p.pcm);
        this.publish();
      },
      (error: unknown) => {
        if (!alive()) return;
        s.state = 'closed';
        this.connectFailed(ch, s, error instanceof ProviderError ? error : new ProviderError('other', String(error)));
        this.publish();
      },
    );
  }

  private send(ch: ChannelState, s: Session, utterance: number, pcm: Float32Array | null): void {
    if (s.state === 'ready' && s.conn) {
      // 이 세션이 처음 듣는 말부터 글자를 붙인다
      if (s.input.cur === null) s.input.cur = utterance;
      if (s.output.cur === null) s.output.cur = utterance;
      if (pcm) s.conn.sendAudio(pcm);
      else s.conn.endAudio();
      return;
    }
    if (pcm) {
      s.pendingSec += durationSec(pcm);
      // 너무 오래 연결이 안 되면 오래된 소리부터 버린다 (그 말은 기존 방식이 맡는다)
      while (s.pendingSec > MAX_PENDING_SEC && s.pending.length > 0) {
        const old = s.pending.shift()!;
        if (old.pcm) s.pendingSec -= durationSec(old.pcm);
      }
    }
    s.pending.push({ utterance, pcm });
    if (s.state === 'closed' && s.retryTimer === null) this.connect(ch, s);
  }

  private connectFailed(ch: ChannelState, s: Session, error: ProviderError): void {
    const retry = error.kind === 'network' || error.kind === 'server';
    if (retry && s.failures + 1 < MAX_CONNECT_FAILURES) {
      s.failures++;
      s.retryTimer = this.setTimer(() => {
        s.retryTimer = null;
        if (!ch.failed && (this.running || s.pending.length > 0)) this.connect(ch, s);
      }, RECONNECT_DELAY_MS);
      return;
    }
    this.giveUp(ch, error.message);
  }

  /** 세션을 닫고 늦게 오는 메시지는 무시한다 */
  private drop(s: Session): void {
    s.gen++;
    if (s.retryTimer !== null) this.clearTimer(s.retryTimer);
    s.retryTimer = null;
    s.conn?.close();
    s.conn = null;
    s.state = 'closed';
    s.pending = [];
    s.pendingSec = 0;
  }

  private giveUp(ch: ChannelState, reason: string): void {
    if (ch.failed) return;
    ch.failed = reason;
    for (const s of ch.sessions.values()) this.drop(s);
    ch.sessions.clear();
    this.deps.onStatus({ level: 'warn', text: `Live 모드가 안 돼서 이번 수업은 지금까지 쓰던 방식으로 자막을 만듭니다 — ${reason}`, ts: this.now() });
    // 끝난 말은 지금 마무리하고, 말하는 중인 말은 끝날 때 기존 방식으로 넘긴다
    for (const u of ch.utterances) if (u.state === 'open' && u.endedAt !== null) this.check(ch, u);
    this.publish();
  }

  /** 말이 없을 때, 오래됐거나 서버가 끊는다고 한 세션을 새로 연다 */
  private maybeRotate(ch: ChannelState): void {
    if (ch.failed || ch.utterances.some((u) => u.state === 'open')) return;
    const now = this.now();
    for (const s of ch.sessions.values()) {
      if (s.state !== 'ready' || !(s.rotate || now - s.openedAt > ROTATE_AGE_MS)) continue;
      s.conn?.close();
      this.connect(ch, s);
    }
  }

  private closeAll(): void {
    for (const ch of this.channels.values()) {
      for (const u of ch.utterances) {
        if (u.state !== 'open') continue;
        if (u.endedAt === null) u.endedAt = this.now();
        this.settle(ch, u);
      }
      for (const s of ch.sessions.values()) this.drop(s);
    }
    this.channels.clear();
    this.publish();
  }

  private speaking(ch: ChannelState): boolean {
    return ch.utterances.some((u) => u.endedAt === null);
  }

  // ── 말 한 덩이 ───────────────────────────────────────────────

  private find(ch: ChannelState, id: number): Utterance | undefined {
    return ch.utterances.find((u) => u.id === id);
  }

  private begin(ch: ChannelState, id: number): Utterance {
    const now = this.now();
    const u: Utterance = {
      id,
      slot: { id: `live-${now.toString(36)}-${id.toString(36)}`, seq: this.deps.nextSeq(), ts: now },
      endedAt: null,
      transcript: '',
      transcriptFrom: null,
      lang: '',
      outputs: {},
      inAt: 0,
      outAt: {},
      inBy: new Set(),
      inDone: false,
      outDone: new Set(),
      segments: [],
      state: 'open',
      shownAt: 0,
      showTimer: null,
      checkTimer: null,
    };
    ch.utterances.push(u);
    while (ch.utterances.length > KEEP_UTTERANCES && ch.utterances[0].state !== 'open') ch.utterances.shift();
    return u;
  }

  /** 말한 사람·언어와 보여줄 번역 (아직 누가 말했는지 모르면 null) */
  private view(ch: ChannelState, u: Utterance): View | null {
    const langs = this.deps.getSettings().studentLanguages;
    let lang = u.lang;
    if (!lang) lang = ch.channel === 'teacher' ? 'ko' : guessLanguage(u.transcript, ['ko', ...langs]);
    if (!lang && ch.channel === 'auto') return null;
    const speaker = speakerFor(ch.channel, lang);
    const needed = speaker === 'teacher'
      ? liveTargets(ch.channel, langs).filter((t) => t !== 'ko')
      : lang === 'ko' ? [] : ['ko'];
    const translations: Record<string, string> = {};
    for (const t of needed) {
      const text = u.outputs[t]?.trim();
      if (text) translations[t] = text;
    }
    return { speaker, lang, translations, needed };
  }

  /** 이 세션의 번역이 이 말에 쓰이는지 (모르면 null) */
  private relevant(ch: ChannelState, u: Utterance, target: string): boolean | null {
    const v = this.view(ch, u);
    return v ? v.needed.includes(target) : null;
  }

  /**
   * 이 글자 조각이 어느 말 것인지 정한다. 세션은 말한 순서대로 답하므로 지금 말에 붙이다가,
   * 그 말이 끝났고 서버가 끝을 알렸거나 한동안 조용했으면(또는 이 세션 번역이 필요 없는 말이면) 다음 말로 넘어간다.
   */
  private route(ch: ChannelState, s: Session, kind: 'in' | 'out'): Utterance | null {
    const track = kind === 'in' ? s.input : s.output;
    if (track.cur === null) return null;
    const list = ch.utterances;
    let i = list.findIndex((u) => u.id === track.cur);
    if (i < 0) return null;
    const now = this.now();
    while (i + 1 < list.length) {
      const u = list[i];
      if (u.endedAt === null) break;
      const got = kind === 'in' ? u.inBy.has(s.target) : u.outAt[s.target] !== undefined;
      const quiet = got ? now - Math.max(u.endedAt, track.lastAt) >= QUIET_MS : now - u.endedAt >= SILENT_ADVANCE_MS;
      const skip = kind === 'out' && this.relevant(ch, u, s.target) === false && !got;
      if (!track.done.has(u.id) && !quiet && !skip) break;
      i++;
    }
    track.cur = list[i].id;
    track.lastAt = now;
    return list[i];
  }

  private onInput(ch: ChannelState, s: Session, text: string, lang: string, finished: boolean): void {
    const u = this.route(ch, s, 'in');
    if (!u) return;
    if (text) {
      u.inBy.add(s.target);
      u.transcriptFrom ??= s.target;
      if (u.transcriptFrom === s.target) {
        u.transcript = joinTranscript(u.transcript, text);
        if (lang) u.lang = lang;
        u.inAt = this.now();
        this.touched(ch, u);
      }
    }
    if (finished && u.endedAt !== null) {
      s.input.done.add(u.id);
      if (u.transcriptFrom === s.target) u.inDone = true;
      this.check(ch, u);
    }
  }

  private onOutput(ch: ChannelState, s: Session, text: string, finished: boolean): void {
    const u = this.route(ch, s, 'out');
    if (!u) return;
    if (text) {
      u.outputs[s.target] = joinTranscript(u.outputs[s.target] ?? '', text);
      u.outAt[s.target] = this.now();
      this.touched(ch, u);
    }
    if (finished && u.endedAt !== null) this.outputDone(ch, s, u);
  }

  /** 서버가 한 차례를 마침: 끝난 말이면 이 세션은 그 말을 다 보냈다 */
  private onTurnEnd(ch: ChannelState, s: Session): void {
    const out = s.output.cur === null ? undefined : this.find(ch, s.output.cur);
    if (out && out.endedAt !== null) this.outputDone(ch, s, out);
    const inp = s.input.cur === null ? undefined : this.find(ch, s.input.cur);
    if (inp && inp.endedAt !== null) {
      s.input.done.add(inp.id);
      if (inp.transcriptFrom === s.target) inp.inDone = true;
      this.check(ch, inp);
    }
  }

  private outputDone(ch: ChannelState, s: Session, u: Utterance): void {
    s.output.done.add(u.id);
    u.outDone.add(s.target);
    this.check(ch, u);
  }

  /** 글자가 새로 옴: 받는 중 자막을 그리거나, 이미 확정한 자막이면 고쳐 쓴다 */
  private touched(ch: ChannelState, u: Utterance): void {
    if (u.state === 'final') {
      this.emit(ch, u, true);
      return;
    }
    if (u.state !== 'open') return;
    if (u.showTimer === null) {
      const wait = Math.max(0, u.shownAt + PARTIAL_INTERVAL_MS - this.now());
      u.showTimer = this.setTimer(() => {
        u.showTimer = null;
        if (u.state === 'open' && this.emit(ch, u, false)) u.shownAt = this.now();
      }, wait);
    }
    if (u.endedAt !== null) this.scheduleCheck(ch, u, SETTLE_MS);
  }

  private emit(ch: ChannelState, u: Utterance, final: boolean): boolean {
    const v = this.view(ch, u);
    const transcript = u.transcript.trim();
    if (!v || (!transcript && Object.keys(v.translations).length === 0)) return false;
    this.deps.onCaption({
      id: u.slot.id,
      seq: u.slot.seq,
      ts: u.slot.ts,
      speaker: v.speaker,
      lang: v.lang,
      transcript,
      translations: v.translations,
      latencyMs: final ? this.latency(u, v) : 0,
      final,
    });
    return true;
  }

  /** 말이 끝난 뒤 이 자막의 마지막 글자가 오기까지 (말하는 중에 다 왔으면 0) */
  private latency(u: Utterance, v: View): number {
    const last = Math.max(u.inAt, ...v.needed.map((t) => u.outAt[t] ?? 0));
    return Math.max(0, last - (u.endedAt ?? last));
  }

  private scheduleCheck(ch: ChannelState, u: Utterance, ms: number): void {
    if (u.checkTimer !== null) this.clearTimer(u.checkTimer);
    u.checkTimer = this.setTimer(() => {
      u.checkTimer = null;
      this.check(ch, u);
    }, Math.max(0, ms));
  }

  /** 끝난 말: 다 받았거나 한동안 조용하면 확정하고, 아무 답이 없으면 기존 방식으로 넘긴다 */
  private check(ch: ChannelState, u: Utterance): void {
    if (u.state !== 'open' || u.endedAt === null) return;
    const now = this.now();
    const v = this.view(ch, u);
    const hasText = v !== null && (u.transcript.trim() !== '' || Object.keys(v.translations).length > 0);
    if (!hasText) {
      if (ch.failed || now - u.endedAt >= NO_TEXT_MS) this.settle(ch, u);
      else this.scheduleCheck(ch, u, u.endedAt + NO_TEXT_MS - now);
      return;
    }
    const last = Math.max(u.inAt, ...v.needed.map((t) => u.outAt[t] ?? 0));
    const quietFor = now - Math.max(last, u.endedAt);
    const allDone = u.inDone && v.needed.every((t) => u.outDone.has(t));
    if (ch.failed || allDone || quietFor >= SETTLE_MS) this.settle(ch, u);
    else this.scheduleCheck(ch, u, SETTLE_MS - quietFor);
  }

  /** 자막을 확정한다. 받은 것이 없거나 번역이 하나도 없으면 기존 방식으로 넘긴다 */
  private settle(ch: ChannelState, u: Utterance): void {
    if (u.checkTimer !== null) this.clearTimer(u.checkTimer);
    if (u.showTimer !== null) this.clearTimer(u.showTimer);
    u.checkTimer = null;
    u.showTimer = null;
    const v = this.view(ch, u);
    const translated = v !== null && (v.needed.length === 0 || Object.keys(v.translations).length > 0);
    if (v && translated && (u.transcript.trim() || Object.keys(v.translations).length > 0)) {
      u.state = 'final';
      u.segments = [];
      this.emit(ch, u, true);
      this.deps.noteLatency(this.latency(u, v));
      ch.misses = 0;
      this.maybeRotate(ch);
      return;
    }
    u.state = 'fallback';
    const sec = u.segments.reduce((n, p) => n + durationSec(p), 0);
    if (u.segments.length > 0) {
      this.deps.fallback(ch.channel, concatWithGap(u.segments, 0), { ...u.slot, endedAt: u.endedAt ?? this.now() });
    }
    u.segments = [];
    if (!ch.failed && this.running && sec >= MISS_MIN_SEC && ++ch.misses >= MAX_MISSES) {
      this.giveUp(ch, 'Live 가 여러 번 연달아 답하지 않았습니다');
    }
    this.maybeRotate(ch);
  }

  private publish(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.deps.onLiveStatus(status);
  }
}
