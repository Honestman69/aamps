/**
 * 心智状态的读写端口。
 *
 * 两张表，职责不同：
 *   - `AgentState`（每个实例一行）：mood / energy / busyUntil，瞬态，可丢失
 *   - `Relationship`（每个实例 × 每个对方一行）：affinity / lastInteractionAt，长期积累
 *
 * 这里**没有** `findMany` / 批量扫描：主链路上只按 `instanceId` 与 `(instanceId, peerId)` 取，
 * 不需要"列出所有关系"的能力。看板要列表时再单独加读模型，而不是把泛查询开在这里。
 */

import type { MindState } from './mind-state';
import type { RelationshipSnapshot } from './relationship';

export interface IMindStateRepository {
  /** 没有记录时返回 null（新实例第一次说话就是这样） */
  loadState(instanceId: string): Promise<MindState | null>;

  /** 全量覆盖写入（upsert）。状态是瞬态，不做增量合并 */
  saveState(instanceId: string, state: MindState): Promise<void>;

  loadRelationship(instanceId: string, peerId: string): Promise<RelationshipSnapshot | null>;

  /**
   * 写关系。
   *
   * 只写 affinity / nickname / lastInteractionAt 三个字段：`trust` 是人工/反思层的产物，
   * 不能被每条消息覆盖；`isOwner` 是实例归属的判定结果，同样不该在这里写。
   */
  saveRelationship(input: {
    instanceId: string;
    peerId: string;
    nickname: string | null;
    affinity: number;
    lastInteractionAt: Date;
  }): Promise<void>;
}
