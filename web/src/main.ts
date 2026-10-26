import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import { createApp } from 'vue';

import 'element-plus/dist/index.css';
import './styles.css';

import App from './App.vue';
import { router } from './router';

const app = createApp(App);

// Element Plus 全量注册。
// 按需引入要配 unplugin-vue-components，多两个构建期依赖；管理端首屏不是瓶颈，
// 先用最不容易出错的方式，等真需要优化体积再换（那时是纯构建改动，不动业务代码）。
app.use(ElementPlus);
app.use(createPinia());
app.use(router);
app.mount('#app');
