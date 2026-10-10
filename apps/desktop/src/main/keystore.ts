// 교사 본인 API 키 보관: Electron safeStorage(Windows 는 DPAPI)로 암호화해서 userData 에 저장.
// 키는 main 프로세스 밖으로 나가지 않는다. 화면에는 가린 형태만 보여준다.
import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeyProvider, KeyStatus } from '../shared/types';

export function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function looksLikeKey(provider: KeyProvider, key: string): string | null {
  const k = key.trim();
  if (k.length < 20 || /\s/.test(k)) return '키 형식이 올바르지 않습니다. 복사한 키 전체를 붙여넣어 주세요.';
  if (provider === 'claude' && !k.startsWith('sk-ant-')) return 'Claude API 키는 sk-ant- 로 시작합니다.';
  return null;
}

export class KeyStore {
  private cache = new Map<KeyProvider, string | null>();

  constructor(private readonly dir: string) {}

  private file(provider: KeyProvider): string {
    return path.join(this.dir, `${provider}-key.bin`);
  }

  async get(provider: KeyProvider): Promise<string | null> {
    if (this.cache.has(provider)) return this.cache.get(provider) ?? null;
    let value: string | null = null;
    try {
      value = safeStorage.decryptString(await fs.readFile(this.file(provider)));
    } catch {
      value = null;
    }
    this.cache.set(provider, value);
    return value;
  }

  /** 이미 불러온 키 (동기). 시작할 때 status() 로 한 번 불러둔다 */
  peek(provider: KeyProvider): string | null {
    return this.cache.get(provider) ?? null;
  }

  async set(provider: KeyProvider, key: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC 에서는 OS 암호화 저장소를 쓸 수 없어 키를 저장할 수 없습니다.');
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(provider), safeStorage.encryptString(key.trim()), { mode: 0o600 });
    this.cache.set(provider, key.trim());
  }

  async clear(provider: KeyProvider): Promise<void> {
    await fs.rm(this.file(provider), { force: true });
    this.cache.set(provider, null);
  }

  async status(): Promise<KeyStatus> {
    const [gemini, claude] = await Promise.all([this.get('gemini'), this.get('claude')]);
    return { gemini: gemini ? maskKey(gemini) : null, claude: claude ? maskKey(claude) : null };
  }
}
