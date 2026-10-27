/**
 * ⑧ 拼 prompt 与消息数组（D020）。
 *
 * 两件事在这里定死，后面不再改：
 *   1. **system 的顺序**由 `assemblePrompt` 内部保证（种子 → 情境 → 语气，语气永远最后）；
 *   2. **图片只挂在"当前这条"上**：历史图片不重发，否则每一轮都在为同一张图付费。
 *
 * 群聊里给 user 消息加发言人名：不加的话模型分不清谁说的，
 * 表现是"它把 A 的话当成 B 说的"，而且很难从回复里看出来。
 */

import { assemblePrompt } from '../../persona/prompt';
import { flattenWindow } from '../../session/window';
import type { ChatMessage } from '../../model/providers/openai-compatible';
import type { Pipe } from './types';

/** 没有人设时的兜底 system：短，但不空 —— 空 system 会让模型自由发挥成客服 */
const NO_PERSONA_SYSTEM = '你是一个有自己性格的人。';

export const assemblePromptPipe: Pipe = {
  name: 'assemble-prompt',
  requires: [
    'persona',
    'owner',
    'session',
    'mind',
    'window',
    'inbound',
    'imageParts',
    'assetAliases',
    'memories',
    'config',
  ],
  provides: ['system', 'messages'],
  async run(ctx) {
    // 语音"真的能发"才在 prompt 里提它（三样齐全：平台能力 + Key + 模型）
    const voiceReady =
      ctx.caps.media.voice && Boolean(ctx.config.ttsCredentialId && ctx.config.ttsModel);

    const assembled = ctx.persona
      ? assemblePrompt(ctx.persona, {
          peerName: ctx.message.sender.name || ctx.session.peerName,
          channel: ctx.channel,
          selfName: ctx.owner.name,
          state: { mood: ctx.mind.mood, energy: ctx.mind.energy },
          capabilities: {
            imageReply: ctx.caps.media.image,
            voiceReply: voiceReady,
            assets: ctx.assetAliases,
          },
          // 记忆只影响"印象"那一段，不进 few-shot、不进历史（D045）
          memory: ctx.memories,
        })
      : { system: NO_PERSONA_SYSTEM, examples: [] as ChatMessage[] };

    ctx.system = assembled.system;
    ctx.messages = [
      { role: 'system', content: assembled.system },
      ...assembled.examples,
      ...flattenWindow(ctx.window).map((m): ChatMessage => {
        const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
        const prefix =
          ctx.channel === 'group' && role === 'user' && m.senderName ? `${m.senderName}：` : '';
        const text = `${prefix}${m.content}`;

        if (m.id === ctx.inbound.id && ctx.imageParts.length > 0) {
          return { role, content: [{ type: 'text', text }, ...ctx.imageParts] };
        }
        return { role, content: text };
      }),
    ];
  },
};
