<script setup lang="ts">
/**
 * 登录页。
 *
 * 这里没有"记住我"、没有第三方登录、也没有注册入口 —— 后台是自用部署，
 * 账号由首次启动时的 `BOOTSTRAP_ADMIN_*` 建出来（见 AGENTS.md）。
 *
 * 登录即解锁：一个请求同时完成"验密码"和"解出 DEK"（D005），
 * 所以页面上**不要**再加第二步解锁表单。
 */
import { ElMessage } from 'element-plus';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { errorText } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  error.value = null;
  if (!username.value || !password.value) {
    error.value = '请输入账号与密码';
    return;
  }
  submitting.value = true;
  try {
    await auth.login(username.value.trim(), password.value);
    password.value = '';
    ElMessage.success('登录成功');
    const next = typeof route.query.next === 'string' ? route.query.next : null;
    await router.replace(next && next.startsWith('/') ? next : { name: 'instances' });
  } catch (err) {
    error.value = errorText(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="panel">
      <div class="head">
        <span class="mark">A</span>
        <h1>接入管理</h1>
        <p>配置实例、人设与密钥。密钥明文只用你的密码解开，服务端不保存它。</p>
      </div>

      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span>账号</span>
          <el-input v-model="username" size="large" placeholder="admin" autocomplete="username" />
        </label>

        <label class="field">
          <span>密码</span>
          <el-input
            v-model="password"
            type="password"
            size="large"
            placeholder="登录密码"
            show-password
            autocomplete="current-password"
          />
        </label>

        <p v-if="error" class="error">{{ error }}</p>

        <el-button type="primary" size="large" native-type="submit" :loading="submitting" class="submit">
          登录
        </el-button>
      </form>

      <p class="foot">
        首次使用请用启动时设置的管理员账号登录；忘记密码只能走"重置密码"（会同时销毁已保存的密钥密文）。
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 32px 16px;
  background:
    radial-gradient(1200px 420px at 50% -160px, #e9e9fb 0%, transparent 70%),
    var(--bg);
}

.panel {
  width: 100%;
  max-width: 372px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-md);
  padding: 26px 26px 20px;
}

.head {
  margin-bottom: 20px;
}

.mark {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  margin-bottom: 12px;
}

.head h1 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.head p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field > span {
  color: var(--text-muted);
  font-size: 12px;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 12.5px;
}

.submit {
  width: 100%;
  margin-top: 4px;
}

.foot {
  margin: 16px 0 0;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.55;
}
</style>
