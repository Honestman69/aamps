<script setup lang="ts">
/**
 * 人设编辑器。
 *
 * 三条与后端约定强相关的规则，界面必须体现出来（D037）：
 *   1. **草稿不能启用** —— 所以"启用"按钮在 draft 状态是禁用的，并给出原因；
 *   2. **改已发布 = 新版本** —— 保存后 version+1，界面上要能看出"这次改动会变成新版本"；
 *   3. **行为参数写错字段直接 400** —— 所以这里用结构化表单，不提供"编辑原始 JSON"的入口。
 *
 * 故障话术的三种状态必须分开（不是两种）：**未配置**走代码默认话术、**null** 是"明确不说话"、
 * 字符串是"说这句"。把它们压成两种，用户就没法表达"这个场景我宁可装死"。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { api, errorText } from '@/api/client';
import type { Persona, PersonaPatch, PersonaStatus } from '@/api/types';

const route = useRoute();
const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(false);
const saving = ref(false);
const busy = ref<string | null>(null);
const personas = ref<Persona[]>([]);
const includeArchived = ref(false);
const current = ref<Persona | null>(null);
const original = ref<Persona | null>(null);

const createOpen = ref(false);
const creating = ref(false);
const newName = ref('');

type FallbackMode = 'default' | 'silent' | 'custom';
type FallbackField = { mode: FallbackMode; text: string };
type SlotKey = 'shortOutage' | 'longOutage' | 'budgetLimit';

const SLOTS: Array<{ key: SlotKey; label: string; desc: string }> = [
  { key: 'shortOutage', label: '短暂故障', desc: '超时、5xx，通常几秒后恢复' },
  { key: 'longOutage', label: '持续故障', desc: 'Key 失效、持续连不上' },
  { key: 'budgetLimit', label: '预算用尽', desc: '当天/当月额度到顶' },
];

type Draft = {
  name: string;
  tagline: string;
  avatar: string;
  identity: { name: string; age: string; gender: string; role: string; background: string };
  promptBlocks: Array<{ title: string; content: string; enabled: boolean }>;
  examples: Array<{ user: string; assistant: string }>;
  opening: { private: string; groupMention: string; proactive: string };
  boundaries: string[];
  variables: Array<{ key: string; value: string }>;
  behavior: {
    attention: {
      base: number | undefined;
      privateBoost: number | undefined;
      thresholdPrivate: number | undefined;
      thresholdGroup: number | undefined;
      thresholdBusy: number | undefined;
      mention: number | undefined;
      affinity: number | undefined;
    };
    expression: {
      maxCharsPerSegment: number | undefined;
      maxSegments: number | undefined;
      typingCps: number | undefined;
      mentionBack: boolean | undefined;
    };
    thinkEnabled: boolean | undefined;
  };
  fallbacks: Record<SlotKey, { private: FallbackField; group: FallbackField }>;
  quoteTendency: string;
};

function blankDraft(): Draft {
  const slot = (): FallbackField => ({ mode: 'default', text: '' });
  return {
    name: '',
    tagline: '',
    avatar: '',
    identity: { name: '', age: '', gender: '', role: '', background: '' },
    promptBlocks: [],
    examples: [],
    opening: { private: '', groupMention: '', proactive: '' },
    boundaries: [],
    variables: [],
    behavior: {
      attention: {
        base: undefined,
        privateBoost: undefined,
        thresholdPrivate: undefined,
        thresholdGroup: undefined,
        thresholdBusy: undefined,
        mention: undefined,
        affinity: undefined,
      },
      expression: {
        maxCharsPerSegment: undefined,
        maxSegments: undefined,
        typingCps: undefined,
        mentionBack: undefined,
      },
      thinkEnabled: undefined,
    },
    fallbacks: {
      shortOutage: { private: slot(), group: slot() },
      longOutage: { private: slot(), group: slot() },
      budgetLimit: { private: slot(), group: slot() },
    },
    quoteTendency: 'normal',
  };
}

const draft = reactive<Draft>(blankDraft());

function toFallbackField(raw: string | null | undefined): FallbackField {
  if (raw === null) {
    return { mode: 'silent', text: '' };
  }
  if (typeof raw === 'string') {
    return { mode: 'custom', text: raw };
  }
  return { mode: 'default', text: '' };
}

function fromFallbackField(field: FallbackField): string | null | undefined {
  if (field.mode === 'silent') {
    return null;
  }
  if (field.mode === 'custom') {
    // 选了"自定义"但没填字：等价于没配，别把一个空字符串存进库
    return field.text.trim() ? field.text.trim() : undefined;
  }
  return undefined;
}

function applyPersona(persona: Persona): void {
  original.value = JSON.parse(JSON.stringify(persona)) as Persona;
  current.value = persona;

  const next = blankDraft();
  next.name = persona.name;
  next.tagline = persona.tagline ?? '';
  next.avatar = persona.avatar ?? '';
  next.identity = {
    name: persona.identity.name ?? '',
    age: persona.identity.age ?? '',
    gender: persona.identity.gender ?? '',
    role: persona.identity.role ?? '',
    background: persona.identity.background ?? '',
  };
  next.promptBlocks = persona.promptBlocks.map((block) => ({
    title: block.title ?? '',
    content: block.content,
    enabled: block.enabled !== false,
  }));
  next.examples = persona.examples.map((item) => ({
    user: item.user ?? '',
    assistant: item.assistant ?? '',
  }));
  next.opening = {
    private: persona.opening.private ?? '',
    groupMention: persona.opening.groupMention ?? '',
    proactive: persona.opening.proactive ?? '',
  };
  next.boundaries = [...persona.boundaries];
  next.variables = Object.entries(persona.variables).map(([key, value]) => ({ key, value }));

  const attention = persona.behavior.attention ?? {};
  const weights = attention.weights ?? {};
  next.behavior.attention = {
    base: attention.base,
    privateBoost: attention.privateBoost,
    thresholdPrivate: attention.thresholdPrivate,
    thresholdGroup: attention.thresholdGroup,
    thresholdBusy: attention.thresholdBusy,
    mention: weights.mention,
    affinity: weights.affinity,
  };
  const expression = persona.behavior.expression ?? {};
  next.behavior.expression = {
    maxCharsPerSegment: expression.maxCharsPerSegment,
    maxSegments: expression.maxSegments,
    typingCps: expression.typingCps,
    mentionBack: expression.mentionBack,
  };
  next.behavior.thinkEnabled = persona.behavior.think?.enabled;

  for (const slot of SLOTS) {
    const raw = persona.fallbacks[slot.key] ?? {};
    next.fallbacks[slot.key] = {
      private: toFallbackField(raw.private),
      group: toFallbackField(raw.group),
    };
  }
  next.quoteTendency = persona.quoteTendency || 'normal';

  Object.assign(draft, next);
}

async function loadList(preferId?: string): Promise<void> {
  loading.value = true;
  try {
    const list = await api.personas.list(instanceId.value, includeArchived.value);
    personas.value = list;
    const target = preferId ? list.find((item) => item.id === preferId) : list[0];
    if (target) {
      applyPersona(target);
    } else {
      current.value = null;
      original.value = null;
      Object.assign(draft, blankDraft());
    }
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(() => loadList());

watch(includeArchived, () => void loadList(current.value?.id));

async function select(persona: Persona): Promise<void> {
  if (current.value && dirty.value) {
    try {
      await ElMessageBox.confirm('切换会丢掉未保存的改动，继续？', '未保存', {
        confirmButtonText: '继续',
        cancelButtonText: '取消',
        type: 'warning',
      });
    } catch {
      return;
    }
  }
  applyPersona(persona);
}

/** 组装提交体：只有和原始值不同的字段才会进 patch */
function buildPatch(): PersonaPatch {
  const base = original.value;
  const patch: PersonaPatch = {};
  if (!base) {
    return patch;
  }

  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  if (draft.name.trim() !== base.name) {
    patch.name = draft.name.trim();
  }
  // 服务端可能存成空串（nullable 列），比较前先归一到 null，否则会永远显示"有改动"
  if ((draft.tagline.trim() || null) !== (base.tagline?.trim() || null)) {
    patch.tagline = draft.tagline.trim();
  }
  if ((draft.avatar.trim() || null) !== (base.avatar?.trim() || null)) {
    patch.avatar = draft.avatar.trim() || null;
  }

  const identity: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.identity)) {
    if (value.trim()) {
      identity[key] = value.trim();
    }
  }
  if (!same(identity, base.identity)) {
    patch.identity = identity;
  }

  const blocks = draft.promptBlocks
    .filter((block) => block.content.trim())
    .map((block, index) => ({
      title: block.title.trim(),
      content: block.content.trim(),
      enabled: block.enabled,
      order: index,
    }));
  if (!same(blocks, base.promptBlocks.map((block, index) => ({
    title: block.title ?? '',
    content: block.content,
    enabled: block.enabled !== false,
    order: block.order ?? index,
  })))) {
    patch.promptBlocks = blocks;
  }

  const examples = draft.examples
    .filter((item) => item.user.trim() || item.assistant.trim())
    .map((item) => ({ user: item.user.trim(), assistant: item.assistant.trim() }));
  if (!same(examples, base.examples)) {
    patch.examples = examples;
  }

  const opening: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.opening)) {
    if (value.trim()) {
      opening[key] = value.trim();
    }
  }
  if (!same(opening, base.opening)) {
    patch.opening = opening;
  }

  if (!same(draft.boundaries, base.boundaries)) {
    patch.boundaries = draft.boundaries;
  }

  const variables: Record<string, string> = {};
  for (const item of draft.variables) {
    if (item.key.trim()) {
      variables[item.key.trim()] = item.value;
    }
  }
  if (!same(variables, base.variables)) {
    patch.variables = variables;
  }

  // behavior：只提交用户真的填了的项（清空 = 回落到代码默认，而不是写死一个旧默认值）
  const attention: Record<string, unknown> = {};
  const weights: Record<string, number> = {};
  for (const key of ['base', 'privateBoost', 'thresholdPrivate', 'thresholdGroup', 'thresholdBusy'] as const) {
    const value = draft.behavior.attention[key];
    if (typeof value === 'number') {
      attention[key] = value;
    }
  }
  if (typeof draft.behavior.attention.mention === 'number') {
    weights.mention = draft.behavior.attention.mention;
  }
  if (typeof draft.behavior.attention.affinity === 'number') {
    weights.affinity = draft.behavior.attention.affinity;
  }
  if (Object.keys(weights).length > 0) {
    attention.weights = weights;
  }

  const expression: Record<string, unknown> = {};
  for (const key of ['maxCharsPerSegment', 'maxSegments', 'typingCps'] as const) {
    const value = draft.behavior.expression[key];
    if (typeof value === 'number') {
      expression[key] = value;
    }
  }
  if (typeof draft.behavior.expression.mentionBack === 'boolean') {
    expression.mentionBack = draft.behavior.expression.mentionBack;
  }

  const behavior: Record<string, unknown> = {};
  if (Object.keys(attention).length > 0) behavior.attention = attention;
  if (Object.keys(expression).length > 0) behavior.expression = expression;
  if (typeof draft.behavior.thinkEnabled === 'boolean') {
    behavior.think = { enabled: draft.behavior.thinkEnabled };
  }
  if (!same(behavior, prune(base.behavior))) {
    patch.behavior = behavior as PersonaPatch['behavior'];
  }

  const fallbacks: Record<string, Record<string, string | null>> = {};
  for (const slot of SLOTS) {
    const channel: Record<string, string | null> = {};
    const priv = fromFallbackField(draft.fallbacks[slot.key].private);
    const group = fromFallbackField(draft.fallbacks[slot.key].group);
    if (priv !== undefined) channel.private = priv;
    if (group !== undefined) channel.group = group;
    if (Object.keys(channel).length > 0) {
      fallbacks[slot.key] = channel;
    }
  }
  if (!same(fallbacks, prune(base.fallbacks))) {
    patch.fallbacks = fallbacks as PersonaPatch['fallbacks'];
  }

  if (draft.quoteTendency !== base.quoteTendency) {
    patch.quoteTendency = draft.quoteTendency;
  }

  return patch;
}

/** 服务端出参里没有 undefined，而前端会：比较前先剥掉空值，避免"没改也显示脏" */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        continue;
      }
      out[key] = prune(item);
    }
    return out;
  }
  return value;
}

const dirty = computed(() => {
  if (!current.value) {
    return false;
  }
  // buildPatch 依赖 reactive draft，这里读一次即可触发依赖收集
  void draft.name;
  void draft.behavior;
  return Object.keys(buildPatch()).length > 0;
});

async function save(): Promise<void> {
  const persona = current.value;
  if (!persona) {
    return;
  }
  if (!draft.name.trim()) {
    ElMessage.warning('人设名不能为空');
    return;
  }
  const patch = buildPatch();
  if (Object.keys(patch).length === 0) {
    ElMessage.info('没有改动');
    return;
  }
  saving.value = true;
  try {
    const updated = await api.personas.update(persona.id, patch);
    applyPersona(updated);
    await loadList(updated.id);
    ElMessage.success(
      updated.status === 'published'
        ? `已保存为第 ${updated.version} 版（线上立即生效）`
        : '草稿已保存',
    );
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
}

async function act(action: 'publish' | 'activate' | 'archive'): Promise<void> {
  const persona = current.value;
  if (!persona) {
    return;
  }
  busy.value = action;
  try {
    if (action === 'publish') {
      applyPersona(await api.personas.publish(persona.id));
      ElMessage.success('已发布');
    } else if (action === 'activate') {
      applyPersona(await api.personas.activate(persona.id));
      ElMessage.success('已设为当前生效人设');
    } else {
      await ElMessageBox.confirm(
        '归档会把它从实例上摘下来，之后不再生效（内容保留，可随时改回）。',
        '确认归档',
        { confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning' },
      );
      await api.personas.archive(persona.id);
      ElMessage.success('已归档');
    }
    await loadList(current.value?.id);
  } catch (err) {
    // 取消确认框也会走到这里；ElMessageBox 取消抛的是字符串
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(errorText(err));
    }
  } finally {
    busy.value = null;
  }
}

async function create(): Promise<void> {
  if (!newName.value.trim()) {
    ElMessage.warning('给它起个名字');
    return;
  }
  creating.value = true;
  try {
    const created = await api.personas.create(instanceId.value, { name: newName.value.trim() });
    createOpen.value = false;
    newName.value = '';
    await loadList(created.id);
    ElMessage.success('草稿已创建，写完内容再发布');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    creating.value = false;
  }
}

/** 还原到最近一次保存/加载的状态（按钮里不直接传 current，避免模板里的空值窄化问题） */
function revert(): void {
  if (current.value) {
    applyPersona(current.value);
  }
}

function addBoundary(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  if (value && !draft.boundaries.includes(value) && draft.boundaries.length < 30) {
    draft.boundaries.push(value);
  }
  input.value = '';
}

function removeBoundary(index: number): void {
  draft.boundaries.splice(index, 1);
}

function statusType(status: PersonaStatus): 'info' | 'success' | 'warning' {
  if (status === 'published') return 'success';
  if (status === 'archived') return 'warning';
  return 'info';
}

function statusText(status: PersonaStatus): string {
  if (status === 'published') return '已发布';
  if (status === 'archived') return '已归档';
  return '草稿';
}

const canActivate = computed(() => current.value?.status === 'published' && !current.value.active);
const activateHint = computed(() => {
  const persona = current.value;
  if (!persona) return '';
  if (persona.active) return '这就是当前生效的人设';
  if (persona.status !== 'published') return '草稿不能启用，先发布';
  return '设为这个实例当前生效的人设';
});
</script>

<template>
  <section class="page-wide">
    <header class="page-head">
      <div>
        <div class="crumb">
          <router-link :to="{ name: 'instances' }">实例</router-link>
          <span>/</span>
          <router-link :to="{ name: 'instance-settings', params: { id: instanceId } }">设置</router-link>
          <span>/</span>
          <span>人设</span>
        </div>
        <h1 class="page-title">人设</h1>
        <p class="page-desc">人格挂在这个实例上，换模型不会动它；草稿写完要先发布才能启用。</p>
      </div>
      <el-button @click="createOpen = true">新人设</el-button>
    </header>

    <div class="layout">
      <!-- 左：人设列表 -->
      <aside class="list-card card">
        <div class="list-head">
          <span>版本</span>
          <el-checkbox v-model="includeArchived" size="small">含归档</el-checkbox>
        </div>
        <ul v-loading="loading" class="list">
          <li
            v-for="item in personas"
            :key="item.id"
            :class="['list-item', { active: item.id === current?.id }]"
            @click="select(item)"
          >
            <div class="li-row">
              <span class="li-name">{{ item.name }}</span>
              <el-tag v-if="item.active" size="small" type="success" effect="dark">生效中</el-tag>
            </div>
            <div class="li-meta">
              <el-tag size="small" :type="statusType(item.status)" effect="plain">
                {{ statusText(item.status) }}
              </el-tag>
              <span class="mono">v{{ item.version }}</span>
            </div>
          </li>
          <li v-if="!loading && personas.length === 0" class="empty">还没有人设</li>
        </ul>
      </aside>

      <!-- 右：编辑器 -->
      <div v-if="current" class="editor">
        <div class="card card-pad sticky-bar">
          <div class="bar-main">
            <div class="bar-title">
              <span>{{ draft.name || '未命名' }}</span>
              <el-tag size="small" :type="statusType(current.status)" effect="plain">
                {{ statusText(current.status) }}
              </el-tag>
              <span class="mono muted">v{{ current.version }}</span>
              <span v-if="dirty" class="dirty-dot" title="有未保存的改动">未保存</span>
            </div>
            <p class="bar-hint">
              <template v-if="current.status === 'published'">
                保存会立即生效并升到 v{{ current.version + 1 }}（发布中的改动即新版）
              </template>
              <template v-else>{{ activateHint }}</template>
            </p>
          </div>
          <div class="bar-actions">
            <el-button :disabled="!dirty || saving" @click="revert">还原</el-button>
            <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">保存</el-button>
            <el-button
              v-if="current.status === 'draft'"
              :loading="busy === 'publish'"
              @click="act('publish')"
            >
              发布
            </el-button>
            <el-button
              v-if="current.status === 'published'"
              type="primary"
              plain
              :disabled="!canActivate"
              :loading="busy === 'activate'"
              @click="act('activate')"
            >
              {{ current.active ? '已启用' : '启用' }}
            </el-button>
            <el-button
              v-if="current.status !== 'archived'"
              type="danger"
              plain
              :loading="busy === 'archive'"
              @click="act('archive')"
            >
              归档
            </el-button>
          </div>
        </div>

        <!-- 基本 -->
        <div class="card card-pad">
          <h2 class="section-title">基本</h2>
          <p class="section-desc">这些会作为"你是谁"写进 system prompt，越具体越像人。</p>
          <div class="grid-2">
            <el-form-item label="人设名">
              <el-input v-model="draft.name" />
            </el-form-item>
            <el-form-item label="一句话定位">
              <el-input v-model="draft.tagline" placeholder="22 岁，话多、心软" />
            </el-form-item>
            <el-form-item label="头像 URL（可留空）" class="span-2">
              <el-input v-model="draft.avatar" placeholder="https://..." />
            </el-form-item>
          </div>

          <div class="grid-3">
            <el-form-item label="名字">
              <el-input v-model="draft.identity.name" />
            </el-form-item>
            <el-form-item label="年龄">
              <el-input v-model="draft.identity.age" />
            </el-form-item>
            <el-form-item label="性别">
              <el-input v-model="draft.identity.gender" />
            </el-form-item>
            <el-form-item label="身份 / 职业" class="span-2">
              <el-input v-model="draft.identity.role" placeholder="在读研究生 / 便利店店员" />
            </el-form-item>
            <el-form-item label="背景故事" class="span-3">
              <el-input
                v-model="draft.identity.background"
                type="textarea"
                :rows="4"
                maxlength="4000"
                show-word-limit
                placeholder="成长经历、在做什么、在意什么、说话习惯..."
              />
            </el-form-item>
          </div>
        </div>

        <!-- 提示块 -->
        <div class="card card-pad">
          <div class="card-head">
            <div>
              <h2 class="section-title">补充设定</h2>
              <p class="section-desc">按顺序拼进 prompt。关掉的块保留但不下发。</p>
            </div>
            <el-button size="small" @click="draft.promptBlocks.push({ title: '', content: '', enabled: true })">
              添加一块
            </el-button>
          </div>

          <div v-if="draft.promptBlocks.length === 0" class="empty-sm">还没有补充设定</div>

          <div v-for="(block, index) in draft.promptBlocks" :key="index" class="sub-block">
            <div class="sub-head">
              <el-input v-model="block.title" placeholder="标题（如：说话习惯）" size="small" style="max-width: 260px" />
              <div class="sub-tools">
                <el-switch v-model="block.enabled" size="small" />
                <el-button link type="danger" size="small" @click="draft.promptBlocks.splice(index, 1)">
                  删除
                </el-button>
              </div>
            </div>
            <el-input v-model="block.content" type="textarea" :rows="3" placeholder="这一块的正文" />
          </div>
        </div>

        <!-- 示例对话 -->
        <div class="card card-pad">
          <div class="card-head">
            <div>
              <h2 class="section-title">示例对话</h2>
              <p class="section-desc">比"请用轻松的语气"有效十倍：给两句真的对话。</p>
            </div>
            <el-button size="small" @click="draft.examples.push({ user: '', assistant: '' })">
              添加示例
            </el-button>
          </div>

          <div v-if="draft.examples.length === 0" class="empty-sm">还没有示例</div>

          <div v-for="(example, index) in draft.examples" :key="index" class="sub-block">
            <div class="sub-head">
              <span class="sub-label">示例 {{ index + 1 }}</span>
              <el-button link type="danger" size="small" @click="draft.examples.splice(index, 1)">
                删除
              </el-button>
            </div>
            <el-input v-model="example.user" type="textarea" :rows="2" placeholder="对方说的话" />
            <el-input
              v-model="example.assistant"
              type="textarea"
              :rows="2"
              placeholder="你（人设）的回复"
              style="margin-top: 8px"
            />
          </div>
        </div>

        <!-- 开场白 -->
        <div class="card card-pad">
          <h2 class="section-title">开场白</h2>
          <p class="section-desc">第一次说话时的措辞。留空则用默认。</p>
          <div class="grid-2">
            <el-form-item label="私聊第一句">
              <el-input v-model="draft.opening.private" placeholder="在的，怎么啦" />
            </el-form-item>
            <el-form-item label="群里被 @ 的第一句">
              <el-input v-model="draft.opening.groupMention" placeholder="嗯？叫我？" />
            </el-form-item>
            <el-form-item label="主动开口" class="span-2">
              <el-input v-model="draft.opening.proactive" placeholder="干嘛呢，一整天没动静" />
            </el-form-item>
          </div>
        </div>

        <!-- 软禁区 -->
        <div class="card card-pad">
          <h2 class="section-title">不想聊的话题</h2>
          <p class="section-desc">
            软禁区：可以绕开或含糊带过。<strong>红线不在这里</strong> —— 红线独立存放，人和反思都改不了。
          </p>
          <div class="tags">
            <el-tag
              v-for="(item, index) in draft.boundaries"
              :key="item"
              closable
              type="info"
              @close="removeBoundary(index)"
            >
              {{ item }}
            </el-tag>
            <input
              class="tag-input"
              placeholder="输入后回车添加，如：前任"
              :disabled="draft.boundaries.length >= 30"
              @keydown.enter.prevent="addBoundary"
            />
          </div>
        </div>

        <!-- 行为参数 -->
        <div class="card card-pad">
          <h2 class="section-title">行为参数</h2>
          <p class="section-desc">
            留空 = 用默认值（括号里是默认）。这些数字直接决定"回不回、回多快、拆几条"。
          </p>

          <h3 class="mini-title">发言决策</h3>
          <div class="grid-3">
            <el-form-item label="群聊阈值（0.55）">
              <el-input-number v-model="draft.behavior.attention.thresholdGroup" :min="0" :max="1" :step="0.05" style="width: 100%" />
              <div class="hint">越高越少说话。0.55 表示大部分群消息不回。</div>
            </el-form-item>
            <el-form-item label="私聊阈值（0.05）">
              <el-input-number v-model="draft.behavior.attention.thresholdPrivate" :min="0" :max="1" :step="0.05" style="width: 100%" />
            </el-form-item>
            <el-form-item label="忙碌阈值（0.78）">
              <el-input-number v-model="draft.behavior.attention.thresholdBusy" :min="0" :max="1" :step="0.05" style="width: 100%" />
            </el-form-item>
            <el-form-item label="基础唤醒（0.18）">
              <el-input-number v-model="draft.behavior.attention.base" :min="0" :max="1" :step="0.05" style="width: 100%" />
            </el-form-item>
            <el-form-item label="被 @ 权重（0.45）">
              <el-input-number v-model="draft.behavior.attention.mention" :min="0" :max="1" :step="0.05" style="width: 100%" />
            </el-form-item>
            <el-form-item label="亲密度权重（0.1）">
              <el-input-number v-model="draft.behavior.attention.affinity" :min="0" :max="1" :step="0.05" style="width: 100%" />
            </el-form-item>
          </div>

          <h3 class="mini-title">表达</h3>
          <div class="grid-3">
            <el-form-item label="每段字数（40）">
              <el-input-number v-model="draft.behavior.expression.maxCharsPerSegment" :min="10" :max="200" :step="5" style="width: 100%" />
            </el-form-item>
            <el-form-item label="最多几条（3）">
              <el-input-number v-model="draft.behavior.expression.maxSegments" :min="1" :max="6" style="width: 100%" />
            </el-form-item>
            <el-form-item label="打字速度 字/秒（4.5）">
              <el-input-number v-model="draft.behavior.expression.typingCps" :min="0.5" :max="50" :step="0.5" style="width: 100%" />
            </el-form-item>
          </div>
          <div class="inline-switch">
            <el-switch v-model="draft.behavior.expression.mentionBack" />
            <span>群里被 @ 时回 @（已有引用回复则自动跳过）</span>
          </div>
          <div class="inline-switch">
            <el-switch v-model="draft.behavior.thinkEnabled" />
            <span>先想再说（双阶段生成，每条消息两次调用，费钱但更像人）</span>
          </div>
        </div>

        <!-- 故障话术 -->
        <div class="card card-pad">
          <h2 class="section-title">故障话术</h2>
          <p class="section-desc">
            "未配置"走系统默认；"不说话"是明确装死（群里通常该这样）。
          </p>

          <div v-for="slot in SLOTS" :key="slot.key" class="fallback-row">
            <div class="fb-label">
              <div class="fb-name">{{ slot.label }}</div>
              <div class="hint">{{ slot.desc }}</div>
            </div>

            <div class="fb-fields">
              <div class="fb-channel">
                <span class="chan">私聊</span>
                <el-select v-model="draft.fallbacks[slot.key].private.mode" size="small" style="width: 100px">
                  <el-option label="默认" value="default" />
                  <el-option label="不说话" value="silent" />
                  <el-option label="自定义" value="custom" />
                </el-select>
                <el-input
                  v-if="draft.fallbacks[slot.key].private.mode === 'custom'"
                  v-model="draft.fallbacks[slot.key].private.text"
                  size="small"
                  placeholder="说这句"
                />
              </div>

              <div class="fb-channel">
                <span class="chan">群聊</span>
                <el-select v-model="draft.fallbacks[slot.key].group.mode" size="small" style="width: 100px">
                  <el-option label="默认" value="default" />
                  <el-option label="不说话" value="silent" />
                  <el-option label="自定义" value="custom" />
                </el-select>
                <el-input
                  v-if="draft.fallbacks[slot.key].group.mode === 'custom'"
                  v-model="draft.fallbacks[slot.key].group.text"
                  size="small"
                  placeholder="说这句"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="editor">
        <div class="card card-pad empty-state">
          <p>这个实例还没有人设。先建一个草稿，写完内容再发布启用。</p>
          <el-button type="primary" @click="createOpen = true">新人设</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="createOpen" title="新人设" width="380px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="人设名">
          <el-input v-model="newName" placeholder="小雅" @keyup.enter="create" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建草稿</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page-wide {
  padding: 24px 28px 60px;
}

.crumb {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--text-faint);
  font-size: 12px;
  margin-bottom: 4px;
}

.layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.list-card {
  position: sticky;
  top: 16px;
  overflow: hidden;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  padding: 10px 12px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 6px;
  max-height: calc(100vh - 160px);
  overflow: auto;
}

.list-item {
  border-radius: var(--radius-sm);
  cursor: pointer;
  padding: 8px 10px;
  transition: background 0.12s ease;
}

.list-item:hover {
  background: #f4f5f7;
}

.list-item.active {
  background: var(--accent-soft);
}

.li-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.li-name {
  font-weight: 600;
  font-size: 13px;
}

.li-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.muted {
  color: var(--text-faint);
}

.sticky-bar {
  position: sticky;
  top: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: rgb(255 255 255 / 92%);
  backdrop-filter: blur(6px);
}

.bar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
}

.bar-hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 11.5px;
}

.bar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.dirty-dot {
  background: #fdf6e7;
  border-radius: 999px;
  color: #8a6413;
  font-size: 10.5px;
  padding: 1px 7px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sub-block {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.sub-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sub-label {
  color: var(--text-muted);
  font-size: 12px;
}

.empty-sm {
  color: var(--text-faint);
  font-size: 12px;
  padding: 6px 0 2px;
}

.tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag-input {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 3px 10px;
  min-width: 160px;
  outline: none;
}

.tag-input:focus {
  border-color: var(--accent);
}

.mini-title {
  margin: 14px 0 10px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.mini-title:first-of-type {
  margin-top: 4px;
}

.inline-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12.5px;
  margin-top: 8px;
}

.fallback-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 16px;
  border-top: 1px solid var(--border);
  padding: 12px 0 14px;
}

.fb-name {
  font-size: 12.5px;
  font-weight: 600;
}

.fb-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-channel {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chan {
  color: var(--text-muted);
  font-size: 12px;
  width: 32px;
}

.span-3 {
  grid-column: span 3;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .list-card {
    position: static;
  }

  .sticky-bar {
    position: static;
  }

  .span-3 {
    grid-column: auto;
  }
}
</style>
