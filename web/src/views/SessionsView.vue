<script setup lang="ts">
/**
 * 会话记录（D043）：机器人到底跟谁说了什么。
 *
 * 这一页存在的理由很具体：出问题时（"它怎么这么说话""为什么没回我"）只能看记录。
 * 所以它必须是**只读**的 —— 没有删除、没有编辑，只有"看"和"往前翻"。
 *
 * 两栏：左边是会话（跟谁聊过、聊了多少条），右边是消息流。
 * 消息里的内心独白默认折叠：那是排查用的东西，平时看聊天不该被它干扰。
 */
import { ElMessage } from 'element-plus';
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, errorText } from '@/api/client';
import type { SessionMessage, SessionSummary } from '@/api/types';

const route = useRoute();
const router = useRouter();

const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(true);
const sessions = ref<SessionSummary[]>([]);
const total = ref(0);
const activeId = ref<string | null>(null);

const messages = ref<SessionMessage[]>([]);
/** 气泡区容器：打开会话后要滚到最底部（聊天记录默认看最新一句） */
const bubblesRef = ref<HTMLElement | null>(null);
const loadingMessages = ref(false);
const hasMore = ref(false);

const active = computed(() => sessions.value.find((item) => item.id === activeId.value) ?? null);

async function loadSessions(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.sessions.list(instanceId.value, { limit: 100 });
    sessions.value = result.items;
    total.value = result.total;
    // 默认打开最近聊过的那个会话：进来就能看到东西，比自己点一下更合理
    if (!activeId.value && result.items.length > 0) {
      await openSession(result.items[0]!.id);
    }
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

async function openSession(sessionId: string): Promise<void> {
  activeId.value = sessionId;
  messages.value = [];
  hasMore.value = false;
  loadingMessages.value = true;
  try {
    const page = await api.sessions.messages(sessionId, { limit: 50 });
    messages.value = page.items;
    hasMore.value = page.hasMore;
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loadingMessages.value = false;
  }
}

/** 滚到底部：进会话第一眼该看到最新那句，而不是几小时前的开头 */
async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = bubblesRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/** 往前翻：游标是当前最早那条的 id（服务端按 (时间, id) 定位，不会漏同一毫秒的消息） */
async function loadOlder(): Promise<void> {
  const sessionId = activeId.value;
  const earliest = messages.value[0];
  if (!sessionId || !earliest || loadingMessages.value) {
    return;
  }
  loadingMessages.value = true;
  try {
    const page = await api.sessions.messages(sessionId, { limit: 50, before: earliest.id });
    messages.value = [...page.items, ...messages.value];
    hasMore.value = page.hasMore;
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loadingMessages.value = false;
  }
}

watch(instanceId, () => {
  activeId.value = null;
  void loadSessions();
});

void loadSessions();

function timeText(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function dayText(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN');
}

/** 会话标题：群名 / 昵称，都没有就退回到平台 id */
function titleOf(session: SessionSummary): string {
  return session.peerName?.trim() || `${session.kind === 'group' ? '群' : '用户'} ${session.peerId}`;
}

const MEDIA_TEXT: Record<string, string> = {
  image: '图片',
  voice: '语音',
  at: '@',
  reply: '引用',
  face: '表情',
  file: '文件',
  video: '视频',
};

function mediaLabel(type: string): string {
  return MEDIA_TEXT[type] ?? type;
}

/** 相邻消息是否同一人挨着发的：气泡贴在一起比每条都带名字更像聊天 */
function grouped(index: number): boolean {
  const current = messages.value[index];
  const previous = messages.value[index - 1];
  if (!current || !previous) {
    return false;
  }
  return previous.role === current.role && previous.senderName === current.senderName;
}

function canShowDay(index: number): boolean {
  const current = messages.value[index];
  const previous = messages.value[index - 1];
  if (!current) {
    return false;
  }
  if (!previous) {
    return true;
  }
  return dayText(previous.createdAt) !== dayText(current.createdAt);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <div class="crumb">
          <router-link :to="{ name: 'instances' }">实例</router-link>
          <span>/</span>
          <span>会话记录</span>
        </div>
        <h1 class="page-title">会话</h1>
        <p class="page-desc">
          这里只是<b>看</b>：消息一旦落库就不再修改。出问题时先看它到底收到了什么、回了什么。
        </p>
      </div>
      <el-button :loading="loading" @click="loadSessions">刷新</el-button>
    </header>

    <div class="split">
      <!-- 左：会话列表 -->
      <div class="card list">
        <div class="list-head">
          <span>会话</span>
          <span class="muted">
            {{ sessions.length }}<template v-if="total > sessions.length"> / {{ total }}</template> 个
          </span>
        </div>

        <div v-if="sessions.length === 0 && !loading" class="empty">
          还没有任何会话。等它在 QQ 里收到第一条消息，这里就会出现。
        </div>

        <button
          v-for="session in sessions"
          :key="session.id"
          type="button"
          class="session"
          :class="{ active: session.id === activeId }"
          @click="openSession(session.id)"
        >
          <div class="session-top">
            <span class="session-title">
              <span class="badge" :class="session.kind === 'group' ? 'badge-group' : 'badge-private'">
                {{ session.kind === 'group' ? '群' : '私' }}
              </span>
              {{ titleOf(session) }}
            </span>
            <span class="session-time">{{ timeText(session.lastActiveAt) }}</span>
          </div>
          <div class="session-sub">
            {{ session.messageCount }} 条
            <span v-if="session.lastMessage">· {{ session.lastMessage.content }}</span>
            <span v-else class="muted">· 还没有消息</span>
          </div>
          <div v-if="session.aiPaused || session.muted" class="session-flags">
            <span v-if="session.aiPaused" class="flag">人工接管中</span>
            <span v-if="session.muted" class="flag">已静默</span>
          </div>
        </button>
      </div>

      <!-- 右：消息流 -->
      <div class="card stream">
        <div v-if="!active" class="empty">左边选一个会话</div>

        <template v-else>
          <div class="stream-head">
            <div>
              <div class="cell-title">{{ titleOf(active) }}</div>
              <div class="cell-sub muted">
                {{ active.kind === 'group' ? '群聊' : '私聊' }} · peer {{ active.peerId }} ·
                {{ active.messageCount }} 条
              </div>
            </div>
            <el-button v-if="hasMore" size="small" :loading="loadingMessages" @click="loadOlder">
              加载更早
            </el-button>
          </div>

          <div ref="bubblesRef" v-loading="loadingMessages" class="bubbles">
            <template v-for="(message, index) in messages" :key="message.id">
              <div v-if="canShowDay(index)" class="day">{{ dayText(message.createdAt) }}</div>

              <div class="row" :class="message.role === 'user' ? 'row-left' : 'row-right'">
                <div class="bubble-wrap">
                  <div v-if="!grouped(index)" class="who">
                    {{ message.role === 'assistant' ? '机器人' : message.senderName || '对方' }}
                    <span class="muted"> · {{ timeText(message.createdAt) }}</span>
                  </div>

                  <div class="bubble" :class="message.role === 'user' ? 'bubble-in' : 'bubble-out'">
                    <div class="content">{{ message.content }}</div>

                    <div v-if="message.media.length > 0" class="media">
                      <span v-for="type in message.media" :key="type" class="tag">
                        {{ mediaLabel(type) }}
                      </span>
                    </div>

                    <div v-if="message.blocked" class="blocked">
                      被拦截<span v-if="message.blockReason"> · {{ message.blockReason }}</span>
                    </div>

                    <!-- 内心独白：默认折叠，排查时才展开 -->
                    <details v-if="message.think" class="think">
                      <summary>内心独白</summary>
                      <div class="think-body">
                        <div v-if="message.think.intent">
                          <span class="k">意图</span>{{ message.think.intent }}
                        </div>
                        <div v-if="message.think.tone">
                          <span class="k">语气</span>{{ message.think.tone }}
                        </div>
                        <div v-if="message.think.lengthHint">
                          <span class="k">长度</span>{{ message.think.lengthHint }}
                        </div>
                        <div v-if="message.think.keyPoints.length > 0">
                          <span class="k">要点</span>{{ message.think.keyPoints.join(' / ') }}
                        </div>
                        <div class="muted small">
                          想回 {{ (message.think.wantToReply * 100).toFixed(0) }}% · 情绪
                          {{ message.think.emotionShift > 0 ? '+' : '' }}{{ message.think.emotionShift.toFixed(2) }}
                        </div>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            </template>

            <div v-if="messages.length === 0 && !loadingMessages" class="empty">
              这个会话还没有消息
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

@media (max-width: 1000px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

.list {
  padding: 6px;
  max-height: calc(100vh - 220px);
  overflow: auto;
}

.list-head {
  display: flex;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.session {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 8px 10px;
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.session:hover {
  background: #f7f8fa;
}

.session.active {
  background: #eef3ff;
  border-color: #d6e2ff;
}

.session-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.session-title {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-time {
  color: var(--text-faint);
  font-size: 11px;
  flex-shrink: 0;
}

.session-sub {
  color: var(--text-muted);
  font-size: 11.5px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-flags {
  margin-top: 4px;
}

.flag {
  display: inline-block;
  font-size: 10.5px;
  color: var(--warn);
  background: #fff8e6;
  border: 1px solid #f5e3b3;
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 4px;
}

.badge {
  display: inline-block;
  font-size: 10px;
  border-radius: 4px;
  padding: 1px 4px;
  margin-right: 4px;
  vertical-align: middle;
}

.badge-group {
  background: #eef3ff;
  color: #3c62d9;
}

.badge-private {
  background: #f2f4f7;
  color: var(--text-muted);
}

.stream {
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 220px);
}

.stream-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.bubbles {
  padding: 14px;
  overflow: auto;
  flex: 1;
}

.day {
  text-align: center;
  color: var(--text-faint);
  font-size: 11px;
  margin: 10px 0;
}

.row {
  display: flex;
  margin-bottom: 8px;
}

.row-left {
  justify-content: flex-start;
}

.row-right {
  justify-content: flex-end;
}

.bubble-wrap {
  max-width: 78%;
}

.who {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0 4px 3px;
  /* 名字 + 时间不折行：折成两行会让相邻气泡的高度看起来参差 */
  white-space: nowrap;
}

.bubble {
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.65;
}

.bubble-in {
  background: #f4f5f7;
  border: 1px solid var(--border);
}

.bubble-out {
  background: #eef3ff;
  border: 1px solid #d6e2ff;
}

.content {
  white-space: pre-wrap;
  word-break: break-word;
}

.media {
  margin-top: 4px;
}

.tag {
  display: inline-block;
  font-size: 10.5px;
  color: var(--text-muted);
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 4px;
}

.blocked {
  margin-top: 4px;
  font-size: 11px;
  color: var(--danger);
}

.think {
  margin-top: 6px;
  border-top: 1px dashed var(--border);
  padding-top: 5px;
}

.think summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-faint);
  list-style: none;
}

.think-body {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.7;
}

.think-body .k {
  display: inline-block;
  color: var(--text-faint);
  margin-right: 6px;
  min-width: 28px;
}

.small {
  font-size: 10.5px;
}

.cell-title {
  font-weight: 600;
  color: var(--text);
}

.cell-sub {
  font-size: 11.5px;
  margin-top: 2px;
}

.muted {
  color: var(--text-faint);
}

.empty {
  color: var(--text-faint);
  font-size: 12px;
  padding: 16px 10px;
  text-align: center;
}
</style>
