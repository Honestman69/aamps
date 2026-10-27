<script setup lang="ts">
/**
 * 素材库（M4-3）。
 *
 * 存在的理由很具体：D034 说"存失败时后台能立刻看出没存上"，
 * 而在此之前用户唯一能确认的方式是——让它再发一次那张图试试。
 *
 * 界面上刻意只做三件事：**看、筛、删**。
 * 不做改名（旧对话里的 `[use]名字[/use]` 会指到别处）、不做上传（M4 没有上传通道）、
 * 不做批量删（没有撤销，误点一次就没了）。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { api, errorText } from '@/api/client';
import type { MediaAsset, MediaAssetList } from '@/api/types';

const route = useRoute();
const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(false);
const busyId = ref<string | null>(null);
const includeDeleted = ref(false);
const data = ref<MediaAssetList | null>(null);
/** 文件丢失的素材 id：图片 404 时置进来，避免一直显示破图 */
const brokenIds = ref<Set<string>>(new Set());

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.assets.list(instanceId.value, {
      includeDeleted: includeDeleted.value,
      limit: 100,
    });
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(includeDeleted, load);

const stats = computed(() => data.value?.stats ?? { usable: 0, deleted: 0, bytes: 0, limit: 200 });

const usageText = computed(() => `${stats.value.usable} / ${stats.value.limit}`);

const bytesText = computed(() => formatBytes(stats.value.bytes));

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 KB';
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeText(value: string | null): string {
  if (!value) {
    return '没用过';
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return '—';
  }
  return at.toLocaleString('zh-CN', { hour12: false });
}

function markBroken(asset: MediaAsset): void {
  brokenIds.value = new Set(brokenIds.value).add(asset.id);
}

async function remove(asset: MediaAsset): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${asset.alias}」之后，模型不能再发这张图；名字会保留（避免旧对话里的引用指到别的图）。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busyId.value = asset.id;
  try {
    await api.assets.remove(instanceId.value, asset.id);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <div class="crumb">
          <router-link :to="{ name: 'instances' }">实例</router-link>
          <span>/</span>
          <router-link :to="{ name: 'instance-settings', params: { id: instanceId } }">设置</router-link>
          <span>/</span>
          <span>素材</span>
        </div>
        <h1 class="page-title">素材库</h1>
        <p class="page-desc">
          对话里说"这个表情存下来"，模型就会用 <code>[save]名字[/save]</code> 存进来；
          以后想发就说 <code>[use]名字[/use]</code>。这里能看到它到底存了什么。
        </p>
      </div>
      <div class="head-actions">
        <el-checkbox v-model="includeDeleted">含已删除</el-checkbox>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <div class="stat-row">
      <div class="stat">
        <span class="stat-num">{{ usageText }}</span>
        <span class="stat-label">已用 / 上限</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ bytesText }}</span>
        <span class="stat-label">占用空间</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ stats.deleted }}</span>
        <span class="stat-label">已删除（名字占位）</span>
      </div>
    </div>

    <div v-if="loading && !data" class="card card-pad empty">加载中…</div>

    <div v-else-if="(data?.items.length ?? 0) === 0" class="card card-pad empty-state">
      <p class="empty-title">还是空的</p>
      <p class="empty-desc">
        素材只能从对话里存进来：发一张图给它，说"这个存下来"，它就会起个名字收着。
        <br />
        没有存过任何东西时，提示词里不会出现 <code>[use]</code>，它也就不会编一个不存在的名字。
      </p>
    </div>

    <div v-else class="asset-grid">
      <article v-for="asset in data?.items ?? []" :key="asset.id" :class="['asset', { deleted: asset.deleted }]">
        <div class="thumb">
          <img
            v-if="!asset.deleted && !brokenIds.has(asset.id)"
            :src="asset.fileUrl"
            :alt="asset.alias"
            loading="lazy"
            @error="markBroken(asset)"
          />
          <div v-else class="thumb-fallback">
            {{ asset.deleted ? '已删除' : '文件丢失' }}
          </div>
          <span v-if="asset.deleted" class="badge">已删</span>
        </div>

        <div class="meta">
          <div class="alias-row">
            <span class="alias">{{ asset.alias }}</span>
            <span class="uses">{{ asset.useCount }} 次</span>
          </div>
          <div class="sub">
            {{ formatBytes(asset.bytes) }} · {{ asset.mime.replace('image/', '') }}
          </div>
          <div class="sub">{{ timeText(asset.lastUsedAt) }}</div>
        </div>

        <div class="actions">
          <el-button
            v-if="!asset.deleted"
            link
            type="danger"
            size="small"
            :loading="busyId === asset.id"
            @click="remove(asset)"
          >
            删除
          </el-button>
          <span v-else class="sub">名字仍被占用</span>
        </div>
      </article>
    </div>

    <p v-if="stats.usable >= stats.limit" class="limit-hint">
      已经存满了（{{ stats.limit }} 张）。再存会被拒绝，先删掉一些不用的。
    </p>
  </section>
</template>

<style scoped>
.crumb {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--text-faint);
  font-size: 12px;
  margin-bottom: 4px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

code {
  background: #f2f3f5;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11.5px;
}

.stat-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 16px;
  min-width: 120px;
}

.stat-num {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.stat-label {
  color: var(--text-faint);
  font-size: 11.5px;
}

.asset-grid {
  display: grid;
  /* 固定卡片宽：缩略图拉满整行会变成三张巨图，素材本来就该是"小格子" */
  grid-template-columns: repeat(auto-fill, 168px);
  gap: 12px;
}

.asset {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-sm);
}

.asset.deleted {
  opacity: 0.72;
  border-style: dashed;
}

.thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  background: #f4f5f7;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb-fallback {
  color: var(--text-faint);
  font-size: 12px;
}

.badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgb(22 24 29 / 62%);
  color: #fff;
  border-radius: 999px;
  font-size: 10.5px;
  padding: 1px 7px;
}

.meta {
  padding: 8px 10px 4px;
}

.alias-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.alias {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uses {
  color: var(--accent);
  font-size: 11px;
  flex: 0 0 auto;
}

.sub {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}

.actions {
  display: flex;
  justify-content: flex-end;
  padding: 0 8px 6px;
}

.empty {
  color: var(--text-faint);
  text-align: center;
}

.empty-state {
  text-align: center;
  padding: 44px 20px;
}

.empty-title {
  margin: 0 0 6px;
  font-weight: 600;
}

.empty-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.limit-hint {
  margin-top: 14px;
  color: var(--warn);
  font-size: 12px;
}
</style>
