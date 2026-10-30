<script setup lang="ts">
/**
 * 规则与约束词（D051）。
 *
 * 两栏，界线很重要：
 *   - 上半是**系统红线**：代码里的常量，只读。它回答的是"哪些底线不是你能调的"。
 *   - 下半是**实例约束词**：owner 自己加的"别聊这个 / 别出现这个词"，可增删改。
 *
 * 为什么要有这一页：模型再守规矩，也会有你不想让它碰的具体话题与名字
 * （某个人的名字、某个项目的代号）。把这类需求塞进人设软禁区里，
 * 它只是"尽量避开"；约束词是**代码判定**——命中就不回/不发，不靠模型自觉。
 *
 * 判定是纯文本包含（不是正则）：所以填的是"片段"，不需要转义。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';

import { api, errorText } from '@/api/client';
import type { InstanceRule, RedLine, RuleKind } from '@/api/types';

const route = useRoute();
const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(true);
const saving = ref(false);
const busyId = ref<string | null>(null);
const redLines = ref<RedLine[]>([]);
const rules = ref<InstanceRule[]>([]);

const draft = reactive<{ kind: RuleKind; pattern: string; note: string }>({
  kind: 'input_block',
  pattern: '',
  note: '',
});

const KIND_TEXT: Record<RuleKind, string> = {
  input_block: '不接这条消息',
  output_block: '不发出这句话',
};

const KIND_HINT: Record<RuleKind, string> = {
  input_block: '对方的消息里出现这个词，这条就不回（连模型都不调）。',
  output_block: '它想说的话里出现这个词，这句话就不发（但仍会存下来，便于排查）。',
};

const canSubmit = computed(() => draft.pattern.trim().length > 0 && !saving.value);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [lines, list] = await Promise.all([
      api.rules.redLines(),
      api.rules.list(instanceId.value),
    ]);
    redLines.value = lines.items;
    rules.value = list;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  saving.value = true;
  try {
    const created = await api.rules.create(instanceId.value, {
      kind: draft.kind,
      pattern: draft.pattern.trim(),
      note: draft.note.trim() ? draft.note.trim() : null,
    });
    rules.value = [...rules.value, created];
    draft.pattern = '';
    draft.note = '';
    ElMessage.success('已添加');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
}

async function toggle(row: InstanceRule): Promise<void> {
  busyId.value = row.id;
  try {
    const updated = await api.rules.update(row.id, { enabled: !row.enabled });
    rules.value = rules.value.map((item) => (item.id === updated.id ? updated : item));
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

async function remove(row: InstanceRule): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除约束词「${row.pattern}」后，这类内容就不再被拦。确定删除？`,
      '删除约束词',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busyId.value = row.id;
  try {
    await api.rules.remove(row.id);
    rules.value = rules.value.filter((item) => item.id !== row.id);
    ElMessage.success('已删除');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="page">
    <header class="page-head">
      <div>
        <div class="crumb">
          <router-link :to="{ name: 'instances' }">实例</router-link>
          <span>/</span>
          <span>规则</span>
        </div>
        <h1 class="page-title">规则与约束词</h1>
        <p class="page-desc">
          红线上半部分是系统底线，改不了；下半部分是你给它划的具体禁语，命中就不接/不发。
        </p>
      </div>
      <el-button @click="load">刷新</el-button>
    </header>

    <div class="card card-pad">
      <h2 class="section-title">系统红线（只读）</h2>
      <p class="section-desc">
        这些写死在代码里（<code>rules/red-lines.ts</code>），没有编辑入口 —— 包括部署者。
        它们会和每次对话一起发给模型，位置在最前面。
      </p>
      <ul class="red-lines">
        <li v-for="line in redLines" :key="line.id">
          <el-tag size="small" type="info" effect="plain">{{ line.id }}</el-tag>
          <span>{{ line.text }}</span>
        </li>
      </ul>
    </div>

    <div class="card card-pad">
      <h2 class="section-title">约束词</h2>
      <p class="section-desc">
        纯文本包含判定（不区分大小写、忽略空格），<strong>不是正则</strong>：填片段就行，
        不需要转义。判错方向是"少拦一次"，不会让整条回复崩掉。
      </p>

      <div class="draft">
        <el-select v-model="draft.kind" style="width: 170px">
          <el-option label="不接这条消息" value="input_block" />
          <el-option label="不发出这句话" value="output_block" />
        </el-select>
        <el-input v-model="draft.pattern" placeholder="要拦的词或片段，例如：离婚" maxlength="64" />
        <el-input v-model="draft.note" placeholder="备注（可选）" maxlength="100" />
        <el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="create">
          添加
        </el-button>
      </div>
      <p class="hint">{{ KIND_HINT[draft.kind] }}</p>

      <el-table v-if="rules.length > 0" :data="rules" size="small" class="rules">
        <el-table-column label="类型" width="140">
          <template #default="{ row }">
            <el-tag :type="row.kind === 'input_block' ? 'warning' : 'danger'" size="small" effect="light">
              {{ KIND_TEXT[row.kind as RuleKind] ?? row.kind }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="pattern" label="词/片段" min-width="140" />
        <el-table-column label="备注" min-width="160">
          <template #default="{ row }">
            <span class="muted">{{ row.note || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              :loading="busyId === row.id"
              @change="toggle(row)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="danger" :loading="busyId === row.id" @click="remove(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="还没有约束词。它现在只会被人设与红线约束。" />
    </div>
  </section>
</template>

<style scoped>
.red-lines {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
}

.red-lines li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.draft {
  display: grid;
  grid-template-columns: 170px minmax(160px, 1fr) minmax(140px, 1fr) auto;
  gap: 10px;
  margin-bottom: 8px;
}

@media (max-width: 900px) {
  .draft {
    grid-template-columns: 1fr;
  }
}

.hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.muted {
  color: var(--text-muted);
}

.rules {
  margin-top: 8px;
}
</style>
