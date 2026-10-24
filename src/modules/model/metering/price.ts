/**
 * 计价：token × 单价 → 分。
 *
 * 单价来自**当次使用的 credential 的 catalogJson**（D024）：
 * 同一个 `deepseek-chat`，官方 Key 与中转 Key 价格不同，用全局常量会让账单系统性偏差。
 *
 * 取不到价格时记 0 而不是抛错：账目不准可以事后补，聊天不能因为少了价格就中断。
 * 但会返回 `priced: false`，让调用方打一条 warn，避免"账单一直是 0 却没人发现"。
 */

export type CatalogEntry = {
  id: string;
  priceInPerM?: number;
  priceOutPerM?: number;
};

export type PriceResult = {
  costCents: number;
  priced: boolean;
  /** 单价（元/百万 token），用于排查 */
  unit: { inPerM: number; outPerM: number } | null;
};

const CENTS_PER_YUAN = 100;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export function parseCatalog(catalogJson: string | null | undefined): CatalogEntry[] {
  if (!catalogJson) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(catalogJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is CatalogEntry =>
        typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string',
    );
  } catch {
    // 目录坏了不该让调用失败，只是算不出钱
    return [];
  }
}

export function priceUsage(input: {
  catalogJson: string | null | undefined;
  model: string;
  tokenIn: number;
  tokenOut: number;
}): PriceResult {
  const entry = parseCatalog(input.catalogJson).find((item) => item.id === input.model);
  const inPerM = entry?.priceInPerM;
  const outPerM = entry?.priceOutPerM;

  if (typeof inPerM !== 'number' || typeof outPerM !== 'number') {
    return { costCents: 0, priced: false, unit: null };
  }

  const yuan =
    (input.tokenIn * inPerM + input.tokenOut * outPerM) / TOKENS_PER_PRICE_UNIT;
  // 向上取整：宁可多记 1 分，也不要因为四舍五入把大量小调用记成 0
  const costCents = Math.ceil(yuan * CENTS_PER_YUAN);
  return { costCents, priced: true, unit: { inPerM, outPerM } };
}
