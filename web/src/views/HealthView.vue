<script setup lang="ts">
/**
 * 健康与事件（M6-3 / D048、D049）。
 *
 * 这一页只解决一个问题：**"它为什么忽然不说话了"要能一眼查到。**
 *
 * 数据分两块，来源不同、含义也不同：
 *   - 上半是**现在**：健康分、等级、连续被拦次数、本次动作（`GET /risk`，实时算，不落库）；
 *   - 下半是**发生过什么**：`InstanceEvent` 列表（`GET /events`），包括平台拦发送、
 *     风控自动降级、登录态异常。
 *
 * 刻意**没有任何操作按钮**（没有"解除静默"、没有"重置健康分"）：
 * 降级是机器按信号做的，人手关静默的理由永远是"现在要见客户"（D048）。
 * 真要立刻停，去实例设置里关掉 `enabled` —— 那是明确的人为动作，有审计。
 */
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { api, errorText } from '@/api/client';
import type { Instance, InstanceEvent, RiskOverview } from '@/api/types';

const route = useRoute();
const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(true);
const overview = ref<RiskOverview | null>(null);
const events = ref<InstanceEvent[]>([]);
const instance = ref<Instance | null>(null);

const LEVEL_TEXT: Record<string, string> = {
  healthy: '正常',
  degraded: '注意',
  readonly: '只收不发',
  stopped: '已停用',
};

const LEVEL_TYPE: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
  healthy: 'success',
  degraded: 'warning',
  readonly: 'danger',
  stopped: 'danger',
};

/** 事件等级 → 标签颜色。risk 是最严重的一档（平台层面的信号） */
function eventTagType(level: string): 'info' | 'warning' | 'danger' {
  if (level === 'risk' || level === 'error') {
    return 'danger';
  }
  return level === 'warn' ? 'warning' : 'info';
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const actionText = computed(() => {
  const action = overview.value?.action;
  if (!action || action.kind === 'none') {
    return '无（不需要降级）';
  }
  const until = action.until ? `，截止 ${formatTime(action.until)}` : '';
  return `${action.reason ?? action.kind}${until}`;
});

const level = computed(() => overview.value?.level ?? 'healthy');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [risk, eventList, instances] = await Promise.all([
      api.risk.get(instanceId.value),
      api.risk.events(instanceId.value, { limit: 50 }),
      api.instances.list(),
    ]);
    overview.value = risk;
    events.value = eventList.items;
    instance.value = instances.find((item) => item.id === instanceId.value) ?? null;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page" v-loading="loading">
    <header class="page-head">
      <div>
        <h1 class="page-title">健康与事件</h1>
        <p class="page-desc">
          {{ instance?.name ?? '这个实例' }} 的风控现状。分数由最近 24 小时的信号算出，
          降级由机器执行 —— 这一页只读。
        </p>
      </div>
      <el-button @click="load">刷新</el-button>
    </header>

    <div class="grid">
      <div class="card card-pad score-card">
        <div class="score-line">
          <span class="score">{{ overview?.score ?? '—' }}</span>
          <el-tag :type="LEVEL_TYPE[level]" effect="light" round>{{ LEVEL_TEXT[level] ?? level }}</el-tag>
        </div>
        <p class="score-hint">健康分（0–100）</p>
        <ul class="reasons">
          <li v-for="reason in overview?.reasons ?? []" :key="reason">{{ reason }}</li>
        </ul>
      </div>

      <div class="card card-pad">
        <h2 class="card-title">当前处置</h2>
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="连续被拦">
            {{ overview?.consecutiveBlocks ?? 0 }} 次
          </el-descriptions-item>
          <el-descriptions-item label="本次动作">{{ actionText }}</el-descriptions-item>
          <el-descriptions-item label="静默截止">
            {{ overview?.silentUntil ? formatTime(overview.silentUntil) : '未静默' }}
          </el-descriptions-item>
          <el-descriptions-item label="实例状态">
            {{ instance?.status ?? '—' }}
            <span class="muted">（{{ instance?.enabled ? '启用中' : '已停用' }}）</span>
          </el-descriptions-item>
        </el-descriptions>
        <p class="muted hint">
          连续被拦 1 次冷却 10 分钟、2 次只收不发 6 小时、3 次停实例等人工介入（D048）。
          静默期间消息照常入库，只是不回。
        </p>
      </div>
    </div>

    <div class="card card-pad">
      <h2 class="card-title">最近发生了什么</h2>
      <p class="muted hint">
        只显示最近 50 条。平台拦发送、风控自动降级、登录态异常都会记在这里 ——
        “为什么半夜不回话”先看这张表。
      </p>

      <el-table v-if="events.length > 0" :data="events" size="small" class="events">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="等级" width="90">
          <template #default="{ row }">
            <el-tag :type="eventTagType(row.level)" size="small" effect="light">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="类型" width="150" />
        <el-table-column prop="message" label="说明" />
      </el-table>
      <el-empty v-else description="还没有事件。风平浪静，或者它还没连上平台。" />
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.4fr);
  gap: 16px;
  margin-bottom: 16px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.score-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.score-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.score {
  font-size: 48px;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}

.score-hint {
  margin: 6px 0 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.reasons {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
}

.card-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
}

.muted {
  color: var(--text-muted);
}

.events {
  margin-top: 8px;
}
</style>
