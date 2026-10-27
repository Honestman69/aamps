/**
 * 记忆服务：**读回**（注入 prompt）与**反思**（攒够了再总结）两件事（M5-1 / D045）。
 *
 * ## 一条硬规矩：这里的方法永不 throw
 *
 * 两个调用点都在"消息已经发出去"之后（`load-memory` 在拼 prompt 前、`write-memory`
 * 在交互回写后）。抛出去会被编排层当成故障 → 触发兜底话术 → **对方收到第二条消息**。
 * 记忆是装饰，装饰坏了不能反过来毁掉这一轮对话（D011 同一条逻辑）。
 * 所以每处都 catch 住，只返回"这次没做成"。
 *
 * ## 反思的触发条件是"攒够条数"，不是"到了几点"
 *
 * 定时任务（cron）要先有"这台机器在跑多久"的假设：一个三天没开机的实例，
 * 每晚 3 点反思一次等于三次空转。按条数触发则天然对齐"真的有新东西可记"。
 * 代价是一次 COUNT 查询（`Message` 表有 `(sessionId, createdAt)` 索引，代价很低）。
 */

import type { ChatMessage } from '../model/providers/openai-compatible';
import type { IMemoryRepository, TranscriptMessage } from './ports';
import {
  buildReflectMessages,
  parseReflection,
  REFLECT_LIMITS,
  type ReflectionDigest,
} from './reflect';
import {
  EMPTY_MEMORY,
  type MemoryDraft,
  type PromptMemory,
} from './types';

/**
 * 反思用的模型入口。
 *
 * 不直接依赖 `GatewayService`：这里只需要"发一段 messages，拿回一段文本"。
 * 依赖具体网关会让单测必须造一整套网关依赖，而这里要测的是"什么时候写、写什么"。
 */
export type ReflectionModel = {
  chat(input: {
    instanceId: string;
    ownerUserId: string;
    sessionId: string;
    purpose: 'reflection';
    messages: ChatMessage[];
  }): Promise<{ text: string }>;
};

export type MemoryOptions = {
  /** 攒够多少条消息反思一次（D020「每 30 轮」的落地形式） */
  reflectEvery: number;
  /** 一次反思喂多少条消息（多于 `reflectEvery` 是为了让摘要有点上下文） */
  transcriptLimit: number;
  /** 注入 prompt 的事实条数上限 */
  factLimit: number;
  /** 注入 prompt 的摘要条数上限 */
  summaryLimit: number;
};

export const DEFAULT_MEMORY_OPTIONS: MemoryOptions = {
  reflectEvery: 30,
  transcriptLimit: 40,
  factLimit: 6,
  summaryLimit: 3,
};

export type PromptMemoryInput = {
  instanceId: string;
  sessionId: string;
  subjectId: string;
};

export type ReflectInput = PromptMemoryInput & {
  ownerUserId: string;
  now: Date;
};

export type ReflectOutcome = {
  written: number;
  reason: 'ok' | 'below-threshold' | 'nothing-to-remember' | 'failed';
  detail?: string;
};

/** 反思的原料总字数上限：一条复读机刷屏不该把这次调用撑爆 */
const TRANSCRIPT_MAX_CHARS = 4000;
/** 溯源最多留多少个消息 id（够定位到大致区间即可） */
const SOURCE_MSG_LIMIT = 20;

/**
 * 把消息拼成"人话记录"。
 *
 * 只保留 `谁：说了什么`：id 与时间戳对"记得住什么"没有帮助，反而会被模型抄进摘要里
 * （见过输出"2026-10-27 12:00 他说…"，那不是记忆，是日志）。
 * 从**最后**往前取，直到字数上限 —— 反思要看的是最近的这一段。
 */
export function buildTranscript(messages: TranscriptMessage[]): string {
  const lines: string[] = [];
  let budget = TRANSCRIPT_MAX_CHARS;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    const who = message.role === 'assistant' ? '我' : (message.senderName?.trim() || '对方');
    const line = `${who}：${text.slice(0, 200)}`;
    budget -= line.length;
    if (budget <= 0 && lines.length > 0) {
      break;
    }
    lines.push(line);
  }

  return lines.reverse().join('\n');
}

export class MemoryService {
  constructor(
    private readonly repo: IMemoryRepository,
    private readonly model: ReflectionModel,
    private readonly options: MemoryOptions = DEFAULT_MEMORY_OPTIONS,
  ) {}

  /** 读回：事实（按人）+ 最近摘要（按会话）。失败就是"这次没记忆"，不抛。 */
  async loadForPrompt(input: PromptMemoryInput): Promise<PromptMemory> {
    try {
      const { facts, summaries } = await this.repo.listForPrompt({
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        subjectId: input.subjectId,
        factLimit: this.options.factLimit,
        summaryLimit: this.options.summaryLimit,
        now: new Date(),
      });
      return {
        facts: facts.map((row) => row.content).filter(Boolean),
        summaries: summaries.map((row) => row.content).filter(Boolean),
      };
    } catch {
      return EMPTY_MEMORY;
    }
  }

  /**
   * 反思：攒够 `reflectEvery` 条就总结一次。
   *
   * 顺序刻意是"先数、再看、再调模型"：
   * 数不够就一次模型调用都不花（绝大多数消息会走到这个分支）；
   * 调模型之前才去读 40 条消息，避免为每条消息都拉一次正文。
   */
  async maybeReflect(input: ReflectInput): Promise<ReflectOutcome> {
    try {
      const last = await this.repo.lastEpisodicAt(input.sessionId);
      const pending = await this.repo.countMessagesSince(input.sessionId, last);
      if (pending < this.options.reflectEvery) {
        return { written: 0, reason: 'below-threshold' };
      }

      const messages = await this.repo.listRecentMessages(
        input.sessionId,
        this.options.transcriptLimit,
      );
      const transcript = buildTranscript(messages);
      if (!transcript) {
        return { written: 0, reason: 'nothing-to-remember' };
      }

      const result = await this.model.chat({
        instanceId: input.instanceId,
        ownerUserId: input.ownerUserId,
        sessionId: input.sessionId,
        purpose: 'reflection',
        messages: buildReflectMessages(transcript),
      });

      const digest = parseReflection(result.text);
      if (!digest) {
        return { written: 0, reason: 'nothing-to-remember' };
      }

      const drafts = this.toDrafts(input, digest, messages);
      if (drafts.length === 0) {
        return { written: 0, reason: 'nothing-to-remember' };
      }

      // 去重：同一件事长期关系里会反复出现，存十遍只会让 prompt 里重复十行
      const existing = await this.repo.existingContents(
        input.instanceId,
        input.subjectId,
        drafts.map((draft) => draft.content),
      );
      const fresh = drafts.filter((draft) => !existing.has(draft.content));
      if (fresh.length === 0) {
        return { written: 0, reason: 'nothing-to-remember' };
      }

      const written = await this.repo.addMany(fresh);
      return { written, reason: 'ok' };
    } catch (err) {
      // 见文件头：这一步跑在"已经回完消息"之后，不能把异常放出去
      return {
        written: 0,
        reason: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 反思结果 → 待写入的行。
   *
   * 摘要挂会话（`sessionId`），事实挂人（`sessionId = null`）：
   * "我们在这个群里聊了什么"是会话的；"他养了只猫"是人的 —— 换个会话依然成立。
   * 如果把事实也钉在会话上，私聊里的了解到了群里就"想不起来"了。
   */
  private toDrafts(
    input: ReflectInput,
    digest: ReflectionDigest,
    messages: TranscriptMessage[],
  ): MemoryDraft[] {
    const sourceMsgIds = messages
      .slice(-SOURCE_MSG_LIMIT)
      .map((message) => message.id)
      .join(',');

    const drafts: MemoryDraft[] = [];

    if (digest.summary) {
      drafts.push({
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        subjectId: input.subjectId,
        scope: 'episodic',
        kind: 'summary',
        content: digest.summary.slice(0, REFLECT_LIMITS.summaryChars),
        importance: 3,
        sourceMsgIds,
      });
    }

    for (const fact of digest.facts) {
      drafts.push({
        instanceId: input.instanceId,
        sessionId: null,
        subjectId: input.subjectId,
        scope: 'semantic',
        kind: fact.kind,
        content: fact.content.slice(0, REFLECT_LIMITS.factChars),
        importance: fact.importance,
        sourceMsgIds,
      });
    }

    return drafts;
  }
}
