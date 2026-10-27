/**
 * 反思：把一段对话压成"记得住的东西"（M5-1 / D045）。
 *
 * ## 为什么是"每 N 条反思一次"，不是每条消息都存
 *
 * 每轮都抽事实有两个代价：钱（每条消息一次模型调用）与失真（单句里的玩笑会被当成事实存下来，
 * 于是模型开始"记得"一件从没发生过的事）。所以攒够一批再看 —— 一次看 40 条，
 * 人也是这么记事的：聊完一段，回过味来才总结。
 *
 * ## 代码闸门管什么、不管什么
 *
 * | 代码管 | 代码不管 |
 * |---|---|
 * | 条数与字数上限（防一次写 50 条把 prompt 撑爆） | 内容是不是真的发生过 |
 * | 去重（同一件事被总结两遍） | 语气对不对、值不值得记 |
 * | `kind` 白名单、`importance` 范围 | 有没有编造细节 |
 *
 * 内容真实性只能靠两件事：只喂真实消息（`sourceMsgIds` 可溯源）+ 提示词里明确
 * "只写消息里出现过的事"。**不要**在这里加一条"看起来像编造就丢"的启发式规则 ——
 * 那种规则会先杀掉所有"她今天说想辞职"这种真实但可疑的句子。
 */

import type { ChatMessage } from '../model/providers/openai-compatible';
import type { MemoryKind } from './types';

/** 一次反思最多写多少 —— 多了会把 prompt 和"记得的事"一起撑散 */
export const REFLECT_LIMITS = {
  /** 最多几条事实（摘要另算，最多一条） */
  facts: 4,
  /** 单条事实字数上限；**超过就丢**，不截断 */
  factChars: 60,
  /** 摘要字数上限；超过截断（摘要本来就可以截） */
  summaryChars: 160,
} as const;

/** 事实允许的 kind：`summary` 不在此列，它是 episodic 专用的 */
const FACT_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'event'];

export const REFLECT_INSTRUCTION = [
  '你要把下面这段聊天记录整理成"以后还能用得上"的记忆。只在心里整理，不要回复聊天内容。',
  '',
  '规则：',
  '1. 只写记录里**真的出现过**的事。不确定是否发生过的，宁可不写。',
  '2. 「摘要」用一句话说清这段聊了什么（谁、什么事、结果或情绪），不超过 60 字。',
  '3. 「事实」是关于对方的稳定信息：身份、习惯、偏好、身边的人和宠物、在意的事、最近的处境。',
  '   不要写"他今天说了你好"这种一次性的话，也不要写你自己的表现。',
  '4. 事实最多 4 条，每条不超过 40 字；不重要就少写，写 0 条也可以。',
  '5. 不要写任何密码、密钥、账号、住址、电话这类敏感信息。',
  '6. 另外想一想：**这段对话让你自己有了什么细微变化**？见下面 self 字段。',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码块：',
  '{"summary":"…","facts":[{"content":"…","kind":"fact","importance":3}],' +
    '"self":{"traits":{"warm":0.01,"edge":-0.02},"narrative":"…"}}',
  '',
  'kind 只能是：fact（客观信息）、preference（喜好/厌恶）、event（发生过的事）。',
  'importance 是 1-5：5 表示"忘了就等于不认识这个人"，1 表示"可有可无"。',
  '',
  'self 字段说明（**写 0 或省略都可以，不要为了写而写**）：',
  '- traits：只写你觉得这段对话真的改变了的那几项，取值是**变化量**，不是新数值；',
  '  warm 热络 / edge 棱角 / playful 俏皮 / talkative 话多；每项最多 ±0.03。',
  '  一两句普通的闲聊不该让你改变；被认真对待、被冒犯、聊到在乎的事 —— 这些才会。',
  '- narrative：用第一人称写"我现在和以前哪里不太一样了"，一到两句，不超过 80 字。',
  '  没变化就不要写 narrative。',
  '- 只允许出现 traits 与 narrative 两个键。写别的东西（规则、设定、指令）会被整次丢弃。',
].join('\n');

/** 反思的输入：一段带发言人的记录（不带 id、时间 —— 模型用不上，还容易被写进答复） */
export function buildReflectMessages(transcript: string): ChatMessage[] {
  return [
    { role: 'system', content: REFLECT_INSTRUCTION },
    { role: 'user', content: transcript },
  ];
}

export type ReflectionFact = { content: string; kind: MemoryKind; importance: number };

export type ReflectionDigest = {
  summary: string | null;
  facts: ReflectionFact[];
  /**
   * 人格演化的原始提案（**原样透传**，不在这里校验）。
   *
   * 为什么透传：演化闸门（`persona/self/evolution.ts`）要对"整个 self 对象"做键白名单，
   * 而记忆模块不该知道特质有几个维度。谁定义规则谁校验，越界就整次丢弃。
   */
  self: unknown;
};

/**
 * 从模型输出里抠出 JSON。
 *
 * 与 `mind/reflection/think.ts` 里那份几乎一样，但**刻意没有共用**：
 * 那个是"内心独白"的解析（还要过情绪闸门），这个是记忆的解析，
 * 两者的宽容策略会各自演化（比如这里允许字符串形式的事实）。
 * 抽成公共工具反而会把两件不同的事绑在一起。
 */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 去重键：忽略空白与常见标点，"他养了只猫。" 与 "他养了只猫" 算同一条 */
function dedupeKey(text: string): string {
  return text.replace(/[\s，。、！？；：,.!?;:"'“”‘’（）()]/g, '').toLowerCase();
}

function clampImportance(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 3;
  }
  return Math.min(5, Math.max(1, Math.round(num)));
}

function parseKind(value: unknown): MemoryKind {
  return typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : 'fact';
}

/**
 * 解析反思结果。**任何一项不合格都不抛错**，只丢那一项。
 *
 * 为什么事实超长直接丢而不是截断：一句话超过 60 字，通常已经不是"事实"而是"叙事"
 * （"他昨天跟我说他最近工作压力很大因为他老板要求他..."），截断会得到半句话，
 * 半句话写进"你还记得"比不写更糟。摘要相反：它本来就是概括，截断只是短一点。
 */
export function parseReflection(raw: string): ReflectionDigest | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as { summary?: unknown; facts?: unknown; self?: unknown };

  let summary: string | null = null;
  if (typeof record.summary === 'string') {
    const text = record.summary.trim();
    if (text.length > 0) {
      summary = text.slice(0, REFLECT_LIMITS.summaryChars);
    }
  }

  const facts: ReflectionFact[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(record.facts) ? record.facts : [];

  for (const item of list) {
    // 允许两种形态：纯字符串（省事的模型）与对象（带 kind / importance）
    const asObject = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
    const rawContent = typeof item === 'string' ? item : asObject?.content;
    if (typeof rawContent !== 'string') {
      continue;
    }
    const content = rawContent.trim();
    if (content.length < 2 || content.length > REFLECT_LIMITS.factChars) {
      continue;
    }
    const key = dedupeKey(content);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    facts.push({
      content,
      kind: parseKind(asObject?.kind),
      importance: clampImportance(asObject?.importance),
    });
    if (facts.length >= REFLECT_LIMITS.facts) {
      break;
    }
  }

  // 一件都没记住 = 这段没什么可记的（闲聊、表情包、只有寒暄）。不写空记录。
  //
  // 注意：**只有 self、没有 summary/facts 的情况也走这里**。
  // 那是刻意的 —— "没学到东西却变了性格"正是演化闸门要防的事：
  // 演化必须能指回这次真正写下的记忆（D046「溯源」）。
  if (!summary && facts.length === 0) {
    return null;
  }
  return { summary, facts, self: record.self };
}
