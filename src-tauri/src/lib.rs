mod backend;
mod thumbs;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // app_config_dir 是 til.toml 查找链的第三级（前两级是 TIL_CONFIG
            // 环境变量和 exe 所在目录，最后一级是编译期内嵌的那份）。
            // 取不到就跳过这一级 —— 不该因为路径 API 失败就起不来。
            let config_dir = app.path().app_config_dir().ok();
            let state = backend::BackendState::load(config_dir.as_deref())?;
            app.manage(state);

            // 缩略图缓存：建目录 + 开索引库 + 把缓存目录加进 asset 协议白名单。
            //
            // **三步里任何一步失败都不算致命**：不 manage 这个状态，`thumb_get`
            // 就会返回错误，前端退回加载原图（见 `src/modules/thumb.ts`）。
            // 缓存坏了顶多是慢，不该让整个应用起不来。
            let thumbs = thumbs::init(app.handle()).and_then(|state| {
                // ⚠ 缓存目录在 app_cache_dir 下，**不在** tauri.conf.json 配的
                // `E:/Images/**` 里。不放行的话 `convertFileSrc` 出来的 asset://
                // 地址会被协议层挡掉，缩略图静默加载失败（页面上一片破图标）——
                // 所以放行失败也按「没有缓存」处理，而不是硬着头皮 manage 进去。
                app.asset_protocol_scope()
                    .allow_directory(state.root(), true)?;
                Ok(state)
            });
            match thumbs {
                // `manage` 返回「是不是新插进去的」，这里不关心
                Ok(state) => {
                    app.manage(state);
                }
                Err(e) => {
                    eprintln!("缩略图缓存不可用，本次运行退回加载原图：{e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 非流式
            backend::commands::backend_status,
            backend::commands::backend_search,
            backend::commands::backend_image_detail,
            backend::commands::backend_top_tags,
            backend::commands::backend_tag_suggest,
            backend::commands::backend_collections,
            backend::commands::backend_collection_tags,
            backend::commands::backend_inbox_scan,
            // 流式（单飞）
            backend::commands::backend_delete,
            backend::commands::backend_ingest,
            backend::commands::backend_reindex,
            backend::commands::backend_verify,
            backend::commands::backend_check,
            // 取消
            backend::commands::backend_cancel,
            // 缩略图缓存（不走 Python 后端，纯 Rust）
            thumbs::thumb_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
