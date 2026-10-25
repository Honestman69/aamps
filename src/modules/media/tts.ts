/**
 * 语音合成服务（D033）。
 *
 * 职责链很短：**取凭据 → 解密 → 命中缓存 → 调 `/audio/speech` → 落盘 → 返回路径**。
 *
 * ## 为什么失败一律"降级成文字"，不抛错
 *
 * 语音是表现层的增强，不是主链路。合成失败（厂商不支持、音色名写错、欠费）时，
 * 正确行为是"这句话用文字说出去"，而不是整条回复失败、更不是静默。
 * 所以这里返回 `{kind:'failed'}` 而不是 throw —— 让调用方保有"还能发文字"的余地。
 *
 * 唯一例外是 `locked`：没解锁就没有 DEK，那不是"语音坏了"，是"整个实例没法调用"。
 * 调用方仍按普通失败处理（文字也发不出去，因为聊天同样需要 DEK）。
 *
 * ## 缓存
 *
 * 同一段文字 + 同一音色只合成一次。日常对话里"嗯""好呀"这类短句会高频重复，
 * 缓存既省钱也省掉一次网络往返（语音发得比文字慢，慢在这）。
 */

import { decryptWithDek } from '../../common/crypto';
import type { RuntimeKeyStore } from '../auth/runtime-key-store';
import { findProviderPreset } from '../model/providers/presets';
import {
  openAiCompatibleSpeech,
  type SpeechRequest,
} from '../model/providers/openai-speech';
import { contentKey, type IMediaFileStore } from './file-store';
import type { ITtsCredentialRepository } from './ports';

export type TtsFailureReason = 'locked' | 'credential_missing' | 'decrypt' | 'synth';

export type TtsResult =
  | { kind: 'ok'; filePath: string }
  | { kind: 'failed'; reason: TtsFailureReason };

export type TtsInput = {
  ownerUserId: string;
  credentialId: string;
  model: string;
  voice: string;
  text: string;
};

export class TtsService {
  constructor(
    private readonly deps: {
      credentials: ITtsCredentialRepository;
      keyStore: RuntimeKeyStore;
      store: IMediaFileStore;
      /** 测试注入点：默认走真实 HTTP */
      speak?: (request: SpeechRequest, ctx: Parameters<typeof openAiCompatibleSpeech>[1]) => Promise<Buffer>;
      timeoutMs?: number;
    },
  ) {}

  async synthesize(input: TtsInput): Promise<TtsResult> {
    const text = input.text.trim();
    if (!text) {
      return { kind: 'failed', reason: 'synth' };
    }

    // 按 owner 取 DEK：消息链路没有登录会话（见 RuntimeKeyStore.getForUser）
    let dek: Buffer;
    try {
      dek = this.deps.keyStore.getForUser(input.ownerUserId);
    } catch {
      return { kind: 'failed', reason: 'locked' };
    }

    const key = contentKey('tts', input.model, input.voice, text);
    const cached = await this.deps.store.find('tts', key, 'mp3');
    if (cached) {
      return { kind: 'ok', filePath: cached };
    }

    const credential = await this.deps.credentials.findForUser(input.ownerUserId, input.credentialId);
    if (!credential) {
      return { kind: 'failed', reason: 'credential_missing' };
    }

    let apiKey: string;
    try {
      apiKey = decryptWithDek(credential.apiKeyEnc, dek);
    } catch {
      return { kind: 'failed', reason: 'decrypt' };
    }

    const speak = this.deps.speak ?? openAiCompatibleSpeech;
    try {
      const audio = await speak(
        { model: input.model, voice: input.voice, input: text, format: 'mp3' },
        {
          baseUrl: credential.baseUrl ?? findProviderPreset(credential.provider)?.baseUrl ?? '',
          apiKey,
          authStyle: (credential.authStyle as 'bearer' | 'x-api-key' | 'query') ?? 'bearer',
          timeoutMs: this.deps.timeoutMs ?? 30_000,
        },
      );
      const filePath = await this.deps.store.write('tts', key, 'mp3', audio);
      return { kind: 'ok', filePath };
    } catch {
      // 厂商侧错误详情不往上带：它可能含厂商账号信息，且对用户没有可操作性
      return { kind: 'failed', reason: 'synth' };
    }
  }
}
