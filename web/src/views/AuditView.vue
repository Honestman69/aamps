<script setup lang="ts">
/**
 * 审计（D044，M4-7）：谁在什么时候动了什么。
 *
 * 在这之前只能 curl `/api/admin/audit` 看原始 JSON —— 出事时（"这个 Key 谁换的""密码是不是被重置过"）
 * 没人会去敲命令行，于是这份日志等于不存在。
 *
 * 三件事必须在一屏内说清楚：
 *   1. **动作是什么**：`credential.rotate` 这种码对人没意义，先给中文，码留作核对。
 *   2. **改了什么**：改动前后并排。删/建只有一侧，就明说是"删除"还是"新建"。
 *   3. **链有没有断**：一条记录被改过，它的 hash 就对不上；点一下按钮能重算全链并报出断点。
 *
 * 这一页**只读**：没有删除、没有编辑。日志是证据，能改的日志等于没有日志。
 */
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';

import { api, errorText } from '@/api/client';
import type { AuditChainVerifyResult, AuditEntry } from '@/api/types';

/** 服务端 `limit` 上限 500，超过会被 400 拒掉，所以这里只能给这三档 */
const LIMITS = [100, 200, 500];

const limit = ref(200);
const loading = ref(false);
const rows = ref<AuditEntry[]>([]);

const verifying = ref(false);
const verifyResult = ref<AuditChainVerifyResult | null>(null);
/** 断点定位：只在"断点那一行确实在当前窗口里"时才允许，否则按钮点了也没地方去 */
const onlyBroken = ref(false);

const keyword = ref('');
const moduleFilter = ref('all');

/**
 * id → 可读名字的对照表（用户 + 实例）。
 *
 * 审计里 `actorUserId` / `target` / `targetOwnerId` 都只存 cuid（例如
 * `user.update` 的目标是用户 id，`instance.delete` 的目标是实例 id），
 * 直接摆出来等于没回答"谁、动了哪个" —— 而这一页的全部意义就是这个。
 * 拿不到就退回显示 id：只读页不该因为"名字查不到"整页失败。
 */
const labelById = ref<Record<string, string>>({});

/** 动作码 → 人话。漏了的码不隐藏，直接显示原码（新动作先能用，再补文案） */
const ACTION_LABELS: Record<string, string> = {
  'credential.create': '新建密钥',
  'credential.update': '修改密钥',
  'credential.delete': '删除密钥',
  'credential.rotate': '轮换密钥',
  'credential.disable_by_admin': '管理员停用密钥',
  'credential.unlock': '解锁密钥库',
  'credential.lock': '锁定密钥库',
  'instance.create': '新建实例',
  'instance.update': '修改实例',
  'instance.delete': '删除实例',
  'instance.connect': '连接平台',
  'instance.disconnect': '断开平台',
  'persona.create': '新建人设',
  'persona.update': '修改人设',
  'persona.publish': '发布人设',
  'persona.archive': '归档人设',
  'persona.activate': '启用人设',
  'asset.delete': '删除素材',
  'user.login': '登录',
  'user.login_failed': '登录失败',
  'user.create': '新建账号',
  'user.update': '修改账号',
  'user.password_change': '修改密码',
  'user.password_reset': '管理员重置密码',
  'user.password_reset_self': '重置自己的密码',
  'admin.impersonate': '代登录',
};

const MODULE_LABELS: Record<string, string> = {
  credential: '密钥',
  instance: '实例',
  persona: '人设',
  asset: '素材',
  user: '账号',
  admin: '管理',
};

const ACTOR_LABELS: Record<string, string> = {
  superadmin: '管理员',
  user: '用户',
  system: '系统',
  worker: '后台任务',
};

/** 破坏性动作：删、销毁、停用。扫日志时应该一眼能看见它们 */
const DANGER_ACTIONS = new Set([
  'credential.delete',
  'credential.rotate',
  'credential.disable_by_admin',
  'instance.delete',
  'persona.archive',
  'asset.delete',
  'user.password_reset',
  'admin.impersonate',
]);

/** 只读动作：不看它们也是一屏有效信息，给个弱化标记 */
const QUIET_ACTIONS = new Set([
  'user.login',
  'user.login_failed',
  'credential.unlock',
  'credential.lock',
]);

const broken = computed(() => {
  const result = verifyResult.value;
  return result && !result.ok ? result : null;
});

const verified = computed(() => {
  const result = verifyResult.value;
  return result && result.ok ? result : null;
});

const modules = computed(() => {
  const seen = new Set<string>();
  for (const row of rows.value) {
    seen.add(moduleOf(row.action));
  }
  return [...seen].sort();
});

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  const targetId = broken.value && onlyBroken.value ? broken.value.brokenAtId : null;
  return rows.value.filter((row) => {
    if (targetId && row.id !== targetId) {
      return false;
    }
    if (moduleFilter.value !== 'all' && moduleOf(row.action) !== moduleFilter.value) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return [
      row.action,
      actionLabel(row.action),
      row.actor,
      row.actorUserId ?? '',
      // 按人名/实例名搜也要能搜到：界面上显示的是名字，搜索却只认 cuid 会显得很怪
      labelOf(row.actorUserId),
      row.target ?? '',
      targetText(row.target),
      row.ip ?? '',
      row.id,
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
});

/** 断点那一行在不在当前加载的窗口里 —— 不在就没法"定位"，只能提示调大条数 */
const brokenRowLoaded = computed(() => {
  const result = broken.value;
  return result ? rows.value.some((row) => row.id === result.brokenAtId) : false;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api.admin.audit(limit.value);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

/** 名字对照：失败就空表，界面退回 id（不弹错，不阻塞列表） */
async function loadLabels(): Promise<void> {
  // 两类会被审计记成 id 的东西：账号、实例。各自失败互不影响
  const [users, instances] = await Promise.all([
    api.admin.users().catch(() => []),
    api.instances.list().catch(() => []),
  ]);
  const map: Record<string, string> = {};
  for (const user of users) {
    map[user.id] = user.displayName?.trim() || user.username;
  }
  for (const instance of instances) {
    map[instance.id] = instance.name;
  }
  labelById.value = map;
}

onMounted(() => {
  void loadLabels();
  void load();
});

async function reload(): Promise<void> {
  onlyBroken.value = false;
  await load();
}

async function verify(): Promise<void> {
  verifying.value = true;
  try {
    const result = await api.admin.verifyAudit();
    verifyResult.value = result;
    onlyBroken.value = false;
    if (result.ok) {
      ElMessage.success(`链完整：已核对 ${result.checked} 条`);
    } else {
      ElMessage.error(`链在第 ${result.index + 1} 条断了`);
    }
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    verifying.value = false;
  }
}

function moduleOf(action: string): string {
  return action.split('.')[0] ?? action;
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function moduleLabel(key: string): string {
  return MODULE_LABELS[key] ?? key;
}

function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor;
}

/**
 * 时间格式：手拼成 `2026-10-26 23:01:43`。
 * 不用 `toLocaleString('zh-CN')` —— 它给的是 `2026/10/26 23:01:43`，
 * 斜杠日期在排错时容易和"月/日"读混，也不利于直接粘进 grep。
 */
function timeText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/** id / 用户 id 太长，列表里只给前 8 位；完整值在展开区 */
function shortId(value: string | null): string {
  if (!value) {
    return '—';
  }
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

/** 能查到名字就用名字；查不到退回短 id（宁可显示 cuid，也不能显示空白） */
function labelOf(id: string | null): string {
  if (!id) {
    return '';
  }
  return labelById.value[id] ?? shortId(id);
}

/**
 * 目标列：`user.update` 记的是目标用户 id、`instance.delete` 记实例 id，
 * 能对上名字就换成人话；Key 标签、人设名这些本来就已是人话，原样显示。
 */
function targetText(target: string | null): string {
  if (!target) {
    return '—';
  }
  return labelById.value[target] ?? target;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[无法展示]';
  }
}

/** 长内容（人设片段、错误堆栈）在表格里截断，完整值放 title */
function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

type DiffCell = { key: string; before: string; after: string; changed: boolean };

/** 改前/改后并排：键取并集，`changed` 用来高亮真正变了的字段 */
function diffRows(entry: AuditEntry): DiffCell[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((key) => {
    const left = valueText(before[key]);
    const right = valueText(after[key]);
    return { key, before: left, after: right, changed: left !== right };
  });
}

/** 这条记录属于哪种变更：只有 after = 新建，只有 before = 删除 */
function changeKind(entry: AuditEntry): string {
  if (entry.before && entry.after) {
    return '修改';
  }
  if (entry.after) {
    return '新建';
  }
  if (entry.before) {
    return '删除';
  }
  return '无字段变更';
}

function hasPayload(entry: AuditEntry): boolean {
  return Boolean(entry.before || entry.after);
}

function rowClassName({ row }: { row: AuditEntry }): string {
  return broken.value && row.id === broken.value.brokenAtId ? 'row-broken' : '';
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">审计</h1>
        <p class="page-desc">
          谁在什么时候动了什么。<b>只增不改</b>：改动或删除任何一条，它后面所有记录的哈希都会对不上。
        </p>
      </div>
      <div class="head-actions">
        <el-button :loading="loading" @click="reload">刷新</el-button>
        <el-button type="primary" :loading="verifying" @click="verify">校验链完整性</el-button>
      </div>
    </header>

    <!-- 校验结果：失败时把断点摆出来，而不是只弹一句"校验失败" -->
    <div v-if="verified" class="verify verify-ok">
      <div>
        <strong>链完整</strong>
        <span class="verify-text">已从最早一条重算到最新，{{ verified.checked }} 条记录的哈希全部对得上。</span>
      </div>
      <el-button link @click="verifyResult = null">收起</el-button>
    </div>

    <div v-else-if="broken" class="verify verify-bad">
      <div>
        <strong>链在第 {{ broken.index + 1 }} 条断了</strong>
        <div class="verify-text">
          {{ broken.reason }}<br />
          记录 id <span class="mono">{{ broken.brokenAtId }}</span>
          <template v-if="!brokenRowLoaded">
            —— 它比当前加载的 {{ limit }} 条更早，把右上角「显示条数」调大再定位。
          </template>
        </div>
      </div>
      <div class="verify-actions">
        <el-button
          v-if="brokenRowLoaded"
          size="small"
          :type="onlyBroken ? undefined : 'danger'"
          @click="onlyBroken = !onlyBroken"
        >
          {{ onlyBroken ? '显示全部' : '只看这条' }}
        </el-button>
        <el-button link @click="verifyResult = null">收起</el-button>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜操作者 / 目标 / IP / 记录 id"
          clearable
          size="small"
          class="search"
        />
        <el-select v-model="moduleFilter" size="small" class="module">
          <el-option label="全部模块" value="all" />
          <el-option v-for="key in modules" :key="key" :label="moduleLabel(key)" :value="key" />
        </el-select>
        <el-select v-model="limit" size="small" class="limit" @change="reload">
          <el-option v-for="value in LIMITS" :key="value" :label="`最近 ${value} 条`" :value="value" />
        </el-select>
        <span class="count muted">
          显示 {{ filtered.length }} / 已加载 {{ rows.length }} 条
        </span>
      </div>

      <el-table
        v-loading="loading"
        :data="filtered"
        row-key="id"
        :border="false"
        :row-class-name="rowClassName"
        style="width: 100%"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="detail">
              <div class="detail-head">
                <span class="pill">{{ changeKind(row) }}</span>
                <span class="mono faint">记录 id {{ row.id }}</span>
              </div>

              <table v-if="hasPayload(row)" class="diff">
                <thead>
                  <tr>
                    <th class="col-key">字段</th>
                    <th>改前</th>
                    <th>改后</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="cell in diffRows(row)" :key="cell.key" :class="{ changed: cell.changed }">
                    <td class="col-key mono">{{ cell.key }}</td>
                    <td class="col-val" :title="cell.before">{{ clip(cell.before) || '—' }}</td>
                    <td class="col-val" :title="cell.after">{{ clip(cell.after) || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="muted detail-note">
                这条记录没有字段变更 —— 登录、解锁这类事件只记「发生过」。
              </div>

              <div class="chain">
                <div class="chain-row">
                  <span class="chain-key">hash</span>
                  <span class="mono chain-val">{{ row.hash }}</span>
                </div>
                <div class="chain-row">
                  <span class="chain-key">prev</span>
                  <span class="mono chain-val">{{ row.prevHash ?? '（链首，没有上一条）' }}</span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span class="mono time">{{ timeText(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作者" width="150">
          <template #default="{ row }">
            <div class="cell-title">{{ actorLabel(row.actor) }}</div>
            <div v-if="row.actorUserId" class="cell-sub" :title="row.actorUserId">
              {{ labelOf(row.actorUserId) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="动作" width="200">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="DANGER_ACTIONS.has(row.action) ? 'danger' : QUIET_ACTIONS.has(row.action) ? 'info' : undefined"
              :effect="DANGER_ACTIONS.has(row.action) ? 'light' : 'plain'"
            >
              {{ actionLabel(row.action) }}
            </el-tag>
            <div class="cell-sub mono">{{ row.action }}</div>
          </template>
        </el-table-column>

        <el-table-column label="目标" min-width="200">
          <template #default="{ row }">
            <div class="target" :title="row.target ?? ''">{{ targetText(row.target) }}</div>
            <!-- 目标本身就是这个人/这台实例时，"归属"是同一条信息，别重复一遍 -->
            <div
              v-if="row.targetOwnerId && row.targetOwnerId !== row.target"
              class="cell-sub"
              :title="row.targetOwnerId"
            >
              归属 {{ labelOf(row.targetOwnerId) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="IP" width="140">
          <template #default="{ row }">
            <span class="mono ip">{{ row.ip || '—' }}</span>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty">
            没有匹配的记录。审计从第一次登录/改配置就开始记，如果这里一直是空的，
            说明还没发生过任何写操作。
          </div>
        </template>
      </el-table>
    </div>
  </section>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}

.verify {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 12px;
  font-size: 12.5px;
  line-height: 1.65;
}

.verify-ok {
  background: #f1f8f4;
  border: 1px solid #cfe9db;
  color: #276749;
}

.verify-bad {
  background: #fdf3f3;
  border: 1px solid #f4d3d3;
  color: #8c2b2b;
}

.verify-text {
  color: var(--text-muted);
  margin-left: 8px;
}

.verify-bad .verify-text {
  color: #8c2b2b;
  display: block;
  margin: 3px 0 0;
}

.verify-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.search {
  width: 260px;
}

.module {
  width: 130px;
}

.limit {
  width: 130px;
}

.count {
  margin-left: auto;
  font-size: 11.5px;
}

.time {
  font-size: 12px;
}

.cell-title {
  font-weight: 600;
  color: var(--text);
}

.cell-sub {
  color: var(--text-faint);
  font-size: 11px;
  margin-top: 2px;
}

.target {
  word-break: break-all;
}

.ip {
  font-size: 12px;
  color: var(--text-muted);
}

/* 断点行：整行淡红，扫一眼就能落在那一条上 */
:deep(.row-broken) {
  background: #fdf3f3;
}

:deep(.row-broken:hover > td) {
  background: #fbe9e9 !important;
}

.detail {
  padding: 6px 14px 12px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.pill {
  display: inline-block;
  font-size: 11px;
  color: var(--text-muted);
  background: #f2f4f7;
  border-radius: 4px;
  padding: 1px 6px;
}

.faint {
  color: var(--text-faint);
  font-size: 11px;
}

.diff {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}

.diff th {
  text-align: left;
  font-weight: 500;
  color: var(--text-faint);
  font-size: 11px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.diff td {
  padding: 5px 8px;
  border-bottom: 1px solid #f1f2f4;
  vertical-align: top;
  word-break: break-all;
  color: var(--text-muted);
}

.diff .col-key {
  width: 150px;
  color: var(--text-faint);
}

/* 真正变了的字段加重，未变的保持淡化 */
.diff tr.changed td {
  color: var(--text);
  background: #fbfcfe;
}

.detail-note {
  font-size: 12px;
  padding: 2px 0 4px;
}

.chain {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}

.chain-row {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.7;
}

.chain-key {
  color: var(--text-faint);
  flex: 0 0 34px;
}

.chain-val {
  color: var(--text-faint);
  word-break: break-all;
}

.muted {
  color: var(--text-faint);
}
</style>
