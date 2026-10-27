/**
 * 几个 pipe 共用的读写。
 *
 * 抽出来的唯一标准：**同一段逻辑被两个以上 pipe 用到**。
 * 除此之外不抽 —— 过早抽象会让"某一步到底做了什么"散到三个文件里。
 */

import type { InboundMessage } from '@newjob/contracts';

import { createMindState, decayState, type MindState } from '../../mind/state/mind-state';
import { nextAffinity, type RelationshipSnapshot } from '../../mind/state/relationship';
import type { PipelineDeps } from '../deps';
import type { Channel } from './types';

/** 私聊 / 群聊。全管道只在这里判一次 `session.kind` */
export function channelOf(message: InboundMessage): Channel {
  return message.session.kind === 'group' ? 'group' : 'private';
}

/**
 * 读状态并**先衰减到 now** 再返回。
 *
 * 为什么在读取时就衰减：后面的发言决策、语气提示、延迟系数都用它。
 * 拿几小时前的精力做判断，等于让"刚睡醒"和"熬到半夜"表现一样（D032）。
 * 读失败一律当"没有历史"：状态是表现层，坏了最多这几句不像人（D011）。
 */
export async function loadMindState(
  deps: PipelineDeps,
  instanceId: string,
  now: Date,
): Promise<MindState> {
  const stored = await deps.mind.loadState(instanceId).catch(() => null);
  return decayState(stored ?? createMindState(now), now);
}

export async function loadRelationship(
  deps: PipelineDeps,
  instanceId: string,
  peerId: string,
): Promise<RelationshipSnapshot | null> {
  return deps.mind.loadRelationship(instanceId, peerId).catch(() => null);
}

export async function persistMind(
  deps: PipelineDeps,
  instanceId: string,
  state: MindState,
): Promise<void> {
  await deps.mind.saveState(instanceId, state).catch(() => undefined);
}

/**
 * 关系推进。`replied` 区分"回了"与"看了不回"：
 * 后者只涨一点点（人对"被看着"是有感觉的，但远不如对话）。
 */
export async function persistRelationship(
  deps: PipelineDeps,
  instanceId: string,
  message: InboundMessage,
  relationship: RelationshipSnapshot | null,
  now: Date,
  replied: boolean,
): Promise<void> {
  const { affinity, lastInteractionAt } = nextAffinity(
    relationship,
    {
      channel: channelOf(message),
      replied,
      mentioned: message.isMentioned,
      textLength: message.plainText.length,
    },
    now,
  );
  await deps.mind
    .saveRelationship({
      instanceId,
      peerId: message.sender.id,
      nickname: message.sender.name || relationship?.nickname || null,
      affinity,
      lastInteractionAt,
    })
    .catch(() => undefined);
}
