/**
 * 出站媒体意图解析（D033）。
 *
 * ## 为什么让模型"说"要发什么，而不是让它输出 JSON
 *
 * 需求是"用什么方式回复由接入的 agent 决定"，所以媒体选择必须能由模型表达。
 * 但它不能是结构化动作字段（D030/硬性规则 11）：`{quote, split, delay}` 那类字段模型拿不到
 * 上下文，输出质量很差，还会把语气带成客服。**媒体是内容**（"我想发这张图"），
 * 和"拆几条、延迟多久"（形态）不是一回事，所以这里只接管媒体，其余仍归代码。
 *
 * 语法刻意做得很窄 —— 必须独占一行，标签内不嵌套任何东西：
 *
 * ```
 * [img]https://example.com/x.jpg[/img]
 * [voice]今天有点累，先睡啦[/voice]
 * ```
 *
 * 三条规则：
 *   1. **独占一行才算**。正文里顺嘴提到 `[img]` 不会被误判成指令。
 *   2. **不认识就丢掉，不原样发给用户**。校验不过的链接（内网、非 https、不在白名单）
 *      留在正文里就是一条用户看得见的垃圾。
 *   3. **纯函数**。URL 校验、白名单、数量上限都在这里判完，Pipeline 只负责执行。
 */

import { checkRemoteUrl, parseHostAllowlist } from './image-url';

export const MAX_IMAGES_PER_REPLY = 2;
export const MAX_VOICE_CHARS = 300;

export type MediaOptions = {
  /** 平台是否支持发图 */
  allowImage: boolean;
  /** 平台是否支持发语音（还要 TTS 可用，那由调用方合并判断） */
  allowVoice: boolean;
  /** `BotInstance.imageHosts` 原样传入，空串 = 不限域名 */
  imageHosts?: string;
};

export type DroppedMedia = {
  kind: 'image' | 'voice' | 'use' | 'save';
  reason: 'disabled' | 'too_many' | 'bad_url' | 'bad_scheme' | 'ip_literal' | 'private_host' | 'has_credentials' | 'not_allowlisted' | 'empty';
};

export type MediaIntent = {
  /** 剥离媒体指令后的正文（可能为空串） */
  text: string;
  /** 外链图片（`[img]https://…[/img]`） */
  images: string[];
  /** 素材库别名（`[use]名字[/use]`）。是否真的存在由调用方查库决定 */
  uses: string[];
  /** 要存下来的素材别名（`[save]名字[/save]`），最多一条 */
  saves: string[];
  voice: string | null;
  /**
   * 语法合法、但当前发不出去（平台不支持语音 / 没配 TTS）的语音内容。
   *
   * 为什么单独留一份而不是直接丢弃：模型说了"晚安"却什么都没发出去，
   * 比发一条文字差得多。有了这个字段，调用方可以把它当普通文字说出去。
   */
  voiceAsText: string | null;
  dropped: DroppedMedia[];
};

const IMAGE_LINE = /^\s*\[img\]\s*([\s\S]*?)\s*\[\/img\]\s*$/;
const VOICE_LINE = /^\s*\[voice\]\s*([\s\S]*?)\s*\[\/voice\]\s*$/;
const USE_LINE = /^\s*\[use\]\s*([\s\S]*?)\s*\[\/use\]\s*$/;
const SAVE_LINE = /^\s*\[save\]\s*([\s\S]*?)\s*\[\/save\]\s*$/;

export function parseMediaIntent(raw: string, options: MediaOptions): MediaIntent {
  const hosts = parseHostAllowlist(options.imageHosts ?? '');
  const images: string[] = [];
  const uses: string[] = [];
  const saves: string[] = [];
  const dropped: DroppedMedia[] = [];
  /** 图片总数（外链 + 素材）共用同一个上限：一条回复里图太多会变成刷屏 */
  const imageCount = (): number => images.length + uses.length;
  const kept: string[] = [];
  let voice: string | null = null;
  let voiceAsText: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const imageMatch = IMAGE_LINE.exec(line);
    if (imageMatch) {
      const candidate = (imageMatch[1] ?? '').trim();
      if (!options.allowImage) {
        dropped.push({ kind: 'image', reason: 'disabled' });
        continue;
      }
      if (imageCount() >= MAX_IMAGES_PER_REPLY) {
        dropped.push({ kind: 'image', reason: 'too_many' });
        continue;
      }
      const check = checkRemoteUrl(candidate, { allowHttp: false, allowHosts: hosts });
      if (!check.ok) {
        dropped.push({ kind: 'image', reason: check.reason });
        continue;
      }
      images.push(check.url.toString());
      continue;
    }

    const useMatch = USE_LINE.exec(line);
    if (useMatch) {
      const alias = (useMatch[1] ?? '').trim();
      if (!options.allowImage) {
        dropped.push({ kind: 'use', reason: 'disabled' });
        continue;
      }
      if (!alias) {
        dropped.push({ kind: 'use', reason: 'empty' });
        continue;
      }
      if (imageCount() >= MAX_IMAGES_PER_REPLY) {
        dropped.push({ kind: 'use', reason: 'too_many' });
        continue;
      }
      uses.push(alias);
      continue;
    }

    const saveMatch = SAVE_LINE.exec(line);
    if (saveMatch) {
      const alias = (saveMatch[1] ?? '').trim();
      if (!options.allowImage) {
        dropped.push({ kind: 'save', reason: 'disabled' });
        continue;
      }
      if (!alias) {
        dropped.push({ kind: 'save', reason: 'empty' });
        continue;
      }
      if (saves.length >= 1) {
        dropped.push({ kind: 'save', reason: 'too_many' });
        continue;
      }
      saves.push(alias);
      continue;
    }

    const voiceMatch = VOICE_LINE.exec(line);
    if (voiceMatch) {
      const text = (voiceMatch[1] ?? '').trim();
      if (!options.allowVoice) {
        dropped.push({ kind: 'voice', reason: 'disabled' });
        voiceAsText = voiceAsText ?? (text || null);
        continue;
      }
      if (voice !== null) {
        // 一条消息只发一条语音：多条在 QQ 里是连发，风控上也不划算
        dropped.push({ kind: 'voice', reason: 'too_many' });
        continue;
      }
      if (!text) {
        dropped.push({ kind: 'voice', reason: 'empty' });
        continue;
      }
      // 超长直接截断而不是丢弃：说一半也比"想发语音结果什么都没发"好
      voice = text.length > MAX_VOICE_CHARS ? text.slice(0, MAX_VOICE_CHARS) : text;
      continue;
    }

    kept.push(line);
  }

  return { text: kept.join('\n').trim(), images, uses, saves, voice, voiceAsText, dropped };
}

/**
 * 把模型输出里"疑似媒体标签但没被识别"的行剔除。
 *
 * 不这么做的话，模型写错一个字符（`[img]x[/image]`）就会把标签原样发给用户。
 * 只在**整行看起来像标签**时下手，正文里的方括号不受影响。
 */
export function stripStrayMediaTags(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\/?(img|voice|use|save)\b/i.test(line))
    .join('\n')
    .trim();
}
