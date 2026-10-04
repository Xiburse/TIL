mod backend;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 非流式
            backend::commands::backend_status,
            backend::commands::backend_search,
            backend::commands::backend_image_detail,
            backend::commands::backend_top_tags,
            backend::commands::backend_collections,
            backend::commands::backend_collection_tags,
            // 流式（单飞）
            backend::commands::backend_delete,
            backend::commands::backend_ingest,
            backend::commands::backend_reindex,
            backend::commands::backend_verify,
            backend::commands::backend_check,
            // 取消
            backend::commands::backend_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
