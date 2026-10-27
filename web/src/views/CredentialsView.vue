<script setup lang="ts">
/**
 * 密钥管理。
 *
 * 界面层面只暴露三件事：**哪家厂商、叫什么名字、明文 key（只写一次）**。
 * `apiKeyEnc` 永远不会出现在任何响应里（DTO 编译期就没有这个字段），
 * 所以这里也没有"查看"按钮 —— 不是没做，是做不到。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { api, errorText } from '@/api/client';
import type { Credential } from '@/api/types';

const loading = ref(false);
const items = ref<Credential[]>([]);
const busyId = ref<string | null>(null);

const dialogOpen = ref(false);
const saving = ref(false);
const form = reactive({
  provider: 'deepseek',
  label: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
});

const rotateOpen = ref(false);
const rotating = ref(false);
const rotateTarget = ref<Credential | null>(null);
const rotateKey = ref('');

const PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI / 兼容' },
  { value: 'dashscope', label: '通义（DashScope）' },
  { value: 'zhipu', label: '智谱 GLM' },
  { value: 'moonshot', label: 'Moonshot' },
  { value: 'siliconflow', label: '硅基流动' },
  { value: 'custom', label: '其它（自填 baseUrl）' },
];

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await api.credentials.list();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(): void {
  form.provider = 'deepseek';
  form.label = '';
  form.baseUrl = '';
  form.apiKey = '';
  form.defaultModel = '';
  dialogOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (!form.label.trim()) {
    ElMessage.warning('给它起个名字，方便实例里认出来');
    return;
  }
  if (form.apiKey.trim().length < 8) {
    ElMessage.warning('API Key 太短了');
    return;
  }
  saving.value = true;
  try {
    await api.credentials.create({
      provider: form.provider.trim(),
      label: form.label.trim(),
      apiKey: form.apiKey.trim(),
      ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(form.defaultModel.trim() ? { defaultModel: form.defaultModel.trim() } : {}),
    });
    dialogOpen.value = false;
    form.apiKey = '';
    ElMessage.success('已保存');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: Credential, value: boolean): Promise<void> {
  busyId.value = row.id;
  try {
    await api.credentials.update(row.id, { enabled: value });
    row.enabled = value;
  } catch (err) {
    ElMessage.error(errorText(err));
    await load();
  } finally {
    busyId.value = null;
  }
}

function openRotate(row: Credential): void {
  rotateTarget.value = row;
  rotateKey.value = '';
  rotateOpen.value = true;
}

async function submitRotate(): Promise<void> {
  const target = rotateTarget.value;
  if (!target) {
    return;
  }
  if (rotateKey.value.trim().length < 8) {
    ElMessage.warning('API Key 太短了');
    return;
  }
  rotating.value = true;
  try {
    await api.credentials.update(target.id, { apiKey: rotateKey.value.trim() });
    rotateOpen.value = false;
    rotateKey.value = '';
    ElMessage.success('已轮换');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    rotating.value = false;
  }
}

async function remove(row: Credential): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${row.label}」后，绑定它的实例会立刻失去模型能力。密钥本身无法找回，需要重新录入。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busyId.value = row.id;
  try {
    await api.credentials.remove(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

function healthText(row: Credential): { text: string; type: 'success' | 'warning' | 'danger' | 'info' } {
  if (!row.enabled) {
    return { text: '已停用', type: 'info' };
  }
  if (!row.health.available) {
    return { text: row.health.reason ?? '暂时不可用', type: 'danger' };
  }
  if (row.lastCheckOk === false) {
    return { text: '上次调用失败', type: 'warning' };
  }
  return { text: '可用', type: 'success' };
}

function money(cents: number | null, currency: string | null): string {
  if (cents === null) {
    return '未查询';
  }
  const symbol = currency === 'USD' ? '$' : '¥';
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">密钥</h1>
        <p class="page-desc">
          明文只用你的密码加密，服务端只保存密文；界面上永远只显示掩码。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">添加密钥</el-button>
    </header>

    <div class="card">
      <el-table v-loading="loading" :data="items" style="width: 100%">
        <el-table-column label="名称" min-width="180">
          <template #default="{ row }">
            <div class="cell-title">{{ row.label }}</div>
            <div class="cell-sub mono">{{ row.keyMasked }}</div>
          </template>
        </el-table-column>

        <el-table-column label="厂商 / 地址" min-width="220">
          <template #default="{ row }">
            <div class="cell-title">{{ row.provider }}</div>
            <div class="cell-sub mono">{{ row.baseUrl ?? '厂商默认' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="余额" width="120">
          <template #default="{ row }">
            <span class="mono">{{ money(row.balance.cents, row.balance.currency) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="healthText(row).type" size="small">{{ healthText(row).text }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              :loading="busyId === row.id"
              @update:model-value="(value: string | number | boolean) => toggleEnabled(row, Boolean(value))"
            />
          </template>
        </el-table-column>

        <el-table-column label="操作" width="160" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openRotate(row)">轮换</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty">还没有密钥。添加一把之后，实例里才能选到它。</div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogOpen" title="添加密钥" width="480px" :close-on-click-modal="false">
      <el-form label-position="top">
        <div class="grid-2">
          <el-form-item label="厂商">
            <el-select v-model="form.provider" style="width: 100%" filterable allow-create>
              <el-option v-for="item in PROVIDERS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="名称">
            <el-input v-model="form.label" placeholder="例如：DeepSeek 主号" />
          </el-form-item>
          <el-form-item label="Base URL（可留空）" class="span-2">
            <el-input v-model="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
          </el-form-item>
          <el-form-item label="默认模型（可留空）" class="span-2">
            <el-input v-model="form.defaultModel" placeholder="deepseek-chat" />
          </el-form-item>
          <el-form-item label="API Key" class="span-2">
            <el-input v-model="form.apiKey" type="password" show-password placeholder="sk-..." />
            <div class="hint">保存后只显示掩码，无法再查看原文。</div>
          </el-form-item>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rotateOpen" title="轮换 API Key" width="440px" :close-on-click-modal="false">
      <p class="rotate-desc">
        「{{ rotateTarget?.label }}」当前是 <span class="mono">{{ rotateTarget?.keyMasked }}</span>。
        填入新 key 后立刻生效，旧 key 不会被保留。
      </p>
      <el-input v-model="rotateKey" type="password" show-password placeholder="新的 API Key" />

      <template #footer>
        <el-button @click="rotateOpen = false">取消</el-button>
        <el-button type="primary" :loading="rotating" @click="submitRotate">轮换</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.cell-title {
  font-weight: 600;
}

.cell-sub {
  color: var(--text-muted);
  font-size: 11.5px;
  margin-top: 2px;
  word-break: break-all;
}

.rotate-desc {
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
