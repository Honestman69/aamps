/**
 * ⑩ B 阶段：外显生成。
 *
 * 有图时**指定视觉模型**：主模型（如 deepseek-chat）多半看不见图，
 * 把图片塞进去会让整条请求 400，表现是"连字都回不了"（D033）。
 *
 * 这里只用 `directedSystem` + `messages.slice(1)`：system 已经被 think 处理过，
 * 不能再把原始 system 带上（否则导演指令会被前一条 system 冲淡）。
 */

import type { Pipe } from './types';

export const generatePipe: Pipe = {
  name: 'generate',
  requires: ['directedSystem', 'messages', 'owner', 'session', 'config', 'imageParts'],
  provides: ['replyText'],
  async run(ctx) {
    const result = await ctx.deps.gateway.chat({
      instanceId: ctx.message.instanceId,
      ownerUserId: ctx.owner.ownerUserId,
      sessionId: ctx.session.id,
      purpose: 'chat',
      messages: [{ role: 'system', content: ctx.directedSystem }, ...ctx.messages.slice(1)],
      ...(ctx.imageParts.length > 0 && ctx.config.visionModel
        ? { model: ctx.config.visionModel }
        : {}),
    });

    ctx.replyText = result.text;
  },
};
