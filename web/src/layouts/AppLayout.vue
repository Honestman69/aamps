<script setup lang="ts">
/**
 * 后台外壳：左侧导航 + 顶部状态条。
 *
 * 顶部那条"需要重新解锁"不是装饰：服务重启后内存里的 DEK 没了，会话却还有效，
 * 此时所有模型调用都会失败（表现为"机器人不回消息"）。把这个状态显式摆出来，
 * 用户才知道要重新输一次密码，而不是去查模型配置。
 */
import { ElMessage } from 'element-plus';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { errorText } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();

const password = ref('');
const unlocking = ref(false);

const username = computed(() => auth.user?.username ?? '未知账号');

const expiresText = computed(() => {
  if (!auth.unlockExpiresAt) {
    return null;
  }
  const at = new Date(auth.unlockExpiresAt);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return at.toLocaleString('zh-CN', { hour12: false });
});

async function submitUnlock(): Promise<void> {
  if (!password.value) {
    ElMessage.warning('请输入密码');
    return;
  }
  unlocking.value = true;
  try {
    await auth.unlock(password.value);
    password.value = '';
    ElMessage.success('已解锁');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    unlocking.value = false;
  }
}

async function lock(): Promise<void> {
  try {
    await auth.lock();
    await router.push({ name: 'login' });
  } catch (err) {
    ElMessage.error(errorText(err));
  }
}
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <span class="brand-mark">A</span>
        <span class="brand-text">
          <strong>接入管理</strong>
          <small>AI Agent</small>
        </span>
      </div>

      <nav class="nav">
        <router-link class="nav-item" :to="{ name: 'instances' }">实例</router-link>
        <router-link class="nav-item" :to="{ name: 'credentials' }">密钥</router-link>
      </nav>

      <div class="side-foot">
        <div class="who">
          <span
            class="dot"
            :class="auth.unlocked ? 'dot-ok' : 'dot-warn'"
            :title="auth.unlocked ? `解锁有效期至 ${expiresText ?? '未知'}` : '未解锁：机器人不会回复'"
          />
          <span>{{ username }}</span>
        </div>
        <button class="link-btn" type="button" @click="lock">锁定并退出</button>
      </div>
    </aside>

    <main class="main">
      <div v-if="auth.offline" class="banner banner-err">
        连不上服务：{{ auth.offline }}
      </div>

      <div v-else-if="!auth.unlocked" class="banner banner-warn">
        <span>
          <strong>密钥库已锁定。</strong>
          服务重启或解锁过期后需要重新输入密码，否则机器人不会回复消息。
        </span>
        <div class="banner-form">
          <el-input
            v-model="password"
            type="password"
            placeholder="登录密码"
            show-password
            size="small"
            style="width: 180px"
            @keyup.enter="submitUnlock"
          />
          <el-button type="primary" size="small" :loading="unlocking" @click="submitUnlock">
            解锁
          </el-button>
        </div>
      </div>

      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100%;
}

.side {
  display: flex;
  width: 196px;
  flex: 0 0 196px;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--surface);
  padding: 18px 12px 14px;
  position: sticky;
  top: 0;
  height: 100vh;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 18px;
}

.brand-mark {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: 13px;
  font-weight: 650;
}

.brand-text small {
  color: var(--text-faint);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13px;
  padding: 7px 10px;
  transition: background 0.12s ease, color 0.12s ease;
}

.nav-item:hover {
  background: #f2f3f5;
  color: var(--text);
}

.nav-item.router-link-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.side-foot {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding: 12px 8px 0;
}

.who {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.dot-ok {
  background: var(--ok);
}

.dot-warn {
  background: var(--warn);
}

.link-btn {
  margin-top: 6px;
  border: 0;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 11.5px;
  padding: 0;
}

.link-btn:hover {
  color: var(--danger);
}

.main {
  flex: 1;
  min-width: 0;
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 28px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}

.banner-warn {
  background: #fdf6e7;
  color: #7a5b13;
}

.banner-err {
  background: #fdecec;
  color: #8c2b2b;
}

.banner-ok {
  background: #f1f8f4;
  color: #276749;
}

.banner-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
</style>
