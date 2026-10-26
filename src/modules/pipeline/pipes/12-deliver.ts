/**
 * ⑫ 出站（D033 / D035）：把模型文本变成 1~3 条真实消息。
 *
 * 这是整条链路里唯一"有副作用且不可回滚"的一步，所以顺序是刻意的：
 *
 *   1. **先解析媒体意图**，再决定要不要合成语音 —— 合成失败时才知道要不要把话并回正文；
 *   2. **语音单独一条**（文字、图片、语音分别是独立气泡，QQ 里混在一条经常只显示一个）；
 *   3. **引用与 @ 只挂第一条**：一条回复只提醒对方一次才自然；
 *   4. 每条发完立刻落库，而不是最后批量写 —— 中途失败时，已发出的那几条必须留在历史里。
 */

import type { OutboundAction, Segment } from '@newjob/contracts';

import { parseMediaIntent, stripStrayMediaTags } from '../../media/intent';
import { planTextReply, parseExpressionPolicy } from '../../mind/expression/plan';
import { messageSeed, seededRand } from '../../mind/expression/rand';
import { isBusy } from '../../mind/state/mind-state';
import type { Pipe } from './types';

export const deliverPipe: Pipe = {
  name: 'deliver',
  requires: [
    'replyText',
    'message',
    'session',
    'owner',
    'config',
    'mind',
    'now',
    'quoteTarget',
    'think',
    'wait',
  ],
  provides: [],
  async run(ctx) {
    const { message, config, caps, send } = ctx;
    const ttsReady = caps.media.voice && Boolean(config.ttsCredentialId && config.ttsModel);

    const media = parseMediaIntent(ctx.replyText, {
      allowImage: caps.media.image,
      allowVoice: ttsReady,
      imageHosts: config.imageHosts,
    });
    const bodyText = stripStrayMediaTags(media.text);
    // 语音发不出去时（平台不支持 / 没配 TTS），这句话按文字说 —— 否则这条回复凭空消失
    const spokenFallback = media.voice ?? media.voiceAsText;

    // ── 存素材（D034）：只存这条消息里真实存在的图，不接受模型自己编的链接 ──
    if (media.saves.length > 0) {
      const urls = message.segments
        .filter((segment): segment is Extract<Segment, { type: 'image' }> => segment.type === 'image')
        .map((segment) => segment.url);
      await ctx.deps.assets
        .saveFromUrls({ instanceId: message.instanceId, alias: media.saves[0] as string, urls })
        .catch(() => null);
    }

    // ── 语音：先合成再发送 ──
    let voicePath: string | null = null;
    if (media.voice && config.ttsCredentialId && config.ttsModel) {
      const tts = await ctx.deps.tts.synthesize({
        ownerUserId: ctx.owner.ownerUserId,
        credentialId: config.ttsCredentialId,
        model: config.ttsModel,
        voice: config.ttsVoice,
        text: media.voice,
      });
      if (tts.kind === 'ok') {
        voicePath = tts.filePath;
      }
    }

    let textOut = bodyText;
    if (spokenFallback && !voicePath) {
      textOut = textOut ? `${textOut}\n${spokenFallback}` : spokenFallback;
    }

    // ── 图片（外链 + 素材库）：素材查不到就跳过，不编、不发空消息 ──
    const images: string[] = [...media.images];
    for (const alias of media.uses) {
      const resolved = await ctx.deps.assets
        .resolveForSend(message.instanceId, alias)
        .catch(() => null);
      if (resolved) {
        images.push(resolved.filePath);
      }
    }

    // ── 表达层（D035）：拆条 + 每条前的延迟 + 群里回 @ ──
    const expression = parseExpressionPolicy(ctx.persona?.behaviorJson ?? null);
    const parts = textOut
      ? planTextReply({
          text: textOut,
          channel: ctx.channel,
          isMentioned: message.isMentioned,
          senderId: message.sender.id,
          quoted: ctx.quoteTarget !== undefined,
          ctx: { busy: isBusy(ctx.mind, ctx.now), now: ctx.now },
          policy: expression,
          // 同一条消息重放得到同一套延迟/拆法，出问题能复现（非密码学随机）
          rand: seededRand(
            messageSeed(`${message.instanceId}:${ctx.channel}:${message.session.peerId}`, message.id),
          ),
        })
      : [];

    const thinkJson = ctx.think ? JSON.stringify(ctx.think) : null;
    let quoted = false;

    for (const part of parts) {
      await ctx.wait(part.delayMs);
      const segments: Segment[] = [];
      if (part.mentionUserId) {
        segments.push({ type: 'at', userId: part.mentionUserId });
      }
      segments.push({ type: 'text', text: part.text });

      const replyTo = !quoted ? ctx.quoteTarget : undefined;
      await send({
        kind: 'send',
        session: message.session,
        segments,
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
      } satisfies OutboundAction);

      await ctx.deps.sessions.saveOutbound({
        sessionId: ctx.session.id,
        content: part.text,
        senderId: ctx.owner.accountId,
        replyToMessageId: replyTo ?? null,
        // think 属于整条回复，只挂第一条：一条回复一份独白
        ...(!quoted && thinkJson ? { thinkJson } : {}),
      });
      quoted = true;
    }

    if (images.length > 0) {
      // 发图前停一下：连续文字后立刻甩图，比文字本身更像机器人
      await ctx.wait(quoted ? expression.delay.mediaDelayMs : 0);
      const replyTo = !quoted ? ctx.quoteTarget : undefined;
      await send({
        kind: 'send',
        session: message.session,
        segments: images.map((url): Segment => ({ type: 'image', url })),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
      } satisfies OutboundAction);

      await ctx.deps.sessions.saveOutbound({
        sessionId: ctx.session.id,
        content: '[图片]',
        senderId: ctx.owner.accountId,
        replyToMessageId: replyTo ?? null,
      });
      quoted = true;
    }

    if (voicePath) {
      await ctx.wait(expression.delay.mediaDelayMs);
      // 语音不带引用：引用挂在文字那条上，一条消息只引用一次才自然
      await send({
        kind: 'send',
        session: message.session,
        segments: [{ type: 'voice', url: voicePath }],
      } satisfies OutboundAction);

      await ctx.deps.sessions.saveOutbound({
        sessionId: ctx.session.id,
        content: `[语音] ${media.voice ?? ''}`.trim(),
        senderId: ctx.owner.accountId,
        replyToMessageId: null,
      });
    }
  },
};
