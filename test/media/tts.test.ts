import { describe, expect, it } from 'vitest';

import { encryptWithDek, randomDek } from '@/common/crypto';
import { RuntimeKeyStore } from '@/modules/auth/runtime-key-store';
import type { IMediaFileStore } from '@/modules/media/file-store';
import type { ITtsCredentialRepository, TtsCredential } from '@/modules/media/ports';
import { TtsService } from '@/modules/media/tts';

const SESSION = 'sess-1';
const USER = 'user-1';
const DEK = randomDek();

function makeKeyStore(unlocked = true): RuntimeKeyStore {
  const store = new RuntimeKeyStore();
  if (unlocked) {
    store.set(SESSION, USER, DEK);
  }
  return store;
}

class FakeCredentials implements ITtsCredentialRepository {
  credential: TtsCredential | null = {
    id: 'cred-tts',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    authStyle: 'bearer',
    apiKeyEnc: encryptWithDek('sk-test-key', DEK),
  };
  asked: Array<{ ownerUserId: string; credentialId: string }> = [];

  async findForUser(ownerUserId: string, credentialId: string): Promise<TtsCredential | null> {
    this.asked.push({ ownerUserId, credentialId });
    return this.credential;
  }
}

class FakeFileStore implements IMediaFileStore {
  files = new Map<string, Buffer>();
  async find(kind: string, key: string, ext: string): Promise<string | null> {
    return this.files.has(`${kind}/${key}.${ext}`) ? `/media/${kind}/${key}.${ext}` : null;
  }
  async write(kind: string, key: string, ext: string, data: Buffer): Promise<string> {
    this.files.set(`${kind}/${key}.${ext}`, data);
    return `/media/${kind}/${key}.${ext}`;
  }
}

function makeService(
  overrides: {
    unlocked?: boolean;
    speak?: (request: unknown, ctx: unknown) => Promise<Buffer>;
  } = {},
) {
  const credentials = new FakeCredentials();
  const store = new FakeFileStore();
  const calls: Array<{ request: unknown; ctx: unknown }> = [];
  const speak =
    overrides.speak ??
    (async (request: unknown, ctx: unknown) => {
      calls.push({ request, ctx });
      return Buffer.from('fake-mp3');
    });

  const service = new TtsService({
    credentials,
    keyStore: makeKeyStore(overrides.unlocked ?? true),
    store,
    speak: speak as never,
  });
  return { service, credentials, store, calls };
}

const INPUT = {
  ownerUserId: USER,
  credentialId: 'cred-tts',
  model: 'tts-1',
  voice: 'nova',
  text: '晚安',
};

describe('TtsService', () => {
  it('合成成功：调厂商、落盘、返回路径', async () => {
    const { service, calls, store } = makeService();
    const result = await service.synthesize(INPUT);

    expect(result).toEqual({ kind: 'ok', filePath: expect.stringContaining('/media/tts/') });
    expect(calls).toHaveLength(1);
    expect(store.files.size).toBe(1);
    const request = calls[0]?.request as { model: string; voice: string; input: string };
    expect(request.input).toBe('晚安');
    expect(request.voice).toBe('nova');
  });

  it('同一句同音色只合成一次（缓存）', async () => {
    const { service, calls } = makeService();
    await service.synthesize(INPUT);
    await service.synthesize(INPUT);
    expect(calls).toHaveLength(1);
  });

  it('未解锁：失败原因是 locked，且不去查凭据', async () => {
    const { service, credentials } = makeService({ unlocked: false });
    const result = await service.synthesize(INPUT);
    expect(result).toEqual({ kind: 'failed', reason: 'locked' });
    expect(credentials.asked).toHaveLength(0);
  });

  it('凭据不存在或不属于本人：credential_missing', async () => {
    const { service, credentials } = makeService();
    credentials.credential = null;
    const result = await service.synthesize(INPUT);
    expect(result).toEqual({ kind: 'failed', reason: 'credential_missing' });
    // 归属过滤必须在查询里带上，不是查出来再判
    expect(credentials.asked[0]).toEqual({ ownerUserId: USER, credentialId: 'cred-tts' });
  });

  it('密文解不开（DEK 换了）：decrypt', async () => {
    const { service, credentials } = makeService();
    credentials.credential = {
      ...(credentials.credential as TtsCredential),
      apiKeyEnc: encryptWithDek('sk-other', randomDek()),
    };
    const result = await service.synthesize(INPUT);
    expect(result).toEqual({ kind: 'failed', reason: 'decrypt' });
  });

  it('厂商报错：failed/synth，不把厂商原始错误往上抛', async () => {
    const { service } = makeService({
      speak: async () => {
        throw new Error('HTTP 404 model not found for key sk-xxx');
      },
    });
    const result = await service.synthesize(INPUT);
    expect(result).toEqual({ kind: 'failed', reason: 'synth' });
  });
});
