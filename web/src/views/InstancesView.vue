<script setup lang="ts">
/**
 * 实例列表。
 *
 * 一个 QQ 号 = 一条实例（D007）：想换号就新建一条、把旧的停掉，
 * 代码里没有任何写死的账号或地址，所以这个页面是"接入新平台账号"的唯一入口。
 *
 * 关于"新建"表单：字段**全部来自 `manifest.configFields`**（D041）。
 * 这个页面不认识任何平台字段 —— 换成抖音适配器时这里一行都不用改，
 * 只要它的清单声明了字段与 `mapsTo`，表单就自动长出来。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { defaultValues, missingRequiredFields } from '@/api/adapter-config';
import { api, errorText } from '@/api/client';
import type { AdapterConfigValues, AdapterManifest, Instance } from '@/api/types';
import AdapterConfigForm from '@/components/AdapterConfigForm.vue';

const router = useRouter();

const loading = ref(false);
const instances = ref<Instance[]>([]);
const adapters = ref<AdapterManifest[]>([]);
const busyId = ref<string | null>(null);

const dialogOpen = ref(false);
const creating = ref(false);
const form = reactive({
  name: '',
  adapterType: 'onebot',
  adapterConfig: {} as AdapterConfigValues,
  enabled: true,
});

const selectedAdapter = computed(
  () => adapters.value.find((item) => item.protocol === form.adapterType) ?? null,
);

/**
 * 换接入方式时把表单重置成新清单的默认值。
 *
 * 必须重置而不是"尽量保留"：两个平台的字段名毫不相干（`wsUrl` 与 `roomId`），
 * 保留只会把 A 平台的值带进 B 平台的字段里，用户还看不出来。
 */
function onAdapterChange(protocol: string): void {
  form.adapterType = protocol;
  const adapter = adapters.value.find((item) => item.protocol === protocol) ?? null;
  form.adapterConfig = defaultValues(adapter);
}

const capabilityText = computed(() => {
  const caps = selectedAdapter.value?.capabilities;
  if (!caps) {
    return null;
  }
  const kinds = caps.sessionKinds.map((kind) => (kind === 'group' ? '群聊' : '私聊')).join(' / ');
  const media = [
    caps.media.image ? '图片' : null,
    caps.media.voice ? '语音' : null,
    caps.media.quote ? '引用' : null,
  ].filter(Boolean);
  return `${kinds} · 单条 ≤ ${caps.maxTextLength} 字${media.length > 0 ? ` · 支持 ${media.join('、')}` : ''}`;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, manifests] = await Promise.all([api.instances.list(), api.adapters.list()]);
    instances.value = list;
    adapters.value = manifests;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(): void {
  form.name = '';
  form.enabled = true;
  const first = adapters.value[0];
  form.adapterType = first?.protocol ?? 'onebot';
  form.adapterConfig = defaultValues(first ?? null);
  dialogOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('实例名不能为空');
    return;
  }
  const adapter = selectedAdapter.value;
  if (!adapter) {
    ElMessage.warning('请选择接入方式');
    return;
  }
  // 前端先拦一次，只是为了把"哪一项没填"说清楚；真正的校验在后端（同一份清单）
  const missing = missingRequiredFields(adapter, form.adapterConfig);
  if (missing.length > 0) {
    ElMessage.warning(`还差：${missing.map((field) => field.label).join('、')}`);
    return;
  }
  creating.value = true;
  try {
    await api.instances.create({
      name: form.name.trim(),
      platform: adapter.platform,
      adapterType: form.adapterType,
      adapterConfig: form.adapterConfig,
      enabled: form.enabled,
    });
    dialogOpen.value = false;
    ElMessage.success('已创建');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    creating.value = false;
  }
}

async function toggleEnabled(row: Instance, value: boolean): Promise<void> {
  busyId.value = row.id;
  try {
    await api.instances.update(row.id, { enabled: value });
    row.enabled = value;
  } catch (err) {
    ElMessage.error(errorText(err));
    await load();
  } finally {
    busyId.value = null;
  }
}

async function connect(row: Instance): Promise<void> {
  busyId.value = row.id;
  try {
    const result = await api.instances.connect(row.id);
    if (result.ok) {
      ElMessage.success(result.detail ?? '已发起连接');
    } else {
      ElMessage.warning(result.detail ?? '连接未建立，检查 NapCat 是否已启动');
    }
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

async function disconnect(row: Instance): Promise<void> {
  busyId.value = row.id;
  try {
    await api.instances.disconnect(row.id);
    ElMessage.success('已断开');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

async function remove(row: Instance): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除实例「${row.name}」会同时删除它的人设、记忆与素材，且不可恢复。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busyId.value = row.id;
  try {
    await api.instances.remove(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

/** 适配器状态是英文枚举（AdapterStatus），界面上要翻成人话 */
const STATUS_TEXT: Record<string, string> = {
  offline: '离线',
  connecting: '连接中',
  online: '在线',
  risk: '风控中',
};

function statusLabel(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

function statusDot(status: string): string {
  if (status === 'online') return 'dot-ok';
  if (status === 'risk') return 'dot-risk';
  if (status === 'connecting') return 'dot-warn';
  return 'dot-idle';
}

function goSettings(row: Instance): void {
  void router.push({ name: 'instance-settings', params: { id: row.id } });
}

function goPersona(row: Instance): void {
  void router.push({ name: 'instance-persona', params: { id: row.id } });
}

function goSessions(row: Instance): void {
  void router.push({ name: 'instance-sessions', params: { id: row.id } });
}

function goAssets(row: Instance): void {
  void router.push({ name: 'instance-assets', params: { id: row.id } });
}

function goHealth(row: Instance): void {
  void router.push({ name: 'instance-health', params: { id: row.id } });
}

function goRules(row: Instance): void {
  void router.push({ name: 'instance-rules', params: { id: row.id } });
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">实例</h1>
        <p class="page-desc">
          一个平台账号一条实例。人设、记忆、预算都挂在这里，换模型不会动它们。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">新建实例</el-button>
    </header>

    <div class="card">
      <el-table v-loading="loading" :data="instances" style="width: 100%" :border="false">
        <el-table-column label="实例" min-width="200">
          <template #default="{ row }">
            <div class="cell-title">{{ row.name }}</div>
            <div class="cell-sub mono">{{ row.platform }} · {{ row.accountId }}</div>
          </template>
        </el-table-column>

        <el-table-column label="模型" min-width="180">
          <template #default="{ row }">
            <div class="cell-title mono">{{ row.modelMain ?? '默认' }}</div>
            <div class="cell-sub">
              <span v-if="row.modelVision">看图 {{ row.modelVision }}</span>
              <span v-else class="muted">未开看图</span>
              <span class="sep">·</span>
              <span v-if="row.ttsModel">语音 {{ row.ttsModel }}</span>
              <span v-else class="muted">未开语音</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="预算" width="150">
          <template #default="{ row }">
            <div class="cell-title">
              {{ row.dailyBudgetCents > 0 ? `¥${(row.dailyBudgetCents / 100).toFixed(2)} / 天` : '不限' }}
            </div>
            <div class="cell-sub muted">
              {{ row.monthlyBudgetCents > 0 ? `月 ¥${(row.monthlyBudgetCents / 100).toFixed(2)}` : '未设月度' }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              :loading="busyId === row.id"
              @update:model-value="(value: string | number | boolean) => toggleEnabled(row, Boolean(value))"
            />
            <div class="cell-sub">
              <span class="dot" :class="statusDot(row.status)" />
              {{ statusLabel(row.status) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="370" align="right">
          <template #default="{ row }">
            <div class="actions">
              <el-button link type="primary" @click="goSettings(row)">设置</el-button>
              <el-button link type="primary" @click="goSessions(row)">会话</el-button>
              <el-button link type="primary" @click="goPersona(row)">人设</el-button>
              <el-button link type="primary" @click="goAssets(row)">素材</el-button>
              <el-button link type="primary" @click="goRules(row)">规则</el-button>
              <el-button link type="primary" @click="goHealth(row)">健康</el-button>
              <el-button link :loading="busyId === row.id" @click="connect(row)">连接</el-button>
              <el-button link :loading="busyId === row.id" @click="disconnect(row)">断开</el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty">
            还没有实例。点右上角「新建实例」，填 QQ 号与 NapCat 的反向 WS 地址即可。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogOpen" title="新建实例" width="520px" :close-on-click-modal="false">
      <el-form label-position="top">
        <div class="grid-2">
          <el-form-item label="实例名">
            <el-input v-model="form.name" placeholder="例如：小雅" />
          </el-form-item>

          <el-form-item label="接入方式">
            <el-select
              :model-value="form.adapterType"
              style="width: 100%"
              @update:model-value="(value: string) => onAdapterChange(value)"
            >
              <el-option
                v-for="adapter in adapters"
                :key="adapter.protocol"
                :label="adapter.displayName"
                :value="adapter.protocol"
              />
            </el-select>
          </el-form-item>
        </div>

        <!-- 接入参数：完全由适配器清单渲染（D041），这里没有平台字段 -->
        <div class="adapter-fields">
          <AdapterConfigForm v-model="form.adapterConfig" :manifest="selectedAdapter" />
        </div>

        <div v-if="capabilityText" class="cap-line">{{ capabilityText }}</div>
      </el-form>

      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.cell-title {
  font-weight: 600;
  color: var(--text);
}

.cell-sub {
  color: var(--text-muted);
  font-size: 11.5px;
  margin-top: 2px;
}

.cell-sub .muted {
  color: var(--text-faint);
}

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: middle;
}

.dot-ok {
  background: var(--ok);
}

.dot-warn {
  background: var(--warn);
}

.dot-risk {
  background: var(--danger);
}

.dot-idle {
  background: var(--border-strong);
}

.sep {
  margin: 0 4px;
  color: var(--border-strong);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

.adapter-fields {
  margin-top: 2px;
}

.cap-line {
  background: #f7f8fa;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12px;
  padding: 8px 10px;
}
</style>
