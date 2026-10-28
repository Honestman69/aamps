/**
 * 主动消息的仓储端口（M5-3 / D047）。
 *
 * 过滤**全部下推到 SQL**：亲密度门槛、久未联系的时间边界都在 `where` 里。
 * 不做"全表捞出来再在应用层筛"—— 一个实例的 `Relationship` 几百上千行时，
 * 那会变成每次心跳都全量读一遍。
 */

export type ProactiveCandidate = {
  peerId: string;
  peerName: string | null;
  affinity: number;
  lastInteractionAt: Date | null;
};

export interface IProactiveRepository {
  /** 打开主动消息并且启用中的实例 */
  listEnabledInstanceIds(): Promise<string[]>;

  /** 候选：亲密度够 + 久未联系（时间边界与门槛在 SQL 里） */
  listCandidates(
    instanceId: string,
    filter: { minAffinity: number; idleBefore: Date; limit: number },
  ): Promise<ProactiveCandidate[]>;

  /** 上次给这个人主动发消息的时间 */
  lastProactiveAt(instanceId: string, peerId: string): Promise<Date | null>;

  /** 这个实例从 `since` 起主动发了几条 */
  countProactiveSince(instanceId: string, since: Date): Promise<number>;
}
