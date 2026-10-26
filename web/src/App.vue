<script setup lang="ts">
/**
 * 根组件只做一件事：给路由出口。
 * 外壳（侧边栏、解锁条）在 AppLayout 里 —— 登录页不该有导航。
 */
</script>

<template>
  <router-view />
</template>
