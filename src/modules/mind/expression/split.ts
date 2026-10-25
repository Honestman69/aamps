/**
 * 拆条：把一段回复切成"人会在聊天框里发出来的"几条（ARCHITECTURE 6.4）。
 *
 * ## 为什么要拆
 *
 * 一段 200 字连成一条，是最明显的机器人特征之一。真人会拆成两三句、分几次发。
 * 但拆得太碎也假（一句一条像刷屏），所以上限是 3 条，且**不是每次都拆**（`splitChance`）。
 *
 * ## 一条铁律：绝不截断
 *
 * `maxCharsPerSegment` 只是"尽量不超过"，不是"超出就切掉"。模型写了 300 字，
 * 宁可让最后一条长一点，也不能让用户少看到内容——**丢内容是 bug，超长只是不够像人**。
 * 同理 `maxSegments` 用"把剩下的并进最后一条"来实现，而不是丢弃。
 *
 * ## 切点优先级
 *
 * 换行 → 句末标点（。！？!?…；;）→ 逗号（，,）→ 硬切。
 * 前两级是自然停顿；逗号级只在单句超长时用；硬切是最后手段（英文长串、没有标点的刷屏文本）。
 */

export type SplitPolicy = {
  /** 单条目标字数 */
  maxCharsPerSegment: number;
  /** 最多几条 */
  maxSegments: number;
  /** 拆条概率：0 = 永远整段发，1 = 能拆就拆 */
  splitChance: number;
};

export const DEFAULT_SPLIT_POLICY: SplitPolicy = {
  maxCharsPerSegment: 40,
  maxSegments: 3,
  splitChance: 0.7,
};

/** 句末标点：切完保留在句子上（中文句号不吞掉） */
const SENTENCE_END = /([。！？!?…；;]+|\.(?=\s|$))/;
const SOFT_BREAK = /([，,、]+)/g;

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

/** 按正则切句，切点保留在前一段 */
function splitBy(text: string, pattern: RegExp): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match || match.index === undefined) {
      break;
    }
    const end = match.index + match[0].length;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
}

/** 单句超长时的硬切：优先在逗号处断，实在没有就按字切 */
function hardCut(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const soft = [...window.matchAll(SOFT_BREAK)];
    const last = soft[soft.length - 1];
    const cutAt = last?.index !== undefined ? last.index + last[0].length : limit;
    out.push(rest.slice(0, cutAt));
    rest = rest.slice(cutAt);
  }
  if (rest) {
    out.push(rest);
  }
  return out;
}

/**
 * 打包：按顺序把"句子"塞进不超过 `limit` 的分段里。
 *
 * 换行被当作强制分段点（用户自己分段的意图要尊重）。
 */
function pack(text: string, limit: number): string[] {
  const segments: string[] = [];
  let current = '';

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = '';
  };

  for (const line of text.split('\n')) {
    const sentences = splitBy(line, SENTENCE_END);
    for (const sentence of sentences) {
      for (const piece of hardCut(sentence, limit)) {
        if (!current) {
          current = piece;
        } else if (current.length + piece.length <= limit) {
          current += piece;
        } else {
          flush();
          current = piece;
        }
      }
    }
    // 换行 = 强烈停顿：这一行说完了就断一次（下一行另起一条）
    flush();
  }
  flush();
  return segments;
}

/**
 * 拆条主入口。
 *
 * @param rand 注入随机源（测试里给固定值）；默认 0.5 表示"按概率折半时不会拆"
 */
export function splitMessage(
  text: string,
  policy: SplitPolicy = DEFAULT_SPLIT_POLICY,
  rand: () => number = () => 0,
): string[] {
  const normalized = normalize(text);
  if (!normalized) {
    return [];
  }

  const hasNewline = normalized.includes('\n');
  // 太短的回复没有拆的必要：一句"嗯"拆成两条就更假了。
  // 但**用户自己换的行**要尊重——那是明确的停顿意图，不受长度影响。
  if (!hasNewline && normalized.length <= policy.maxCharsPerSegment * 0.6) {
    return [normalized];
  }
  if (rand() >= policy.splitChance) {
    return [normalized];
  }

  const packed = pack(normalized, Math.max(5, policy.maxCharsPerSegment));
  if (packed.length <= 1) {
    return packed.length === 1 ? packed : [normalized];
  }

  const maxSegments = Math.max(1, policy.maxSegments);
  if (packed.length <= maxSegments) {
    return packed;
  }

  // 超出条数：把多出来的并进最后一条，**不丢内容**
  const kept = packed.slice(0, maxSegments - 1);
  const tail = packed.slice(maxSegments - 1).join('');
  return [...kept, tail];
}
