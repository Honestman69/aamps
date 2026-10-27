/**
 * ⑦ 素材准备：入站图片 → 多模态段、素材库清单。
 *
 * 位置在 attention 之后：**决定不回就不下载图片**。
 * 没配视觉模型时也完全不下载 —— 图片只是 prompt 里的「[图片]」占位，
 * 下载了没人看，还白花一次外网请求（D033）。
 */

import type { Segment } from '@newjob/contracts';

import type { ContentPart } from '../../model/providers/openai-compatible';
import type { Pipe } from './types';

/** 一条消息最多看几张：再多也读不完，只是让 token 涨 */
const MAX_IMAGES_PER_MESSAGE = 3;
/** 塞进 prompt 的素材清单条数 */
const ASSET_PROMPT_LIMIT = 12;

export const collectMediaPipe: Pipe = {
  name: 'collect-media',
  requires: ['config'],
  provides: ['imageParts', 'assetAliases'],
  async run(ctx) {
    const instanceId = ctx.message.instanceId;

    // ① 看图
    ctx.imageParts = [];
    if (ctx.config.visionModel) {
      const urls = ctx.message.segments
        .filter((segment): segment is Extract<Segment, { type: 'image' }> => segment.type === 'image')
        .map((segment) => segment.url)
        .filter((url) => url.length > 0)
        .slice(0, MAX_IMAGES_PER_MESSAGE);

      const parts: ContentPart[] = [];
      for (const url of urls) {
        const image = await ctx.deps.images.fetchAsDataUrl(url);
        if (image) {
          parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
        }
      }
      ctx.imageParts = parts;
    }

    // ② 素材清单：模型只能用库里真实存在的名字，所以清单必须跟 prompt 一起给它。
    //    读失败就当没有 —— 少一个表情可以忍，因为读库失败就不回消息不行。
    ctx.assetAliases = ctx.caps.media.image
      ? (await ctx.deps.assets.listForPrompt(instanceId, ASSET_PROMPT_LIMIT).catch(() => [])).map(
          (item) => item.alias,
        )
      : [];
  },
};
