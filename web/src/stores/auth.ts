/**
 * 登录态。
 *
 * 一处容易做错的地方：**"未登录"和"连不上服务"必须分开**。
 * 如果网络错误也当成 401，后端一重启用户就被踢回登录页，还得重新输密码 —— 而实际上
 * 会话 cookie 还在。所以只有真的 401 才清状态，其它错误只标记 `offline`。
 *
 * 第二处：`unlocked` 与 `user` 是两件事。
 * 服务重启后内存里的 DEK 没了，但会话仍有效：此时 `/api/auth/me` 返回 200 + `unlocked:false`。
 * 界面必须提示"重新解锁"，否则用户会以为"机器人不回消息"是别的原因。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { ApiError, api, errorText } from '@/api/client';
import type { MeResponse } from '@/api/types';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<MeResponse['user'] | null>(null);
  const unlocked = ref(false);
  const unlockExpiresAt = ref<string | null>(null);
  /** 是否已经问过一次后端：路由守卫靠它避免重复请求 */
  const checked = ref(false);
  /** 连不上服务时的提示（不是鉴权失败） */
  const offline = ref<string | null>(null);

  const isLoggedIn = computed(() => user.value !== null);

  async function refresh(): Promise<void> {
    try {
      const me = await api.auth.me();
      user.value = me.user;
      unlocked.value = me.unlocked;
      unlockExpiresAt.value = me.unlockExpiresAt;
      offline.value = null;
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) {
        user.value = null;
        unlocked.value = false;
        unlockExpiresAt.value = null;
      } else {
        // 网络问题：保留"看起来已登录"的状态，只提示连不上
        offline.value = errorText(err);
      }
    } finally {
      checked.value = true;
    }
  }

  async function login(username: string, password: string): Promise<void> {
    const result = await api.auth.login(username, password);
    user.value = { id: result.user.id, role: result.user.role, username: result.user.username };
    unlocked.value = result.unlocked;
    unlockExpiresAt.value = result.unlockExpiresAt;
    checked.value = true;
    offline.value = null;
  }

  async function unlock(password: string): Promise<void> {
    const result = await api.auth.unlock(password);
    unlocked.value = result.unlocked;
    unlockExpiresAt.value = result.expiresAt;
  }

  async function lock(): Promise<void> {
    await api.auth.lock();
    user.value = null;
    unlocked.value = false;
    unlockExpiresAt.value = null;
    checked.value = false;
  }

  return {
    user,
    unlocked,
    unlockExpiresAt,
    checked,
    offline,
    isLoggedIn,
    refresh,
    login,
    unlock,
    lock,
  };
});
