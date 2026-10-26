/**
 * Pipeline 的依赖声明。
 *
 * 单独放一个文件的原因：`PipelineContext`（pipe 之间传的东西）需要引用它，
 * 而 `PipelineService` 又要引用 pipes。把依赖类型留在 service 里会形成
 * 「service → pipes → service」的运行时循环 import —— type-only 也可能在
 * 某些打包路径下变成真循环。两边都从 `deps.ts` 取类型，依赖方向就只剩一条。
 *
 * **全部走接口**：测试里换假实现，生产里换实现也不动管道本身。
 */

import type { OutboundAction } from '@newjob/contracts';

import type { ResolvedConfig } from '../config/types';
import type { MediaAssetService } from '../media/assets/asset.service';
import type { IImageFetcher } from '../media/fetcher';
import type { TtsService } from '../media/tts';
import type { IMindStateRepository } from '../mind/state/ports';
import type { GatewayService } from '../model/gateway/gateway.service';
import type { ISessionRepository } from '../session/persistence';
import type { ISessionWindowRepository } from '../session/ports';
import type { IPipelineRepository } from './ports';

export type PipelineDeps = {
  pipeline: IPipelineRepository;
  sessions: ISessionRepository;
  windowRepo: ISessionWindowRepository;
  /** 心智状态（M3）：mood / energy / affinity */
  mind: IMindStateRepository;
  /** 入站图片 → data URL（D033）；失败只丢这一张图 */
  images: IImageFetcher;
  /** 语音合成（D033）；失败降级为文字 */
  tts: TtsService;
  /** 素材库（D034）：存表情/图片，按别名取用 */
  assets: MediaAssetService;
  config: {
    get(
      instanceId: string,
      options?: { sessionId?: string | null },
    ): Promise<Pick<ResolvedConfig, 'config' | 'sessionFlags'>>;
  };
  gateway: GatewayService;
  clock?: () => Date;
  /**
   * 延迟执行器（M3-3）。默认 `setTimeout`；测试里注入空实现，否则每条用例都要真等几秒。
   * 称之为"注入点"而不是"可选项"：延迟是这个模块的正常行为，不是错误分支。
   */
  sleep?: (ms: number) => Promise<void>;
};

/** 出站回调：生产里是当前实例 adapter 的 send，测试里是收集器 */
export type SendAction = (action: OutboundAction) => Promise<{ messageId: string }>;
