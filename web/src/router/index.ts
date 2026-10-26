/**
 * 路由。
 *
 * - `createWebHistory`：地址栏是干净的 `/instances/xxx/settings`。
 *   代价是服务端必须把未知路径回落到 `index.html` —— 这一条在主服务的
 *   `serve-admin.ts` 里做了（只对 `Accept: text/html` 与 `/api` 之外的路径生效）。
 * - 守卫里只做一件事：没有会话就送去登录页。**不检查 unlocked**
 *   （服务重启后仍允许浏览列表，只有真正调用模型/读密钥的操作才会失败）。
 */

import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, title: '登录' },
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        { path: '', redirect: { name: 'instances' } },
        {
          path: 'instances',
          name: 'instances',
          component: () => import('@/views/InstancesView.vue'),
          meta: { title: '实例' },
        },
        {
          path: 'instances/:id/settings',
          name: 'instance-settings',
          component: () => import('@/views/InstanceSettingsView.vue'),
          meta: { title: '实例设置' },
        },
        {
          path: 'instances/:id/persona',
          name: 'instance-persona',
          component: () => import('@/views/PersonaEditorView.vue'),
          meta: { title: '人设' },
        },
        {
          path: 'instances/:id/assets',
          name: 'instance-assets',
          component: () => import('@/views/AssetsView.vue'),
          meta: { title: '素材库' },
        },
        {
          path: 'credentials',
          name: 'credentials',
          component: () => import('@/views/CredentialsView.vue'),
          meta: { title: '密钥' },
        },
        {
          path: 'users',
          name: 'users',
          component: () => import('@/views/UsersView.vue'),
          // 只有 superadmin 能进。后端每个接口也会再校验一次（界面只是少一次 403）
          meta: { title: '用户', adminOnly: true },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'instances' } },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) {
    await auth.refresh();
  }
  if (to.meta.public) {
    // 已登录还去登录页：直接回列表，避免"登录成功后又看到登录表单"
    return auth.isLoggedIn ? { name: 'instances' } : true;
  }
  if (!auth.isLoggedIn) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  if (to.meta.adminOnly && !auth.isSuperadmin) {
    // 普通用户手敲 URL：安静地送回列表，不弹错（弹错等于告诉他"这里有个管理页"）
    return { name: 'instances' };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : null;
  document.title = title ? `${title} · 管理后台` : '管理后台';
});
