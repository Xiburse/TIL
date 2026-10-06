//! Python 后端的调用层。
//!
//! 契约文档：`E:\Images\API.md`（**会持续演进，动这层之前先读一遍**）。
//!
//! 整体结构：
//!
//! ```text
//! commands.rs   13 条 Tauri command + cancel，薄封装
//!     ↓
//! mod.rs        BackendState：配置 + 流式单飞闸门 + 限流闸门 + run_id 分配
//!     ↓
//! runner.rs     起进程、双线程读、收尾、kill
//!     ↓
//! protocol.rs   信封与参数类型        config.rs  til.toml 的读取与查找
//! throttle.rs   按命令限流（tag_suggest 用）—— 和上面几层无耦合，谁都能拿
//! ```

pub mod commands;
pub mod config;
pub mod error;
pub mod protocol;
pub mod runner;
pub mod throttle;

use throttle::Throttle;

use std::path::Path;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::AppHandle;

pub use config::BackendConfig;
pub use error::BackendError;
pub use protocol::{BackendArgs, BackendOutcome};

/// 取锁，容忍中毒。
///
/// release 下 `panic = "abort"` 不会留下中毒的锁；debug 下会。但一个中毒的
/// 子进程句柄仍然比直接 panic 有用 —— 这个模块里不允许出现 panic 路径，
/// 因为输入来自外部进程，`unwrap()` 全是可达的 abort 路径。
pub(crate) fn lock_or_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 正在跑的流式任务。
pub struct RunningJob {
    /// 哪个命令在跑。`Busy` 错误里要报给用户
    pub cmd: String,
    /// `backend_cancel` 拿它去 kill
    pub child: Arc<Mutex<Child>>,
    /// kill 之前必须先置它，见 `runner::request_cancel`
    pub cancel: Arc<AtomicBool>,
}

/// 全局状态，由 `lib.rs` 在 setup 里 `.manage()` 进来。
pub struct BackendState {
    config: BackendConfig,

    /// 流式任务的**单飞闸门**，同时也是注册表。
    ///
    /// 做成 `Option` 而不是 `HashMap<run_id, _>`：同一时刻本来就只允许一个流式
    /// 任务，闸门和注册表合成一个东西，**结构上**就保证了「两个 `ingest` 不会
    /// 同时写 `tags.db` 和 `library/`」—— Python 侧的 `reconcile` / `journal`
    /// 假设单写者。
    ///
    /// 非流式命令（`search` / `status` / ...）不注册，它们只读，可以并发。
    streaming: Mutex<Option<Arc<RunningJob>>>,

    next_run_id: AtomicU64,

    /// `tag_suggest` 的限流闸门（见 throttle.rs）。
    ///
    /// 挂在 state 上而不是做成 `static`：`static` 全进程只有一份，测试里几条
    /// 用例会互相把对方的窗口占掉；挂在 state 上，每个 `BackendState` 一份，
    /// 用例各造各的（生产上本来也就一个）。
    tag_suggest: Throttle,
}

impl BackendState {
    pub fn new(config: BackendConfig) -> Self {
        Self {
            config,
            streaming: Mutex::new(None),
            next_run_id: AtomicU64::new(1),
            tag_suggest: Throttle::new(),
        }
    }

    /// 从 `til.toml` 装载。`app_config_dir` 传 Tauri 的 `app.path().app_config_dir()`。
    pub fn load(app_config_dir: Option<&Path>) -> Result<Self, BackendError> {
        Ok(Self::new(BackendConfig::load(app_config_dir)?))
    }

    /// 跑一条命令。
    ///
    /// `streaming` 为 true 时走单飞闸门；否则直接跑，可并发。
    ///
    /// `app` 是 `Option` 只是为了能脱离 Tauri 运行时做单元测试（事件会被丢掉，
    /// 但流程照走）—— 测试里传 `None`。
    pub fn execute(
        &self,
        app: Option<&AppHandle>,
        cmd: &str,
        args: Option<BackendArgs>,
        streaming: bool,
    ) -> Result<BackendOutcome, BackendError> {
        let run_id = self.next_run_id.fetch_add(1, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));

        if !streaming {
            let child = runner::spawn(&self.config, cmd, args.as_ref())?;
            return runner::drive(app, child, run_id, cmd, cancel);
        }

        // 流式：**先占闸门，再 spawn**。
        // 反过来的话，「已经忙」的情况下会白起一个 Python 进程再扔掉
        // （冷启动 200ms 起步，`ingest` 还要加载模型）。
        let child = {
            let mut slot = lock_or_recover(&self.streaming);
            if let Some(existing) = slot.as_ref() {
                return Err(BackendError::Busy {
                    running: existing.cmd.clone(),
                });
            }
            let child = runner::spawn(&self.config, cmd, args.as_ref())?;
            *slot = Some(Arc::new(RunningJob {
                cmd: cmd.to_string(),
                child: Arc::clone(&child),
                cancel: Arc::clone(&cancel),
            }));
            child
        }; // 出了作用域就放锁 —— drive 全程不能持锁，否则 cancel 拿不到

        let outcome = runner::drive(app, child, run_id, cmd, cancel);

        // **只有这里清 entry**。`cancel` 不清 —— 它清了的话 runner 收尾时找不到，
        // 而且会出现「取消之后闸门一直关着，再也跑不了」。
        let mut slot = lock_or_recover(&self.streaming);
        *slot = None;

        outcome
    }

    /// 取消正在跑的流式任务。没有在跑就返回 `false`（幂等）。
    pub fn cancel(&self) -> bool {
        let slot = lock_or_recover(&self.streaming);
        let Some(job) = slot.as_ref() else {
            return false;
        };
        // 锁顺序固定为 streaming → child。execute 里是「先放 streaming 锁，
        // drive 里再拿 child 锁」，没有反向路径，不会死锁。
        runner::request_cancel(&job.child, &job.cancel);
        true
    }

    /// `tag_suggest` 的限流闸门。调用方拿它 `acquire()` 之后再决定跑不跑。
    pub fn tag_suggest_gate(&self) -> &Throttle {
        &self.tag_suggest
    }

    /// 测试用：闸门是不是被占着。
    #[cfg(test)]
    pub(crate) fn is_streaming(&self) -> bool {
        lock_or_recover(&self.streaming).is_some()
    }
}

// ---------------------------------------------------------------------------
// 测试辅助
//
// 放在这里而不是各测试模块里，是为了 runner 和 mod 的测试共用同一套。
// ---------------------------------------------------------------------------

/// 造一个假的 `backend` 包，用来触发真实后端不好复现的路径
/// （import 期崩溃、长睡不醒）。
#[cfg(test)]
pub(crate) fn fake_backend(name: &str, main_py: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("til-runner-test-{name}"));
    let pkg = root.join("backend");
    std::fs::create_dir_all(&pkg).expect("建目录");
    std::fs::write(pkg.join("__init__.py"), "").expect("写 __init__.py");
    std::fs::write(pkg.join("__main__.py"), main_py).expect("写 __main__.py");
    root
}

#[cfg(test)]
pub(crate) fn fake_config(root: std::path::PathBuf) -> BackendConfig {
    BackendConfig {
        python: "python".to_string(),
        root,
        config: None,
    }
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;

    use super::*;

    /// **单飞闸门。**
    ///
    /// 两个 `ingest` 同时跑会同时写 `tags.db` 和 `library/` —— Python 侧的
    /// `reconcile` / `journal` 假设单写者。这条验三件事：
    /// 第二个被挡住、取消能生效、**取消之后闸门必须重新打开**
    /// （否则取消一次就再也跑不了任何流式命令了）。
    #[test]
    fn streaming_gate_blocks_second_run_and_reopens_after_cancel() {
        let root = fake_backend("gate", "import time\ntime.sleep(300)\n");
        let state = Arc::new(BackendState::new(fake_config(root.clone())));

        let first = {
            let state = Arc::clone(&state);
            thread::spawn(move || state.execute(None, "ingest", None, true))
        };

        // 等第一个真正占上闸门（spawn 要几十上百毫秒，不能直接断言）
        for _ in 0..200 {
            if state.is_streaming() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(state.is_streaming(), "第一个流式任务应当占住闸门");

        // 第二个必须被挡回去
        match state.execute(None, "reindex", None, true) {
            Err(BackendError::Busy { running }) => assert_eq!(running, "ingest"),
            other => panic!("第二个流式命令应当被挡住，实际：{other:?}"),
        }

        // 取消
        assert!(state.cancel(), "应当能取消到正在跑的任务");
        let outcome = first.join().expect("线程应当正常结束");
        assert!(
            matches!(outcome, Err(BackendError::Cancelled { .. })),
            "应当是被取消，实际：{outcome:?}"
        );

        // 闸门必须重新打开
        for _ in 0..200 {
            if !state.is_streaming() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!state.is_streaming(), "取消之后闸门应当重新打开");
        assert!(!state.cancel(), "没有任务在跑时 cancel 应当返回 false（幂等）");

        let _ = std::fs::remove_dir_all(root);
    }
}
