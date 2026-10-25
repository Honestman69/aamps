/**
 * 双阶段生成的开关（D036）。
 *
 * 默认开：M3 的全部意义就是"别像机器人"，而内心独白是其中性价比最高的一环。
 * 但它**确实多花一次调用**，所以给两个出口：
 *   - `behaviorJson.think.enabled = false`：这个角色不思考，直接单阶段（省钱/省延迟）；
 *   - 预算耗尽时网关会按 D024 降级，此时 think 仍然只花 `modelCheap` 的钱。
 *
 * 与 D011 一致：`mind` 是可关的装饰器，关掉之后对话本身必须照常。
 */

export type ThinkPolicy = {
  enabled: boolean;
};

export const DEFAULT_THINK_POLICY: ThinkPolicy = { enabled: true };

export function parseThinkPolicy(raw: string | null): ThinkPolicy {
  if (!raw) {
    return DEFAULT_THINK_POLICY;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_THINK_POLICY;
    }
    const block = (parsed as Record<string, unknown>).think;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return DEFAULT_THINK_POLICY;
    }
    const enabled = (block as Record<string, unknown>).enabled;
    return { enabled: enabled === false ? false : DEFAULT_THINK_POLICY.enabled };
  } catch {
    return DEFAULT_THINK_POLICY;
  }
}
