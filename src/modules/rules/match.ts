/**
 * 约束词匹配（D051）。
 *
 * ## 为什么是"纯文本包含"而不是正则
 *
 * 三个理由，都很具体：
 *   1. **灾难性回溯**：用户写一个 `(a+)+$` 就能让主链路卡死。这条路径在**每条消息**上跑。
 *   2. **解释不了**：命中之后要回答"为什么被拦"。正则会给出"你写的第 3 条正则匹配了"，
 *      而纯文本能说"因为里面有「离婚」"。
 *   3. **需求本来就是片段**：owner 想表达的是"别聊这个""别出现这个词"，
 *      不需要 `\b`、不需要分组。真需要复杂规则时，那是代码该干的事，不是配置。
 *
 * ## 归一化
 *
 * 小写 + 去掉所有空白。中文没有大小写问题，但英文昵称/缩写有；
 * 空白是"用 空格 绕过关键词"的最低成本手段。标点**不去**：
 * 「不 要 提 前 任」这种绕过属于刻意对抗，防它要付出误杀正常语句的代价。
 */

export type RuleKind = 'input_block' | 'output_block';

export const RULE_KINDS: readonly RuleKind[] = ['input_block', 'output_block'] as const;

export type MatchableRule = {
  id: string;
  kind: string;
  pattern: string;
  enabled: boolean;
};

export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * 在某类规则里找第一条命中的。
 *
 * **最长优先**：同时命中「前任」和「前任的名字」时，报后者 —— 命中说明越具体，
 * 人越容易看懂"为什么被拦"。
 */
export function matchRule<T extends MatchableRule>(
  text: string,
  rules: readonly T[],
  kind: RuleKind,
): T | null {
  const haystack = normalizeForMatch(text);
  if (!haystack) {
    return null;
  }

  let hit: T | null = null;
  let hitLength = 0;
  for (const rule of rules) {
    if (!rule.enabled || rule.kind !== kind) {
      continue;
    }
    const needle = normalizeForMatch(rule.pattern);
    if (!needle) {
      continue;
    }
    if (haystack.includes(needle) && needle.length > hitLength) {
      hit = rule;
      hitLength = needle.length;
    }
  }
  return hit;
}

/** 落库用的 blockReason：`rule:<id>`（与 `Message.blockReason` 的注释口径一致） */
export function blockReasonOf(rule: MatchableRule): string {
  return `rule:${rule.id}`;
}
