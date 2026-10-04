import { createApp } from "vue";
import { createPinia } from 'pinia'

import App from "./App.vue";
// 全局配色配置：换主题只改这个文件里那一行 @import 的文件名
import "./theme.css";

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.mount('#app')
