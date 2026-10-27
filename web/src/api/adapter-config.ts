/**
 * 适配器配置的前端侧小工具（D041）。
 *
 * 为什么单独成文件：新增实例与实例设置两个页面都要
 * "按清单判必填 / 取默认值 / 从实例反查当前值 / 算增量"，写在页面里就是两份，
 * 而这两份一旦不一致，表现是"新建能过、保存过不了"这种最难解释的故障。
 *
 * 这里**没有平台知识**：所有判断都读 `manifest.configFields`。
 * 真正的权威校验在后端（`adapter/manifest-config.ts`），这里只为了把错误早点说清楚。
 */

import type {
  AdapterConfigField,
  AdapterConfigValues,
  AdapterManifest,
  Instance,
} from './types';

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/** 与后端 `isFieldRequired` 同一规则：`required` 或命中的 `requiredWhen` */
export function isFieldRequired(
  field: AdapterConfigField,
  values: AdapterConfigValues,
): boolean {
  if (field.required) {
    return true;
  }
  const condition = field.requiredWhen;
  if (!condition) {
    return false;
  }
  const actual = values[condition.field];
  return condition.in.some((expected) => String(expected) === String(actual ?? ''));
}

/** 清单默认值（敏感字段不预填）：新建表单打开时用它初始化 */
export function defaultValues(manifest: AdapterManifest | null): AdapterConfigValues {
  const values: AdapterConfigValues = {};
  for (const field of manifest?.configFields ?? []) {
    if (field.secret) {
      continue;
    }
    if (field.default !== undefined) {
      values[field.key] = field.default;
    }
  }
  return values;
}

/** 还缺哪些必填项（返回字段本身，好按 `label` 报错、按 `key` 定位） */
export function missingRequiredFields(
  manifest: AdapterManifest | null,
  values: AdapterConfigValues,
): AdapterConfigField[] {
  if (!manifest) {
    return [];
  }
  return manifest.configFields.filter(
    (field) => isFieldRequired(field, values) && isBlank(values[field.key]),
  );
}

/**
 * 从已存在的实例反查每个字段的当前值。
 *
 * 反查靠 `mapsTo`（槽位名），不靠字段名 —— 这也是"加平台不改前端"的一部分：
 * 换个平台叫 `selfId` 还是 `botId` 都无所谓，只要它映射到 `accountId`。
 *
 * 敏感字段永远返回空串：后端不回显明文，界面靠 placeholder 提示"已配置"。
 */
export function valuesFromInstance(
  manifest: AdapterManifest | null,
  instance: Instance,
): AdapterConfigValues {
  const values: AdapterConfigValues = {};
  for (const field of manifest?.configFields ?? []) {
    if (field.secret) {
      continue;
    }
    switch (field.mapsTo) {
      case 'accountId':
        values[field.key] = instance.accountId;
        break;
      case 'adapterMode':
        values[field.key] = instance.adapterMode;
        break;
      case 'endpoint':
        values[field.key] = instance.endpoint ?? '';
        break;
      default:
        break;
    }
  }
  return values;
}

/** 哪些敏感字段已经配过（只用于 placeholder 提示） */
export function knownSecrets(
  manifest: AdapterManifest | null,
  instance: Instance,
): Record<string, boolean> {
  const known: Record<string, boolean> = {};
  for (const field of manifest?.configFields ?? []) {
    if (field.secret && field.mapsTo === 'accessToken') {
      known[field.key] = instance.hasAccessToken;
    }
  }
  return known;
}

/**
 * 相对快照算增量：只返回**真的变了**的键。
 *
 * 为什么必须算增量而不是整份提交：后端会把"提供了的键"写进实例，
 * 而接入参数的写入会触发重连 —— 每次保存都整份提交，等于改个温度也掉一次线。
 */
export function changedValues(
  manifest: AdapterManifest | null,
  before: AdapterConfigValues,
  after: AdapterConfigValues,
): AdapterConfigValues {
  const changed: AdapterConfigValues = {};
  for (const field of manifest?.configFields ?? []) {
    const previous = String(before[field.key] ?? '').trim();
    const next = String(after[field.key] ?? '').trim();
    if (previous !== next) {
      changed[field.key] = next;
    }
  }
  return changed;
}
