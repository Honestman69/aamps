/**
 * 适配器配置 ↔ 实例列的翻译层（D041）。
 *
 * 背景：适配器声明的是"这个平台要问用户什么"（`selfId` / `wsUrl` / `mode`），
 * 而实例表存的是"接入层真正会读的四个槽位"（`accountId` / `endpoint` / `adapterMode` / `accessToken`）。
 * 这两套名字之间的映射必须由**适配器自己**给（`ConfigField.mapsTo`），
 * 因为只有它知道 `selfId` 就是账号。
 *
 * 三个职责，各自很薄：
 *   1. `assertAdapterManifest`：注册时校验清单自洽（缺槽位 / 抢槽位 / 选项与槽位语义不符）
 *   2. `translateAdapterConfig`：把前端回传的 `adapterConfig` 校验并翻译成实例字段
 *   3. `requiredFieldKeys`：算出"按当前值，哪些字段是必填的"（供翻译与前端同一条规则）
 *
 * **平台知识一行都没有**：这里只认 `mapsTo` 与 `ConfigField.type`，
 * 加一个平台不需要改这个文件。
 */

import {
  BadRequestError,
  type AdapterManifest,
  type ConfigField,
  type InstanceSlot,
} from '@newjob/contracts';

/** 实例上允许被适配器配置写入的槽位。与 `InstanceSlot` 保持一一对应 */
export const INSTANCE_SLOTS: readonly InstanceSlot[] = [
  'accountId',
  'adapterMode',
  'endpoint',
  'accessToken',
];

/**
 * `adapterMode` 的合法取值（实例表的语义：谁连谁）。
 *
 * 校验它不是因为不信任适配器，而是因为错在这里的表现极难排查：
 * 写了 `'reverse'` 之类的值，zod 会在创建时报一句和「接入方向」毫不相干的错误。
 */
const ADAPTER_MODE_VALUES = ['client', 'server'] as const;

/** 翻译结果：只含被实际提供的槽位，未提供的键不出现 */
export type TranslatedAdapterConfig = Partial<Record<InstanceSlot, string>>;

/**
 * 校验清单自洽。**在 `AdapterRegistry.register` 里调用**：不合规的适配器启动即拒绝，
 * 而不是等用户点"创建"才看到一句莫名其妙的报错。
 *
 * 抛 `Error` 而不是 `BadRequestError`：这是开发者错误（适配器包写错了），
 * 不是用户输入错误，不该以 400 的形式返回给浏览器。
 */
export function assertAdapterManifest(manifest: AdapterManifest): void {
  const where = `适配器 ${manifest.platform}:${manifest.protocol}`;
  const seenKeys = new Set<string>();
  const seenSlots = new Map<string, string>();

  for (const field of manifest.configFields) {
    const at = `${where} 的配置项「${field.key}」`;

    if (!field.key.trim()) {
      throw new Error(`${where} 有配置项的 key 为空`);
    }
    if (seenKeys.has(field.key)) {
      throw new Error(`${where} 有重复的配置项 key：「${field.key}」`);
    }
    seenKeys.add(field.key);

    if (!field.mapsTo) {
      throw new Error(
        `${at} 缺少 mapsTo：没有地方存的字段不该出现在表单里（否则用户填了也没用）`,
      );
    }
    if (!INSTANCE_SLOTS.includes(field.mapsTo)) {
      throw new Error(`${at} 的 mapsTo「${field.mapsTo}」不是合法槽位`);
    }
    const occupied = seenSlots.get(field.mapsTo);
    if (occupied) {
      throw new Error(
        `${where} 的「${occupied}」与「${field.key}」都映射到 ${field.mapsTo}：一个槽位只能有一个来源`,
      );
    }
    seenSlots.set(field.mapsTo, field.key);

    if (field.secret && field.type !== 'password') {
      throw new Error(`${at} 标了 secret，但 type 不是 password —— 前端会把它明文显示在输入框里`);
    }
    if (field.type === 'select') {
      if (!field.options || field.options.length === 0) {
        throw new Error(`${at} 是 select，但没有 options`);
      }
      if (field.default !== undefined && !field.options.some((o) => o.value === field.default)) {
        throw new Error(`${at} 的默认值「${String(field.default)}」不在 options 里`);
      }
      if (field.mapsTo === 'adapterMode') {
        const values = field.options.map((option) => option.value);
        const illegal = values.filter(
          (value) => !(ADAPTER_MODE_VALUES as readonly string[]).includes(value),
        );
        if (illegal.length > 0) {
          throw new Error(
            `${at} 映射到 adapterMode，但选项里有非法值 ${illegal.join('、')}` +
              `（实例表只认 ${ADAPTER_MODE_VALUES.join(' / ')}）`,
          );
        }
      }
    }
  }

  // requiredWhen 引用的字段必须存在，否则那条"条件必填"永远不会触发 —— 静默失效最坏
  for (const field of manifest.configFields) {
    const condition = field.requiredWhen;
    if (!condition) {
      continue;
    }
    if (!condition.in.length) {
      throw new Error(`${where} 的「${field.key}」requiredWhen.in 为空`);
    }
    if (!seenKeys.has(condition.field)) {
      throw new Error(
        `${where} 的「${field.key}」requiredWhen 指向不存在的字段「${condition.field}」`,
      );
    }
  }

  // 账号是所有接入动作的锚点：缺了它，连接时不知道该用哪个号发消息
  if (!seenSlots.has('accountId')) {
    throw new Error(`${where} 没有任何配置项映射到 accountId —— 实例必须有账号标识`);
  }
}

/** 某个字段在当前取值下是否必填（`required` 或命中的 `requiredWhen`） */
export function isFieldRequired(
  field: ConfigField,
  values: Record<string, unknown>,
): boolean {
  if (field.required) {
    return true;
  }
  const condition = field.requiredWhen;
  if (!condition) {
    return false;
  }
  // 同一个值在表单里可能是字符串也可能是数字（select/text 都是 string），统一按字符串比
  const actual = values[condition.field];
  return condition.in.some((expected) => String(expected) === String(actual ?? ''));
}

/** 按当前值算出的必填字段（前端用它画星号，后端用它校验，规则只有一份） */
export function requiredFieldKeys(
  manifest: AdapterManifest,
  values: Record<string, unknown>,
): string[] {
  return manifest.configFields
    .filter((field) => isFieldRequired(field, values))
    .map((field) => field.key);
}

/** 空值的统一判定：undefined / null / 空串 / 纯空白都算"没填" */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * 按字段类型把原始值规整成字符串（实例列全是字符串）。
 *
 * 只做"能不能变成合理值"，不做业务校验：地址合法性由 `endpoint-guard` 管，
 * 账号长度由实例 DTO 管 —— 翻译层不做第二份业务规则。
 */
function normalizeValue(field: ConfigField, raw: unknown): string {
  switch (field.type) {
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) {
        throw new BadRequestError(`「${field.label}」需要填数字`);
      }
      return String(num);
    }
    case 'switch': {
      if (typeof raw === 'boolean') {
        return String(raw);
      }
      if (raw === 'true' || raw === 'false') {
        return raw;
      }
      throw new BadRequestError(`「${field.label}」只能是开关值`);
    }
    case 'select': {
      const text = String(raw).trim();
      if (!field.options?.some((option) => option.value === text)) {
        const allowed = (field.options ?? []).map((option) => option.value).join(' / ');
        throw new BadRequestError(`「${field.label}」只能是 ${allowed}`);
      }
      return text;
    }
    default: {
      if (typeof raw === 'object') {
        throw new BadRequestError(`「${field.label}」需要填文本`);
      }
      return String(raw).trim();
    }
  }
}

/**
 * 把 `adapterConfig` 翻译成实例字段。
 *
 * `partial` 决定"没传的字段"是什么意思：
 *   - `false`（创建）：没传就是没填，必填字段缺失 → 400
 *   - `true`（更新）：没传就是不改；但**传了空值的必填字段仍然 400**
 *     （不允许把必填项改空，那会让实例处于"存着但连不上"的状态）
 *
 * 未知键直接拒绝：说明前端拿着旧清单或拼错了字段名，静默忽略就是"填了没生效"。
 */
export function translateAdapterConfig(input: {
  manifest: AdapterManifest;
  values: Record<string, unknown>;
  partial?: boolean;
}): TranslatedAdapterConfig {
  const { manifest, values, partial = false } = input;
  const known = new Set(manifest.configFields.map((field) => field.key));

  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw new BadRequestError(`接入配置里有未知字段「${key}」`);
    }
  }

  const translated: TranslatedAdapterConfig = {};
  for (const field of manifest.configFields) {
    const slot = field.mapsTo as InstanceSlot;
    const raw = values[field.key];

    if (raw === undefined && partial) {
      continue;
    }

    if (isBlank(raw)) {
      if (isFieldRequired(field, values)) {
        throw new BadRequestError(`「${field.label}」必填`);
      }
      continue;
    }

    translated[slot] = normalizeValue(field, raw);
  }

  return translated;
}
