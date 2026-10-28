/**
 * 人格特质的维度定义（M5-2 / D020 第三层）。
 *
 * **四个维度，不多不少**：每个维度都必须能被"用起来"（写进 prompt、能被闸门约束、
 * 出事时能解释）。加一个没人读的维度，只会让自述与数值各说各话。
 *
 * 数值含义统一：0~1，0.5 是中间态。**不要在别处另立刻度**（有的地方 0-100、
 * 有的地方 -1~1）—— 换算点越多，越容易在某个环节把"温和"和"刻薄"弄反。
 */

export const TRAITS = ['warm', 'edge', 'playful', 'talkative'] as const;

export type TraitKey = (typeof TRAITS)[number];

export type Traits = Record<TraitKey, number>;

/**
 * 出生时的中性值。
 *
 * 不从 `Persona` 推导：种子说的是"你是什么人"（文字），特质说的是"演化到哪一步"
 * （数值）。让种子给初值等于一开始就有一份"凭空的演化"，
 * 而自述还是空的 —— 数值与自述对不上，后面谁也说不清该信哪个。
 */
export const DEFAULT_TRAITS: Traits = {
  warm: 0.5,
  edge: 0.5,
  playful: 0.5,
  talkative: 0.5,
};

/** 中文名，只用于日志与界面；数据库存英文键 */
export const TRAIT_LABELS: Record<TraitKey, string> = {
  warm: '热络',
  edge: '棱角',
  playful: '俏皮',
  talkative: '话多',
};
