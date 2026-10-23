/**
 * 包入口。
 *
 * 主服务只需要这样做就能接入本适配器：
 *   import { adapterFactory } from '@newjob/adapter-qq';
 *   registry.register(adapterFactory);
 *
 * 之后前端会自动出现「QQ（OneBot 11）」的配置表单，
 * 因为表单是根据 manifest.configFields 动态渲染的。
 */

import { defineAdapter } from '@newjob/contracts';
import { manifest } from './manifest';
import { OneBotAdapter } from './onebot-adapter';

export { manifest, OneBotAdapter };

export const adapterFactory = defineAdapter({
  manifest,
  create: (deps) => new OneBotAdapter(deps),
});

export default adapterFactory;
