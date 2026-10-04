//! 后端调用层的错误类型。
//!
//! 分两个层次，别混：
//!
//! - **`BackendOutcome`（不是错误）** —— 后端跑完了，正常返回一行 result。
//!   哪怕 result 里 `ok: false`（配置错、SQL 错），那也是一次**成功的 IPC 往返**，
//!   走 `Ok(BackendOutcome)`。把这种情况变成 `Err` 会把 `error.code` 埋进
//!   JS 的异常里，前端反而不好用。
//! - **`BackendError`（这里）** —— **传输层**失败了：进程起不来、进程死了但没吐
//!   result、被 cancel 杀掉、单飞闸门挡住了。这时候根本没有 result 可谈。

use std::fmt;

use serde::ser::{Serialize, Serializer};

/// 后端调用层的传输层错误。
#[derive(Debug, Clone)]
pub enum BackendError {
    /// 起进程就失败了：python 不在 PATH、`root` 目录不存在、没有权限
    Spawn { message: String },

    /// 进程退出了，但一行 `result` 都没读到。
    ///
    /// 只有一种成因：Python 在 **import 期**就崩了 —— `backend/config.py` 的
    /// 模块级 `_CFG = _load_config()` 会在 config.toml 缺失/语法错/有未知键时
    /// 抛 `SystemExit`，此时 `backend.ipc` 根本没导入成功，
    /// `sys.exit(ipc.main())` 不会执行，stdout 上一个字节都没有。
    ///
    /// 运行**期**的错误不会走到这里：`ipc.main()` 把一切都包在 try 里，
    /// 连 `SystemExit` 都会被转成一行 `result`。
    NoResult {
        exit_code: Option<i32>,
        stderr: String,
    },

    /// 读到的行不是合法 JSON，或 result 信封缺字段
    Protocol { message: String, raw: String },

    /// 被 `backend_cancel` 杀掉了
    Cancelled { run_id: u64 },

    /// 已有流式任务在跑。两个 `ingest` 同时写 `tags.db` 和 `library/` 会坏事，
    /// Python 侧的 `reconcile` / `journal` 设计假设单写者。
    Busy { running: String },

    /// til.toml 本身有问题
    Config { message: String },
}

impl BackendError {
    /// 给前端看的形状。**故意压平**，不套 `{"Variant": {...}}` 那种外部标签 ——
    /// 前端 `catch` 到的应该是一个能直接读 `.kind` / `.message` 的对象。
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Self::Spawn { message } => json!({
                "kind": "spawn",
                "message": message,
            }),
            Self::NoResult { exit_code, stderr } => json!({
                "kind": "no_result",
                "message": format!(
                    "后端进程没输出结果就退出了（退出码 {}）。\
                     多半是 Python 侧 config.toml 有问题 —— 它是在模块导入期读的，\
                     出错时连一行 JSON 都来不及写。",
                    exit_code.map_or("未知".to_string(), |c| c.to_string())
                ),
                "exit_code": exit_code,
                // traceback 原样带上。这是「为什么起不来」的唯一线索。
                "stderr": stderr,
            }),
            Self::Protocol { message, raw } => json!({
                "kind": "protocol",
                "message": message,
                "raw": raw,
            }),
            Self::Cancelled { run_id } => json!({
                "kind": "cancelled",
                "message": "已取消。已经处理完的图片安全留在 library 里。",
                "run_id": run_id,
            }),
            Self::Busy { running } => json!({
                "kind": "busy",
                "message": format!("已经有一个 {running} 在跑了，等它结束或者先取消。"),
                "running": running,
            }),
            Self::Config { message } => json!({
                "kind": "config",
                "message": message,
            }),
        }
    }
}

// 手写 Serialize 而不是 derive：derive 会产出 `{"NoResult": {...}}` 这种外部
// 标签，前端用起来别扭。Tauri 会把 Err 里 Serialize 的值原样 reject 给 JS，
// 所以这里的形状就是前端 catch 到的形状。
impl Serialize for BackendError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = self.to_json();
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("error");
        let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
        // stderr 不进 Display（可能很长），完整内容在序列化结果里
        write!(f, "[{kind}] {msg}")
    }
}

impl std::error::Error for BackendError {}
