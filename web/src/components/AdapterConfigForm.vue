<script setup lang="ts">
/**
 * 按适配器清单渲染接入配置表单（D041）。
 *
 * 这个组件的存在就是为了兑现 D013 那句"新增平台不改前端"：
 * 字段、类型、默认值、必填条件**全部来自 `manifest.configFields`**，
 * 组件里没有一处 `if (platform === 'qq')`，也没有 `wsUrl` / `selfId` 这类平台字面量。
 *
 * 提交时不做翻译：值原样放进 `adapterConfig`，由主服务按同一张清单翻成实例列。
 * 前端只负责"按清单问用户"，翻译规则只有一份（在后端）。
 */
import { computed } from 'vue';

import { isFieldRequired } from '@/api/adapter-config';
import type { AdapterConfigField, AdapterConfigValues, AdapterManifest } from '@/api/types';

const props = defineProps<{
  manifest: AdapterManifest | null;
  /** 当前值。键是 `configFields[].key` */
  modelValue: AdapterConfigValues;
  /**
   * 已存在实例上"哪些敏感项已经配过"。只用来把 placeholder 换成"已配置，留空表示不修改"，
   * **绝不回显明文**（后端也不会给）。
   */
  knownSecrets?: Record<string, boolean>;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [AdapterConfigValues];
}>();

const fields = computed<AdapterConfigField[]>(() => props.manifest?.configFields ?? []);

/** 必填判定走共享实现：新建与设置两页必须同一条规则 */
function isRequired(field: AdapterConfigField): boolean {
  return isFieldRequired(field, props.modelValue);
}

function placeholderOf(field: AdapterConfigField): string {
  if (field.secret && props.knownSecrets?.[field.key]) {
    return '已配置，留空表示不修改';
  }
  return field.placeholder ?? '';
}

function valueOf(field: AdapterConfigField): string | number | boolean {
  const value = props.modelValue[field.key];
  if (value !== undefined) {
    return value;
  }
  // 没填过就用清单默认值渲染（不是写进 model：用户不动它就不该出现在补丁里）
  return field.default ?? '';
}

function update(field: AdapterConfigField, value: string | number | boolean | undefined): void {
  emit('update:modelValue', {
    ...props.modelValue,
    [field.key]: value === undefined ? '' : value,
  });
}
</script>

<template>
  <div class="adapter-config">
    <p v-if="fields.length === 0" class="empty-hint">这个适配器没有需要填的接入参数。</p>

    <el-form-item
      v-for="field in fields"
      :key="field.key"
      :label="field.label"
      :required="isRequired(field)"
    >
      <el-select
        v-if="field.type === 'select'"
        :model-value="valueOf(field)"
        :disabled="disabled"
        style="width: 100%"
        @update:model-value="(value: string | number | boolean) => update(field, value)"
      >
        <el-option
          v-for="option in field.options ?? []"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>

      <el-switch
        v-else-if="field.type === 'switch'"
        :model-value="Boolean(valueOf(field))"
        :disabled="disabled"
        @update:model-value="(value: string | number | boolean) => update(field, Boolean(value))"
      />

      <el-input-number
        v-else-if="field.type === 'number'"
        :model-value="Number(valueOf(field)) || 0"
        :disabled="disabled"
        style="width: 100%"
        @update:model-value="(value: number | undefined) => update(field, value)"
      />

      <el-input
        v-else-if="field.type === 'textarea'"
        :model-value="String(valueOf(field))"
        type="textarea"
        :rows="3"
        :disabled="disabled"
        :placeholder="placeholderOf(field)"
        @update:model-value="(value: string) => update(field, value)"
      />

      <el-input
        v-else
        :model-value="String(valueOf(field))"
        :type="field.secret ? 'password' : 'text'"
        :show-password="field.secret"
        :disabled="disabled"
        :placeholder="placeholderOf(field)"
        @update:model-value="(value: string) => update(field, value)"
      />

      <div v-if="field.help" class="hint">{{ field.help }}</div>
    </el-form-item>
  </div>
</template>

<style scoped>
.adapter-config {
  /* 太宽的表单反而不好填；这里限一个舒服的行宽 */
  max-width: 560px;
}

.empty-hint {
  color: var(--text-faint);
  font-size: 12px;
  margin: 0;
}
</style>
