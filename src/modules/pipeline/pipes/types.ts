/**
 * Pipe 的上下文与接口。
 *
 * ## 为什么是"一个可变上下文对象"，而不是 `bag: Map<string, unknown>`
 *
 * `packages/contracts/src/pipe.ts` 里那个 `MsgContext.bag` 是弱类型的：
 * 取出来要 `as`，写错了编译期不报。这里改成**显式字段**，代价是一处 `as`，
 * 换来的是每个 pipe 里 `ctx.persona` 都有类型。
 *
 * ## 依赖顺序不靠"编号注释"，靠 `requires` / `provides`
 *
 * 13 个步骤里任何一步被挪错位置，症状都是 `undefined` 在很深的地方炸开。
 * 所以每个 pipe 声明自己读写哪些字段，启动时 `assertPipeGraph` 校验一遍：
 * 用到的字段必须被前序 pipe 提供，同一字段不许两个 pipe 都写。
 * 这是**启动即失败**，不是运行时才炸。
 */

import type { Drop, InboundMessage, PlatformCapabilities } from '@newjob/contracts';

import type { ResolvedConfig } from '../../config/types';
import type { PromptMemory } from '../../memory/types';
import type { MindState } from '../../mind/state/mind-state';
import type { Traits } from '../../persona/self/traits';
import type { RelationshipSnapshot } from '../../mind/state/relationship';
import type { ThinkResult } from '../../mind/reflection/think';
import type { ChatMessage, ContentPart } from '../../model/providers/openai-compatible';
import type { ActivePersona, InstanceOwner } from '../ports';
import type { SessionRecord, StoredMessage } from '../../session/persistence';
import type { ContextWindow } from '../../session/window';
import type { PipelineDeps, SendAction } from '../deps';

export type Channel = 'private' | 'group';

/**
 * 管道里流动的唯一对象。
 *
 * `readonly` 的字段是入口就绪的；其余由 pipe 逐步填充 ——
 * 类型上它们都是必填，因为"顺序"由 `assertPipeGraph` 保证，而不是靠 `?` + `!`。
 */
export type PipelineContext = {
  // ── 入口就绪 ──
  readonly message: InboundMessage;
  readonly send: SendAction;
  readonly caps: PlatformCapabilities;
  readonly deps: PipelineDeps;
  readonly channel: Channel;
  readonly wait: (ms: number) => Promise<void>;

  // ── 逐步填充 ──
  /** 处理时刻（一次固定，后续所有判断都用它，不各自 `new Date()`） */
  now: Date;
  session: SessionRecord;
  inbound: StoredMessage;
  owner: InstanceOwner;
  persona: ActivePersona | null;
  config: ResolvedConfig['config'];
  sessionFlags: ResolvedConfig['sessionFlags'];
  mind: MindState;
  relationship: RelationshipSnapshot | null;
  window: ContextWindow;
  /** 读回的记忆（M5-1）：注入 prompt 的"你还记得" */
  memories: PromptMemory;
  /** 演化后的自己（M5-2）：注入 prompt 的"现在的你" */
  selfState: { narrative: string; traits: Traits; lines: string[] };
  /** 入站图片转成的多模态段（没配视觉模型时为空） */
  imageParts: ContentPart[];
  /** 素材库别名清单（塞进 prompt 的"你手上有这些"） */
  assetAliases: string[];
  /** 人格 system prompt（未经过 think 加工） */
  system: string;
  /** 带导演指令的 system prompt（think 关掉/失败时等于 `system`） */
  directedSystem: string;
  messages: ChatMessage[];
  think: ThinkResult | null;
  /** 模型产出的原始文本（含 `[img]` / `[voice]` 标记，出站时才解析） */
  replyText: string;
  quoteTarget: string | undefined;
};

export type PipeField = keyof PipelineContext;

export interface Pipe {
  readonly name: string;
  /** 本 pipe 要读的字段（必须已被前序提供） */
  readonly requires: readonly PipeField[];
  /** 本 pipe 写完的字段 */
  readonly provides: readonly PipeField[];
  /** 返回 `DROP` 表示"到此为止"（不回消息，或已经在内部做了收尾） */
  run(ctx: PipelineContext): Promise<void | Drop>;
}

/** 入口就绪的字段，不需要任何 pipe 提供 */
const BASE_FIELDS: readonly PipeField[] = ['message', 'send', 'caps', 'deps', 'channel', 'wait'];

/**
 * 建上下文。
 *
 * 全文唯一一处 `as`：入口只有 6 个字段，其余字段是"前序 pipe 的产出"。
 * 类型上把它们标成必填，是为了让每个 pipe 里少一堆 `?.` 与 `!`；
 * 顺序正确性交给 `assertPipeGraph`，而不是交给类型系统自欺欺人。
 */
export function createContext(input: {
  message: InboundMessage;
  send: SendAction;
  caps: PlatformCapabilities;
  deps: PipelineDeps;
  channel: Channel;
  wait: (ms: number) => Promise<void>;
}): PipelineContext {
  return { ...input } as PipelineContext;
}

/**
 * 启动时校验管道图。三条规则：
 *   1. 每个 `requires` 必须已经有人提供过；
 *   2. 同一字段不许被两个 pipe 提供（后写的会静默覆盖前者，几乎总是复制粘贴错误）；
 *   3. pipe 名字不许重复（日志里靠它定位）。
 */
export function assertPipeGraph(pipes: readonly Pipe[]): void {
  const provided = new Set<PipeField>(BASE_FIELDS);
  const names = new Set<string>();

  for (const pipe of pipes) {
    if (names.has(pipe.name)) {
      throw new Error(`Pipe 名字重复：${pipe.name}`);
    }
    names.add(pipe.name);

    for (const field of pipe.requires) {
      if (!provided.has(field)) {
        throw new Error(`Pipe「${pipe.name}」需要 ${field}，但前序没有任何 pipe 提供它`);
      }
    }
    for (const field of pipe.provides) {
      if (provided.has(field)) {
        throw new Error(`Pipe「${pipe.name}」重复提供 ${field}`);
      }
      provided.add(field);
    }
  }
}
