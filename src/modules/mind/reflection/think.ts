/**
 * 双阶段生成的 A 阶段：内心独白（think，ARCHITECTURE 6.3 / D036）。
 *
 * ## 为什么要多花一次调用
 *
 * 单阶段直出最容易"工整"：四平八稳、面面俱到、没有取舍。真人回话前会先有一瞬间的判断
 * ——"他在抱怨加班，想被安慰"、"这话有点冲，别顶回去"、"一句就够了"。把这一层显式化，
 * 第二次生成才有"导演指令"可用，才会出现"想怼但忍住了"这种真实感。
 *
 * ## 为什么是 JSON，而不是让模型"先想一想"
 *
 * 「先想一想再回答」这种自由文本的思考，下游没法用：拿不到情绪增量和长度意图，
 * 也没法判断它到底想不想接话。这里要的是**结构化的一小段**，所以强制 JSON，
 * 并做**宽容解析**（模型常在前后加解释或代码块）。
 *
 * ## 三条约束
 *
 * 1. **think 不进对话历史**：它写进 `Message.thinkJson` 供排查，绝不回灌给下一轮
 *    （否则模型会开始"表演内心戏"，越演越假）。
 * 2. **失败就跳过**：解析不出结构化结果 → 当作没有 think，直接单阶段生成。
 *    ARCHITECTURE 5 的失败策略就是"跳过，直接生成"。
 * 3. **emotion_shift 有单轮上限 ±0.3**：允许模型推动情绪，但不允许一轮从抑郁跳到狂喜。
 */

export type ThinkResult = {
  /** 0~1：这一句有多想说。低值会体现为更短更敷衍 */
  wantToReply: number;
  /** ±0.3：本轮对情绪（mood）的推动量 */
  emotionShift: number;
  /** 对方真正想要什么（"在抱怨加班，想被安慰"） */
  intent: string;
  /** 要点（1~5 条） */
  keyPoints: string[];
  /** 语气提示（"有点心疼，别太用力"） */
  tone: string;
  /** 长度意图（"短，1-2 句"） */
  lengthHint: string;
};

/** 单轮情绪推动上限：防止性格跳变 */
export const MAX_EMOTION_SHIFT = 0.3;

export const THINK_INSTRUCTION = [
  '在开口之前，先在心里过一遍（这段不会被对方看到）：',
  '',
  '1. 对方这句话真正想要什么？（被安慰 / 被认同 / 只是随口说说 / 想要个答案）',
  '2. 你此刻的情绪会因为这句话往哪边动一点？',
  '3. 你打算抓住哪一两个点回应？什么先不提？',
  '4. 用什么语气、说多长？',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码块、不要多余的字：',
  '{"want_to_reply":0.7,"emotion_shift":0.1,"intent":"…","key_points":["…","…"],"tone":"…","length_hint":"…"}',
  '',
  '字段含义：',
  '- want_to_reply：0~1，你有多想说这句话',
  `- emotion_shift：-${MAX_EMOTION_SHIFT}~${MAX_EMOTION_SHIFT}，这句话让你情绪往哪边动多少`,
  '- intent / tone / length_hint：中文短语，各不超过 30 字',
  '- key_points：1~5 条中文短语',
].join('\n');

/** 把 A 阶段的系统提示拼到人格 prompt 之后（人格设定仍然在前面，思考不覆盖它是谁） */
export function buildThinkSystem(baseSystem: string): string {
  return `${baseSystem}\n\n${THINK_INSTRUCTION}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asShortText(value: unknown, maxLength = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 从模型输出里抠出 JSON：允许前后有解释、允许 ```json 代码块 */
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

/**
 * 解析内心独白。
 *
 * 返回 null = 这一段不可用（不是 JSON / 一个字段都对不上），调用方应回落到单阶段生成。
 */
export function parseThink(raw: string): ThinkResult | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const source = parsed as Record<string, unknown>;

  const intent = asShortText(source.intent, 100);
  const tone = asShortText(source.tone, 100);
  const lengthHint = asShortText(source.length_hint, 60);
  const keyPoints = Array.isArray(source.key_points)
    ? source.key_points
        .map((item) => asShortText(item, 60))
        .filter((item) => item.length > 0)
        .slice(0, 5)
    : [];

  const hasAnySignal =
    intent.length > 0 || tone.length > 0 || lengthHint.length > 0 || keyPoints.length > 0 ||
    typeof source.want_to_reply === 'number' || typeof source.emotion_shift === 'number';
  if (!hasAnySignal) {
    return null;
  }

  const wantToReply =
    typeof source.want_to_reply === 'number' && Number.isFinite(source.want_to_reply)
      ? clamp(source.want_to_reply, 0, 1)
      : 0.5;
  const emotionShift =
    typeof source.emotion_shift === 'number' && Number.isFinite(source.emotion_shift)
      ? clamp(source.emotion_shift, -MAX_EMOTION_SHIFT, MAX_EMOTION_SHIFT)
      : 0;

  return { wantToReply, emotionShift, intent, keyPoints, tone, lengthHint };
}

/**
 * 把内心独白翻译成第二次调用的"导演指令"。
 *
 * 明确写"不要说出来"：不写的话模型会把这几个要点当成正文去复述，
 * 于是每条回复都变成"你想说的是：…"这种旁白体。
 */
export function buildDirectorBlock(think: ThinkResult | null): string {
  if (!think) {
    return '';
  }
  const lines = ['（下面是你刚才心里的想法，自己知道就行，不要说出口，也不要解释）'];
  if (think.intent) {
    lines.push(`你判断对方想要的是：${think.intent}`);
  }
  if (think.keyPoints.length > 0) {
    lines.push(`你想抓住的点：${think.keyPoints.join('；')}`);
  }
  if (think.tone) {
    lines.push(`你打算用的语气：${think.tone}`);
  }
  if (think.lengthHint) {
    lines.push(`回复长度：${think.lengthHint}`);
  }
  if (think.wantToReply < 0.3) {
    // 低意愿不等于不回（attention 已经决定回了），但语气要淡一点
    lines.push('（其实你有点懒得展开，能一句说完就一句）');
  }
  return lines.join('\n');
}
