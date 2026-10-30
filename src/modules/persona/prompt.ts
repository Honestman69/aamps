/**
 * Persona → system prompt 拼装（D020）。
 *
 * ## 组装顺序固定（D020）
 *
 * ```
 * 红线（只读）→ 出生设定（"你出生时…"）→ 现在的你（SelfState 自述）
 * → 对这个人的印象 → 情境 → 语气提示
 * ```
 *
 * M2 最小闭环只拼"种子层"：红线表与 SelfState 演化层都还没实现（D020 记了结构、
 * 实现留到 M4/M5），所以这里给它们留空占位，**不假装有数据**。
 *
 * ## 三条纪律
 *
 * 1. **种子用过去时叙述，不用命令句**。"你出生时…"会让模型延续人格；
 *    "你必须…"只会让模型背设定（D020）。
 * 2. **宽容解析**：Persona 的 JSON 字段坏了、为空、被手工改坏，一律跳过该段而不是抛错。
 *    人格数据坏了不能让机器人崩 —— 少一段设定比不说话好。
 * 3. **红线不在 Persona 里**：`boundariesJson` 是软禁区（可协商），红线是代码常量
 *    （`rules/red-lines.ts`，D051）。这里绝不把软禁区当红线用。
 */

import { buildRedLineSection } from '../rules/red-lines';

export type PersonaSeed = {
  name: string;
  tagline: string | null;
  identityJson: string;
  promptBlocksJson: string;
  examplesJson: string;
  boundariesJson: string;
};

export type PromptContext = {
  /** 对方的称呼（昵称）；空则不用 */
  peerName: string | null;
  /** 私聊还是群聊 */
  channel: 'private' | 'group';
  /** 机器人自己的名字 */
  selfName: string;
  /**
   * 对话能力（D033）：只把**这台机器真的能做**的事写进 prompt。
   * 没配 TTS 就不提语音 —— 模型不会去用一个它不知道不存在的通道，
   * 而"提了但发不出去"会表现为它说了"我发你语音"然后什么都没发。
   */
  capabilities?: {
    imageReply: boolean;
    voiceReply: boolean;
    /** 素材库里的别名（D034）：模型只能从这些名字里挑 */
    assets?: string[];
  } | null;
  /**
   * 瞬态状态（M3）：只影响"语气提示"，不参与人格设定。
   *
   * 为什么不写进种子：种子是"它出生时是什么人"，state 是"它此刻累不累"。
   * 混在一起会让模型把"你现在很困"当成性格的一部分，睡一觉就该变的东西被写死。
   */
  state?: { mood: number; energy: number } | null;
  /**
   * 记忆（M5-1）：关于这个人的稳定事实 + 这个会话最近的摘要。
   *
   * 只影响"对这个人的印象"那一段。**绝不写进出生设定**——那些是它出生就有的，
   * 记忆是它后来经历的；混在一起会让"后来知道的事"变成"一直如此"。
   */
  memory?: { facts: string[]; summaries: string[] } | null;
  /**
   * 演化层（M5-2）：它自己变成了什么样。
   *
   * `narrative` 是第一人称自述（反思写的），`lines` 是由特质数值翻译出来的几句
   * （只在明显偏离中间值时才有）。两者都为空 → 整段跳过，直接用种子。
   */
  self?: { narrative: string; lines: string[] } | null;
};

/** 拼装产物：system 消息 + few-shot 对话（examples 作为 user/assistant 成对塞进 messages 前） */
export type AssembledPrompt = {
  system: string;
  /** few-shot 示例，按序插入到历史之前 */
  examples: Array<{ role: 'user' | 'assistant'; content: string }>;
};

// ─────────────────────────── 字段解析（宽容） ───────────────────────────

type Identity = {
  name?: unknown;
  age?: unknown;
  gender?: unknown;
  role?: unknown;
  /** 背景故事，一段自由文本 */
  background?: unknown;
};

type PromptBlock = {
  key?: unknown;
  title?: unknown;
  content?: unknown;
  enabled?: unknown;
};

type Example = {
  user?: unknown;
  assistant?: unknown;
};

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJson<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed as T;
  } catch {
    return null;
  }
}

function asIdentity(raw: string): Identity | null {
  const parsed = parseJson<Identity>(raw);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  return parsed;
}

function asPromptBlocks(raw: string): PromptBlock[] {
  const parsed = parseJson<PromptBlock[]>(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed;
}

function asExamples(raw: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const parsed = parseJson<Example[]>(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (isString(item.user)) {
      result.push({ role: 'user', content: item.user as string });
    }
    if (isString(item.assistant)) {
      result.push({ role: 'assistant', content: item.assistant as string });
    }
  }
  return result;
}

// ─────────────────────────── 分段拼装 ───────────────────────────

/** 出生设定：identity 的离散字段 + 背景故事 */
function buildSeedSection(seed: PersonaSeed): string {
  const lines: string[] = [];
  const identity = asIdentity(seed.identityJson);

  if (identity) {
    const facts: string[] = [];
    if (isString(identity.name)) facts.push(`名字叫「${identity.name}」`);
    if (isString(identity.age)) facts.push(`${identity.age} 岁`);
    if (isString(identity.gender)) facts.push(`${identity.gender}`);
    if (isString(identity.role)) facts.push(`身份是${identity.role}`);
    if (facts.length > 0) {
      lines.push(`你出生时的设定：${facts.join('，')}。`);
    }
    if (isString(identity.background)) {
      lines.push(identity.background);
    }
  }

  // 一句话定位放在最前，它是最容易被模型记住的一句话
  if (isString(seed.tagline)) {
    lines.unshift(`你出生时的设定：${seed.tagline}`);
  }

  return lines.join('\n');
}

/** promptBlocks：用户自定义的追加指令块，只取 enabled 的，按顺序 */
function buildBlockSection(seed: PersonaSeed): string {
  const blocks = asPromptBlocks(seed.promptBlocksJson).filter(
    (block) => block.enabled !== false && isString(block.content),
  );
  if (blocks.length === 0) {
    return '';
  }
  return blocks.map((block) => block.content as string).join('\n');
}

/** 软禁区（可协商的雷区/拒绝话术风格），明确与红线区分 */
function buildBoundariesSection(seed: PersonaSeed): string {
  const raw = seed.boundariesJson;
  if (!raw || raw === '[]') {
    return '';
  }
  const parsed = parseJson<unknown>(raw);
  if (!parsed) {
    return '';
  }
  // 软禁区结构还没定死（M4 才有人设编辑器），这里只做一层兜底：
  // 数组就按字符串列表拼，对象就取通用字段，都没有就整段跳过。
  if (Array.isArray(parsed)) {
    const items = parsed.filter(isString);
    if (items.length === 0) {
      return '';
    }
    return `你不爱谈、会主动避开的话题：${items.join('；')}。`;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const avoid = (parsed as { avoid?: unknown }).avoid;
    if (Array.isArray(avoid)) {
      const items = avoid.filter(isString);
      if (items.length > 0) {
        return `你不爱谈、会主动避开的话题：${items.join('；')}。`;
      }
    }
  }
  return '';
}

// ─────────────────────────── 主入口 ───────────────────────────

/**
 * 语气提示（M3）：把瞬态状态翻译成一句"此刻的感觉"。
 *
 * 两条纪律：
 * 1. **只在偏离常态时说话**。精力 0.8 是默认值，每个 prompt 都写一句"你现在很精神"
 *    等于噪声，还会被模型当成设定去演。
 * 2. **说现象，不说指令**。写"回话会很短"而不是"请把回复控制在 20 字内"——后者是
 *    运维式指令，模型会照做，但语气会僵。
 */
/**
 * 媒体能力说明（D033）。
 *
 * 为什么用"独占一行的标记"而不是让它自然语言描述：
 * 自然语言（"我发你一张图"）无法被执行，只会变成一句空话。
 * 标记必须独占一行，是为了让正文里顺手提到 `[img]` 时不被误判成指令。
 */
function buildMediaSection(capabilities: PromptContext['capabilities']): string {
  if (!capabilities || (!capabilities.imageReply && !capabilities.voiceReply)) {
    return '';
  }
  const assets = capabilities.assets ?? [];
  const lines = ['你手上的聊天工具还支持这些，规则要严格遵守：'];
  if (capabilities.imageReply) {
    lines.push(
      '- 想把一张图片发给对方时，单独写一行：[img]图片链接[/img]。链接必须是你真的确定存在的公开 https 图片地址；拿不准就别发。',
    );
  }
  // 没存过任何素材时**不提** [use]：否则模型会编一个名字，然后发不出去
  if (capabilities.imageReply && assets.length > 0) {
    lines.push(
      `- 你手边存着这些图，想发其中一张就单独写一行：[use]名字[/use]。现在有：${assets.join('、')}。只能用这些名字，不要编。`,
    );
  }
  if (capabilities.imageReply) {
    lines.push(
      '- 对方发了图你想留着以后用，就单独写一行：[save]给它起的名字[/save]（两到六个字，好记、别和已有的重名）。',
    );
  }
  if (capabilities.voiceReply) {
    lines.push(
      '- 想用语音说一句时，单独写一行：[voice]要说的话[/voice]。语音适合短句和带情绪的回应，不适合念长段。',
    );
  }
  lines.push(
    '这些标记不要解释、不要和别的字写在同一行；大部分时候还是正常打字，用多了很假。',
  );
  return lines.join('\n');
}

function buildToneSection(state: PromptContext['state']): string {
  if (!state) {
    return '';
  }
  const lines: string[] = [];
  if (state.energy < 0.3) {
    lines.push('你现在很困，回话会很短，也懒得展开。');
  } else if (state.energy < 0.55) {
    lines.push('你有点累了，说话比平时简短。');
  }
  if (state.mood <= -0.25) {
    lines.push('你现在的情绪不太好，语气比平时冲一些。');
  } else if (state.mood >= 0.25) {
    lines.push('你现在心情不错，语气松一些。');
  }
  return lines.join('');
}

/**
 * 记忆段（M5-1 / D045）：**说"我记得"，不说"以下是记忆条目"**。
 *
 * 三条纪律：
 * 1. **不加编号、不加时间**。写成 `- [3] 他养了只猫（2026-10-20）` 会让模型开始
 *    在回复里引用条目（"我记得你上次说过…"），那是最像机器人腔的句式。
 * 2. **必须有一句"不用复述"**。否则模型会把"你还记得"当成任务，每轮都汇报一遍。
 * 3. **空就整段跳过**。没有记忆时留一行"你还记得："比不写更糟 ——
 *    那会提示它"这里本该有东西"，然后开始编。
 */
function buildMemorySection(memory: PromptContext['memory']): string {
  const facts = (memory?.facts ?? []).map((item) => item.trim()).filter(Boolean);
  const summaries = (memory?.summaries ?? []).map((item) => item.trim()).filter(Boolean);
  if (facts.length === 0 && summaries.length === 0) {
    return '';
  }

  const lines: string[] = [];
  if (facts.length > 0) {
    lines.push('关于这个人，你知道这些：');
    lines.push(...facts.map((item) => `- ${item}`));
  }
  if (summaries.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('你们之前聊过（按时间先后）：');
    lines.push(...summaries.map((item) => `- ${item}`));
  }
  lines.push('这些都是以前真的发生过的。不用复述，也别一条条汇报；需要的时候自然带出来。');
  return lines.join('\n');
}

/**
 * 演化层（M5-2 / D020 第 4 条）：现在的你。
 *
 * 夹在"出生设定"与"对这个人的印象"之间，顺序不能挪：
 * 种子说"你出生时是谁"，这一段说"后来你变成了什么样"，记忆说"你认识了谁"。
 * 把演化放到种子前面，模型会把它当成出厂设定，反而更像在演人设。
 *
 * 空就整段跳过 —— 没演化过的人不该有一段"现在的你：（空）"。
 */
function buildSelfSection(self: PromptContext['self']): string {
  if (!self) {
    return '';
  }
  const narrative = (self.narrative ?? '').trim();
  const lines = (self.lines ?? []).map((line) => line.trim()).filter(Boolean);
  if (!narrative && lines.length === 0) {
    return '';
  }
  const parts: string[] = [];
  if (narrative) {
    parts.push(narrative);
  }
  parts.push(...lines);
  return parts.join('\n');
}

/**
 * 拼装 system prompt。
 *
 * 返回值里的 `examples` 是 few-shot，调用方要把它**插到对话历史之前**，
 * 而不是塞进 system —— 塞进 system 会让模型把示例当成"设定"去复读。
 */
export function assemblePrompt(seed: PersonaSeed, context: PromptContext): AssembledPrompt {
  const sections: string[] = [];

  // ① 红线（只读，D051）：代码常量，永远在最前。它是设定的**边界**，不是设定的一部分
  sections.push(buildRedLineSection());
  sections.push('你是一个有自己性格的人，不是客服，也不是搜索引擎。');

  // ② 出生设定（种子）
  const seedSection = buildSeedSection(seed);
  if (seedSection) {
    sections.push(seedSection);
  }

  // ③ 现在的你（SelfState 自述，M5-2）：没演化过就跳过
  const selfSection = buildSelfSection(context.self);
  if (selfSection) {
    sections.push(selfSection);
  }

  // ④ 对这个人的印象：先"对方是谁"，再"你记得他什么"（D045）
  if (context.peerName) {
    sections.push(`正在和你说话的人：${context.peerName}。`);
  }
  const memorySection = buildMemorySection(context.memory);
  if (memorySection) {
    sections.push(memorySection);
  }

  // ⑤ 情境
  sections.push(
    context.channel === 'group'
      ? '你现在在群聊里，会有多个人同时说话。回复要自然、简短，像普通人在群里聊天。'
      : '这是私聊，对方在单独和你说话。',
  );

  // ⑥ 追加指令块（promptBlocks）
  const blockSection = buildBlockSection(seed);
  if (blockSection) {
    sections.push(blockSection);
  }

  // ⑦ 软禁区（不是红线）
  const boundaries = buildBoundariesSection(seed);
  if (boundaries) {
    sections.push(boundaries);
  }

  // ⑧ 媒体能力（D033）：只列真的可用的通道
  const media = buildMediaSection(context.capabilities);
  if (media) {
    sections.push(media);
  }

  // ⑨ 语气提示（D020 顺序的最后一段）：此刻累不累、心情如何
  const tone = buildToneSection(context.state);
  if (tone) {
    sections.push(tone);
  }

  return {
    system: sections.filter(Boolean).join('\n\n'),
    examples: asExamples(seed.examplesJson),
  };
}
