<script setup lang="ts">
/**
 * 用户管理（仅 superadmin，D042）。
 *
 * 这页要回答的核心问题不是"有哪些账号"，而是**"这个人还能不能登录、他的 Key 还在不在"**：
 *   - `dekInitialized = false` 表示他从没登录过（或密码被重置过）——
 *     此时他的 API Key 一个都解不开，机器人不会回消息，这不是故障而是预期；
 *   - 停用会**立刻**撤销他的会话并清掉内存里的 DEK，所以界面要明说"他会被踢下线"，
 *     而不是让人以为只是"下次不能登录"。
 *
 * 界面刻意不给"编辑自己"的入口：停用/降级自己会把自己锁在门外，
 * 后端也会 403（`isSelf` 用来把按钮提前置灰，省得点了才知道）。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { api, errorText } from '@/api/client';
import type { AdminUser } from '@/api/types';

const loading = ref(false);
const busyId = ref<string | null>(null);
const users = ref<AdminUser[]>([]);

const createOpen = ref(false);
const creating = ref(false);
const form = reactive({
  username: '',
  displayName: '',
  password: '',
  role: 'user' as 'user' | 'superadmin',
});

const resetOpen = ref(false);
const resetting = ref(false);
const resetTarget = ref<AdminUser | null>(null);
const resetForm = reactive({ newPassword: '', confirmUsername: '' });

async function load(): Promise<void> {
  loading.value = true;
  try {
    users.value = await api.admin.users();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(): void {
  form.username = '';
  form.displayName = '';
  form.password = '';
  form.role = 'user';
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (!form.username.trim()) {
    ElMessage.warning('用户名不能为空');
    return;
  }
  if (form.password.length < 12) {
    ElMessage.warning('密码至少 12 位');
    return;
  }
  creating.value = true;
  try {
    const result = await api.admin.createUser({
      username: form.username.trim().toLowerCase(),
      displayName: form.displayName.trim() || null,
      password: form.password,
      role: form.role,
    });
    createOpen.value = false;
    ElMessage.success(
      result.role === 'superadmin' ? '已创建管理员账号' : '已创建账号（首次登录时会生成他的密钥库）',
    );
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    creating.value = false;
  }
}

async function toggleStatus(row: AdminUser, value: boolean): Promise<void> {
  const next = value ? 'active' : 'disabled';
  if (next === 'disabled') {
    try {
      await ElMessageBox.confirm(
        `停用「${row.username}」会立刻把他踢下线，并清掉内存里的密钥库（机器人不再替他回消息）。` +
          '重新启用后可以正常登录，Key 不受影响。',
        '确认停用',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  busyId.value = row.id;
  try {
    const result = await api.admin.updateUser(row.id, { status: next });
    row.status = next;
    ElMessage.success(
      next === 'disabled'
        ? `已停用${result.revokedSessions > 0 ? `，踢下线 ${result.revokedSessions} 个会话` : ''}`
        : '已启用',
    );
  } catch (err) {
    ElMessage.error(errorText(err));
    await load();
  } finally {
    busyId.value = null;
  }
}

async function changeRole(row: AdminUser, value: string): Promise<void> {
  const role = value === 'superadmin' ? 'superadmin' : 'user';
  if (role === row.role) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      role === 'superadmin'
        ? `把「${row.username}」提升为管理员：他能看见用户列表、重置任何人密码、查审计。`
        : `把「${row.username}」降为普通用户：他会失去所有管理权限，并被踢下线重新登录。`,
      role === 'superadmin' ? '确认提升' : '确认降级',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    );
  } catch {
    await load();
    return;
  }
  busyId.value = row.id;
  try {
    const result = await api.admin.updateUser(row.id, { role });
    row.role = role;
    ElMessage.success(result.revokedSessions > 0 ? '已修改，对方需要重新登录' : '已修改');
  } catch (err) {
    ElMessage.error(errorText(err));
    await load();
  } finally {
    busyId.value = null;
  }
}

function openReset(row: AdminUser): void {
  resetTarget.value = row;
  resetForm.newPassword = '';
  resetForm.confirmUsername = '';
  resetOpen.value = true;
}

async function submitReset(): Promise<void> {
  const target = resetTarget.value;
  if (!target) {
    return;
  }
  if (resetForm.newPassword.length < 12) {
    ElMessage.warning('密码至少 12 位');
    return;
  }
  if (resetForm.confirmUsername.trim() !== target.username) {
    ElMessage.warning('请把目标用户名再输一遍，防止点错人');
    return;
  }
  resetting.value = true;
  try {
    const result = await api.admin.resetPassword(target.id, {
      newPassword: resetForm.newPassword,
      confirmUsername: resetForm.confirmUsername.trim(),
    });
    resetOpen.value = false;
    ElMessage.success(
      `已重置。该账号的 ${result.disabledCredentials} 个 Key 已停用，需要他重新录入`,
    );
    await load();
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    resetting.value = false;
  }
}

/** 显示名与用户名相同（种子账号就是这样）时不再重复一遍，写"未设置"更像实话 */
function subtitleOf(row: AdminUser): string {
  const name = row.displayName?.trim();
  if (!name || name === row.username) {
    return '未设置显示名';
  }
  return name;
}

function roleLabel(role: string): string {
  return role === 'superadmin' ? '管理员' : '普通用户';
}

function lastLoginText(value: string | null): string {
  if (!value) {
    return '从未登录';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

const hasSelf = computed(() => users.value.some((user) => user.isSelf));
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">用户</h1>
        <p class="page-desc">
          一个账号 = 一份密钥库。两个人各自登录、各自解锁，彼此看不到对方的实例、人设与 Key。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">新建账号</el-button>
    </header>

    <div class="card">
      <el-table v-loading="loading" :data="users" style="width: 100%" :border="false">
        <el-table-column label="账号" min-width="200">
          <template #default="{ row }">
            <div class="cell-title">
              {{ row.username }}
              <el-tag v-if="row.isSelf" size="small" type="info" class="self-tag">你</el-tag>
            </div>
            <div class="cell-sub">{{ subtitleOf(row) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="角色" width="150">
          <template #default="{ row }">
            <el-select
              :model-value="row.role"
              size="small"
              :disabled="row.isSelf || busyId === row.id"
              @update:model-value="(value: string) => changeRole(row, value)"
            >
              <el-option label="普通用户" value="user" />
              <el-option label="管理员" value="superadmin" />
            </el-select>
            <div class="cell-sub muted">{{ roleLabel(row.role) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-switch
              :model-value="row.status === 'active'"
              :loading="busyId === row.id"
              :disabled="row.isSelf"
              @update:model-value="(value: string | number | boolean) => toggleStatus(row, Boolean(value))"
            />
            <div class="cell-sub">
              <span class="dot" :class="row.status === 'active' ? 'dot-ok' : 'dot-idle'" />
              {{ row.status === 'active' ? '可用' : '已停用' }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="密钥库" width="130">
          <template #default="{ row }">
            <div class="cell-title">{{ row.dekInitialized ? '已初始化' : '未初始化' }}</div>
            <div class="cell-sub muted">
              {{ row.dekInitialized ? `v${row.dekVersion}` : '首次登录时生成' }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="最后登录" width="170">
          <template #default="{ row }">
            <div class="cell-sub">{{ lastLoginText(row.lastLoginAt) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-button link type="danger" :disabled="row.isSelf" @click="openReset(row)">
              重置密码
            </el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty">
            只有你自己一个账号。想让家人/朋友各用各的人格与 Key，就在这里建一个普通用户。
          </div>
        </template>
      </el-table>
    </div>

    <!-- 新建 -->
    <el-dialog v-model="createOpen" title="新建账号" width="480px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="登录用，小写字母 / 数字 / _ . -" />
          <div class="hint">建好后不能改（它是登录入口）。</div>
        </el-form-item>

        <el-form-item label="显示名">
          <el-input v-model="form.displayName" placeholder="后台里怎么称呼，可留空" />
        </el-form-item>

        <el-form-item label="初始密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 12 位" />
          <div class="hint">
            密码只用于派生他自己的密钥库（服务端不存明文）。忘了只能重置，而重置会让他的 Key 全部失效。
          </div>
        </el-form-item>

        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option label="普通用户（只有自己的数据）" value="user" />
            <el-option label="管理员（额外可管用户、重置密码、查审计）" value="superadmin" />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="resetOpen" title="重置密码" width="480px" :close-on-click-modal="false">
      <p class="warn-line">
        重置会销毁 {{ resetTarget?.username }} 的密钥库，他的 API Key 将全部失效、需要重新录入。
        这是不可逆的。
      </p>
      <el-form label-position="top">
        <el-form-item label="新密码">
          <el-input v-model="resetForm.newPassword" type="password" show-password placeholder="至少 12 位" />
        </el-form-item>
        <el-form-item :label="`再输一遍目标用户名（${resetTarget?.username ?? ''}）`">
          <el-input v-model="resetForm.confirmUsername" placeholder="防止点错人" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="resetOpen = false">取消</el-button>
        <el-button type="danger" :loading="resetting" @click="submitReset">确认重置</el-button>
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

.cell-sub.muted {
  color: var(--text-faint);
}

.self-tag {
  margin-left: 6px;
  vertical-align: middle;
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

.dot-idle {
  background: var(--border-strong);
}

.warn-line {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: #fdf3f3;
  border: 1px solid #f4d3d3;
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
