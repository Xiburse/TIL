# til

Tauri 2 + Vue 3 + TypeScript + Vite 桌面应用。

## 开发

```bash
pnpm install
pnpm tauri dev     # 启动桌面应用（会自动拉起 vite）
```

只调试前端界面时可以跑 `pnpm dev`，浏览器打开 http://localhost:1420。

## 构建

```bash
pnpm tauri build
```

## 结构

- `src/` — Vue 前端，`App.vue` 是根组件
- `src-tauri/` — Rust 端，`src/lib.rs` 里注册 Tauri 命令，`tauri.conf.json` 是应用配置
