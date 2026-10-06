import { createApp } from "vue";
import { createPinia } from 'pinia'

import App from "./App.vue";
// 全局配色配置：换主题只改这个文件里那一行 @import 的文件名
import "./theme.css";
// 共享的进出场动画预设（emerge）。全局样式，用法见该文件头
import "./styles/emerge.css";
// 两块面板共用的外壳几何（箭头 / 圆角 / 滚动区）。
// ⚠ 它**只是 CSS** —— 别再抽成壳组件，那会让退场动画失效（推导见该文件头）
import "./styles/panel.css";

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.mount('#app')
