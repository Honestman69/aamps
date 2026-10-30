/**
 * 出站节流的仓储端口（M6-2 / D049）。
 *
 * 三个查询都**带窗口下推到 SQL**（`createdAt >= since` + `order by desc` + `take`），
 * 不把整张消息表捞到内存里再数。上限固定（200 / 10 条），因为节流只需要"够判"的量。
 */

export type OutboundRow = { content: string; createdAt: Date };

export interface IOutboundRepository {
  /** 会话内最近一段时间的出站（assistant）消息，倒序 */
  listOutbound(sessionId: string, since: Date, limit: number): Promise<OutboundRow[]>;

  /** 会话内最近若干条消息（含角色），用来数"连续说了几条" */
  listRecentMessages(sessionId: string, limit: number): Promise<Array<{ role: string }>>;

  /** 实例维度的当日出站条数（连表到 session 拿到 instanceId） */
  countOutboundForInstance(instanceId: string, since: Date): Promise<number>;
}
