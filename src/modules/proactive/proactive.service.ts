/**
 * 主动消息服务（M5-3 / D047）。
 *
 * 一句话概括：**隔了很久没说话的人，它主动说一句**。
 *
 * ## 为什么"主动"要单独一条路径，而不是复用入站管道
 *
 * 入站管道从"收到一条消息"开始（落库 → 窗口 → attention → 拼 prompt），
 * 主动消息没有入站消息、没有窗口、也不需要 attention —— 它的"要不要说话"
 * 由 `decideProactive` 先判完。硬塞进管道会让每个 pipe 都多一个 `if (proactive)`。
 *
 * 但**出站仍然只有一条路**：生成 → 发送 → 落库，顺序与 `deliver` 完全一致
 * （先发后落库：没发出去就不该留下"我说过"的记录）。
 *
 * ## 三条纪律
 *
 * 1. **默认关闭**：实例没开开关时，`sweep` 连候选都不查。
 * 2. **一次只发一条、不拆条、不带媒体**：主动消息是"想起你了"，连发三条就不像人。
 * 3. **任何异常都吞掉**：这是个定时任务，抛出去只会让 Nest 打一堆栈，明天照跑。
 */

import type { OutboundAction } from '@newjob/contracts';

import { assemblePrompt } from '../persona/prompt';
import { createMindState, decayState } from '../mind/state/mind-state';
import type { IMindStateRepository } from '../mind/state/ports';
import type { PromptMemory } from '../memory/types';
import type { ActivePersona, InstanceOwner } from '../pipeline/ports';
import type { ISessionRepository } from '../session/persistence';
import {
  decideProactive,
  PROACTIVE_LIMITS,
  type ProactiveRejectReason,
} from './decide';
import type { IProactiveRepository, ProactiveCandidate } from './ports';

/** 生成一句话的模型入口（结构上兼容 `GatewayService`，测试里给两行假的） */
export type ProactiveModel = {
  chat(input: {
    instanceId: string;
    ownerUserId: string;
    sessionId: string;
    purpose: 'chat';
    messages: Array<{ role: 'system' | 'user'; content: string }>;
  }): Promise<{ text: string }>;
};

export type ProactiveSender = {
  /** 实例当前没连接时返回 `ok: false`（不抛） */
  send(instanceId: string, action: OutboundAction): Promise<{ ok: boolean }>;
};

export type ProactiveDeps = {
  repo: IProactiveRepository;
  config: {
    get(
      instanceId: string,
      options?: { sessionId?: string | null },
    ): Promise<{ config: { proactiveEnabled: boolean }; sessionFlags: { aiPaused: boolean; muted: boolean } }>;
  };
  pipeline: {
    findOwner(instanceId: string): Promise<InstanceOwner | null>;
    findActivePersona(instanceId: string): Promise<ActivePersona | null>;
  };
  mind: IMindStateRepository;
  memory: {
    loadForPrompt(input: {
      instanceId: string;
      sessionId: string;
      subjectId: string;
    }): Promise<PromptMemory>;
  };
  self: {
    describeForPrompt(instanceId: string): Promise<{ narrative: string; lines: string[] }>;
  };
  gateway: ProactiveModel;
  sessions: ISessionRepository;
  sender: ProactiveSender;
  clock?: () => Date;
};

export type ProactiveSkipReason =
  | ProactiveRejectReason
  | 'no-persona'
  | 'session-paused'
  | 'empty-reply'
  | 'send-failed';

export type SweepReport = {
  instances: number;
  sent: number;
  skipped: number;
  failed: number;
  /** 只留"发了"与"出错"两类，够日志用，不刷屏 */
  events: Array<{ instanceId: string; peerId?: string; ok: boolean; reason: string }>;
};

/**
 * 让模型"主动说一句"的指令。
 *
 * 三条禁令都是踩过的坑：说"好久没聊"（把沉默变成话题，很尴尬）、
 * 问"在吗"（逼对方立刻回应）、自我介绍/解释动机（机器人才解释自己为什么说话）。
 */
export const PROACTIVE_INSTRUCTION = [
  '【现在不是对方在跟你说话，是你在主动找他】',
  '你有阵子没和他聊了，忽然想起他，想说一句话。',
  '',
  '规则：',
  '- 只写你要发出去的那一句话，不要引号，不要解释',
  '- 别提"很久没聊""好久不见""最近怎么样"这种客套',
  '- 别问"在吗"，也别做自我介绍',
  '- 一到两小句，越自然越好；没话说就不说（输出空字符串也可以）',
].join('\n');

/** 主动消息的长度上限：超过它就不是"一句话"了 */
const MAX_REPLY_CHARS = 80;

/**
 * 清洗模型输出。
 *
 * 去引号是因为模型很容易把"一句话"写成 `"在忙什么呢"`；带引号发出去像在念台词。
 * 带媒体标记的直接丢掉：主动消息不拆条、不带图，标记留在正文里会变成一串方括号。
 */
export function cleanProactiveReply(raw: string): string {
  const text = raw
    .trim()
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .trim();
  if (!text || text.length > MAX_REPLY_CHARS) {
    return '';
  }
  if (/\[(img|voice|use|save)[\]\/]/i.test(text)) {
    return '';
  }
  return text;
}

function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

export class ProactiveService {
  constructor(private readonly deps: ProactiveDeps) {}

  /** 一轮心跳：扫所有开了开关的实例 */
  async sweep(now = this.now()): Promise<SweepReport> {
    const report: SweepReport = { instances: 0, sent: 0, skipped: 0, failed: 0, events: [] };
    let instanceIds: string[] = [];
    try {
      instanceIds = await this.deps.repo.listEnabledInstanceIds();
    } catch {
      return report;
    }

    report.instances = instanceIds.length;
    for (const instanceId of instanceIds) {
      try {
        const result = await this.sweepInstance(instanceId, now);
        report.sent += result.sent;
        report.skipped += result.skipped;
        report.events.push(...result.events);
      } catch {
        // 一个实例出错不影响其他实例；定时任务不该因为一条脏数据停摆
        report.failed += 1;
        report.events.push({ instanceId, ok: false, reason: 'sweep-failed' });
      }
    }
    return report;
  }

  /** 单个实例：查候选 → 逐个过闸门 → 说话 */
  async sweepInstance(
    instanceId: string,
    now = this.now(),
  ): Promise<Pick<SweepReport, 'sent' | 'skipped' | 'events'>> {
    const result: Pick<SweepReport, 'sent' | 'skipped' | 'events'> = {
      sent: 0,
      skipped: 0,
      events: [],
    };

    const resolved = await this.deps.config.get(instanceId).catch(() => null);
    if (!resolved?.config.proactiveEnabled) {
      // 开关关着：一个候选都不查
      return result;
    }

    const candidates = await this.deps.repo.listCandidates(instanceId, {
      minAffinity: PROACTIVE_LIMITS.minAffinity,
      idleBefore: new Date(now.getTime() - PROACTIVE_LIMITS.minIdleHours * 3600_000),
      limit: 5,
    });
    if (candidates.length === 0) {
      return result;
    }

    // 当天已发条数取一次，循环里自己累加（避免每条候选都查一次库）
    let sentToday = await this.deps.repo.countProactiveSince(instanceId, startOfDay(now));

    for (const candidate of candidates) {
      if (sentToday >= PROACTIVE_LIMITS.perInstancePerDay) {
        break;
      }

      const lastProactiveAt = await this.deps.repo.lastProactiveAt(instanceId, candidate.peerId);
      const decision = decideProactive({
        now,
        enabled: true,
        affinity: candidate.affinity,
        lastInteractionAt: candidate.lastInteractionAt,
        lastProactiveAt,
        instanceCountToday: sentToday,
      });

      if (!decision.speak) {
        result.skipped += 1;
        continue;
      }

      const outcome = await this.speakTo(instanceId, candidate, now);
      if (outcome.ok) {
        sentToday += 1;
        result.sent += 1;
        result.events.push({
          instanceId,
          peerId: candidate.peerId,
          ok: true,
          reason: `idle-${decision.idleHours}h`,
        });
      } else {
        result.skipped += 1;
        result.events.push({
          instanceId,
          peerId: candidate.peerId,
          ok: false,
          reason: outcome.reason,
        });
      }
    }

    return result;
  }

  // ── 内部 ──

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /** 对一个候选"生成 → 发送 → 落库"。全程不抛。 */
  private async speakTo(
    instanceId: string,
    candidate: ProactiveCandidate,
    now: Date,
  ): Promise<{ ok: true } | { ok: false; reason: ProactiveSkipReason }> {
    const persona = await this.deps.pipeline.findActivePersona(instanceId).catch(() => null);
    const owner = await this.deps.pipeline.findOwner(instanceId).catch(() => null);
    if (!persona || !owner) {
      // 没有人设就没有"它自己"，硬发只会像系统通知
      return { ok: false, reason: 'no-persona' };
    }

    const session = await this.deps.sessions.ensureSession({
      instanceId,
      kind: 'private',
      peerId: candidate.peerId,
      peerName: candidate.peerName,
    });

    // 会话级人工接管要尊重：`aiPaused` 意味着"这段时间我来说"
    const resolved = await this.deps.config
      .get(instanceId, { sessionId: session.id })
      .catch(() => null);
    if (resolved && (resolved.sessionFlags.aiPaused || resolved.sessionFlags.muted)) {
      return { ok: false, reason: 'session-paused' };
    }

    const [memory, selfInfo, stored] = await Promise.all([
      this.deps.memory
        .loadForPrompt({ instanceId, sessionId: session.id, subjectId: candidate.peerId })
        .catch(() => ({ facts: [], summaries: [] }) as PromptMemory),
      this.deps.self
        .describeForPrompt(instanceId)
        .catch(() => ({ narrative: '', lines: [] as string[] })),
      this.deps.mind.loadState(instanceId).catch(() => null),
    ]);
    const mind = decayState(stored ?? createMindState(now), now);

    const assembled = assemblePrompt(persona, {
      peerName: candidate.peerName,
      channel: 'private',
      selfName: owner.name,
      state: { mood: mind.mood, energy: mind.energy },
      // 主动消息不发图不发语音（见文件头第 2 条），能力声明留空
      capabilities: { imageReply: false, voiceReply: false },
      memory,
      self: { narrative: selfInfo.narrative, lines: selfInfo.lines },
    });

    const reply = await this.deps.gateway
      .chat({
        instanceId,
        ownerUserId: owner.ownerUserId,
        sessionId: session.id,
        purpose: 'chat',
        messages: [
          { role: 'system', content: `${assembled.system}\n\n${PROACTIVE_INSTRUCTION}` },
          {
            role: 'user',
            content: `（现在你想起了${candidate.peerName ?? '他'}，想主动说一句话。）`,
          },
        ],
      })
      .catch(() => null);

    const text = cleanProactiveReply(reply?.text ?? '');
    if (!text) {
      return { ok: false, reason: 'empty-reply' };
    }

    const action: OutboundAction = {
      kind: 'send',
      session: { kind: 'private', peerId: candidate.peerId },
      segments: [{ type: 'text', text }],
    };
    const sent = await this.deps.sender.send(instanceId, action).catch(() => ({ ok: false }));
    if (!sent.ok) {
      return { ok: false, reason: 'send-failed' };
    }

    // 先发后落库：没发出去就不该留下"我说过"的记录（同 deliver）
    await this.deps.sessions
      .saveOutbound({
        sessionId: session.id,
        content: text,
        senderId: null,
        proactive: true,
      })
      .catch(() => undefined);

    return { ok: true };
  }
}
