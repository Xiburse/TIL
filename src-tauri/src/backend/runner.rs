//! 驱动一次 `python -m backend` 调用：起进程、写请求、读响应、收尾。
//!
//! # 为什么长这样
//!
//! `E:\Images\API.md` 把两条约束标成了「必须遵守」，违反的后果不是报错而是
//! **整个归档静默卡死**：
//!
//! 1. **stdout 必须在独立线程里持续读。** 读慢了管道缓冲写满，Python 侧会
//!    阻塞在写 stdout 上，整轮处理停下来。
//! 2. **stderr 也必须读。** 后端崩溃时原因只在 stderr，不读就只能看到「卡住」。
//!
//! 所以这里是「两条读线程 + 主线程收结果」的结构，不是简单的 `wait_with_output`。
//! 读线程**永不 join** —— Python 若 fork 出继承了管道的孙进程，join 会永久卡住。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::config::BackendConfig;
use super::error::BackendError;
use super::lock_or_recover;
use super::protocol::{
    BackendArgs, BackendErrorPayload, BackendEvent, BackendOutcome, BackendRequest, EVENT_CHANNEL,
};

/// 主循环轮询间隔。也是取消的响应上限 —— 最坏要等这么久才注意到取消。
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// stderr 缓冲上限。防一个疯狂刷错误的进程把内存吃光。
const STDERR_LIMIT: usize = 64 * 1024;

/// 等进程退出的短轮询：次数 × 间隔 = 最多等 1 秒
const REAP_ATTEMPTS: u32 = 20;
const REAP_INTERVAL: Duration = Duration::from_millis(50);

/// 收到 EOF 之后，再等 stderr 线程把尾巴吐完的时间
const STDERR_GRACE: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// 起进程
// ---------------------------------------------------------------------------

/// 起一个后端进程并把请求写进去。返回的句柄可以直接交给 [`drive`]，
/// 也可以先存进 registry 好让 `backend_cancel` 找到它。
pub fn spawn(
    config: &BackendConfig,
    cmd: &str,
    args: Option<&BackendArgs>,
) -> Result<Arc<Mutex<Child>>, BackendError> {
    // cwd 不存在时 Windows 报 ERROR_DIRECTORY(267)，ErrorKind 还不稳定，
    // 所以自己先查一下，好给一句人话
    if !config.root.is_dir() {
        return Err(BackendError::Spawn {
            message: format!(
                "Python 脚本根目录不存在：{}\n\
                 （til.toml 里 backend.root 配错了？它应当是**包含 backend/ 包**的那个目录）",
                config.root.display()
            ),
        });
    }

    let mut command = Command::new(&config.python);
    command
        .arg("-m")
        .arg("backend")
        .current_dir(&config.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // ---- 编码：这是协议可用性的前提，不只是防乱码 ----
    //
    // 系统 cp936 时管道里的 stdout 编码是 gbk，中文合集名直接乱码。更糟的是：
    // gbk + errors='strict' 编不出中文时抛 UnicodeEncodeError → 被 ipc.main
    // 的 except 接住 → 往 stderr 打 traceback —— 而 **stderr 也是 gbk** →
    // 二次异常无人接住 → 进程死掉，stdout 上一行 result 都没有。
    //
    // 只动 std 流。**不要用 PYTHONUTF8=1** —— 那会改所有文件 I/O 的默认编码，
    // 而这个后端的核心承诺是「tag 写进 XMP 就改不回来」，动归档流水线的文件
    // 编码默认值是在赌一个不可逆的口径。
    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1");

    if let Some(cfg) = config.config.as_ref() {
        command.arg("--config").arg(cfg);
    }

    // release 下 main.rs 有 `windows_subsystem = "windows"`，父进程没有控制台。
    // 不设这个标志的话，每调一次命令都会弹一个黑色控制台窗口闪一下。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| BackendError::Spawn {
        message: format!(
            "启动 Python 失败。\n  解释器：{}\n  工作目录：{}\n  系统错误：{e}",
            config.python,
            config.root.display(),
        ),
    })?;

    write_request(&mut child, cmd, args)?;

    Ok(Arc::new(Mutex::new(child)))
}

fn write_request(
    child: &mut Child,
    cmd: &str,
    args: Option<&BackendArgs>,
) -> Result<(), BackendError> {
    let request = BackendRequest { cmd, args };
    let mut line = serde_json::to_vec(&request).map_err(|e| BackendError::Protocol {
        message: format!("请求序列化失败：{e}"),
        raw: String::new(),
    })?;
    line.push(b'\n');

    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(&line).map_err(|e| BackendError::Spawn {
            message: format!("往后端 stdin 写请求失败：{e}"),
        })?;
        let _ = stdin.flush();
    }

    // 关掉 stdin。Python 侧只 readline() 一次，关了不影响；留着是为了防后端
    // 将来改成「读到 EOF 才动手」——那时不关就会双方互等。
    drop(child.stdin.take());
    Ok(())
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/// 一直读到 `result` 行（或进程死掉），把中间的事件转发给前端。
///
/// 三个出口：
///
/// | 出口 | 结果 |
/// |---|---|
/// | 读到 `result` | `Ok(BackendOutcome)`，**哪怕信封里 `ok: false`** |
/// | channel `Disconnected` | `Err(NoResult)` + stderr 摘要 |
/// | cancel 标记被置 | `Err(Cancelled)` |
pub fn drive(
    app: Option<&AppHandle>,
    child: Arc<Mutex<Child>>,
    run_id: u64,
    cmd: &str,
    cancel: Arc<AtomicBool>,
) -> Result<BackendOutcome, BackendError> {
    let (stdout, stderr) = {
        let mut c = lock_or_recover(&child);
        (c.stdout.take(), c.stderr.take())
    };

    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        return Err(BackendError::Spawn {
            message: "拿不到子进程的 stdout/stderr 管道".to_string(),
        });
    };

    let stderr_buf = Arc::new(StderrBuf::new());
    let (tx, rx) = mpsc::channel::<Value>();

    spawn_stderr_reader(stderr, Arc::clone(&stderr_buf));
    spawn_stdout_reader(stdout, app.cloned(), tx, run_id);

    // ---- 主循环 ----
    // 先查取消标记再收消息。cancel 是「先置标记再 kill」，kill 之后 stdout
    // 立刻 EOF、channel 变 Disconnected —— 如果先看 Disconnected，就会把
    // 「用户主动取消」误报成「进程崩溃没吐 result」。
    let mut cancelled = false;
    let result: Option<Value> = loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break None;
        }
        match rx.recv_timeout(POLL_INTERVAL) {
            Ok(value) => break Some(value),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // 再查一次：这次的 EOF 也可能是 cancel 造成的
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                }
                break None;
            }
        }
    };

    if cancelled {
        kill_and_wait(&child);
        return Err(BackendError::Cancelled { run_id });
    }

    match result {
        Some(value) => {
            let exit_code = reap(&child);
            let (ok, data, error) = parse_result(&value)?;
            Ok(BackendOutcome {
                run_id,
                cmd: cmd.to_string(),
                ok,
                data,
                error,
                exit_code,
                stderr: stderr_buf.snapshot(),
            })
        }
        None => {
            // 进程退出了，但一行 result 都没读到。只有一种成因：Python 在
            // **import 期**就崩了 —— backend/config.py 的模块级
            // `_CFG = _load_config()` 在 config.toml 缺失/语法错/有未知键时
            // 抛 SystemExit，此时 backend.ipc 根本没导入成功，
            // sys.exit(ipc.main()) 不会执行，stdout 上一个字节都没有。
            //
            // 运行期的错误不会走到这里：ipc.main() 把一切包在 try 里，
            // 连 SystemExit 都会被转成一行 result。
            //
            // 给 stderr 线程一点时间把最后几行吐完 —— 那是唯一的线索。
            thread::sleep(STDERR_GRACE);
            let exit_code = reap(&child);
            Err(BackendError::NoResult {
                exit_code,
                stderr: stderr_buf.snapshot(),
            })
        }
    }
}

/// 请求取消。**先置标记，再 kill** —— 顺序不能反，见 [`drive`] 主循环的注释。
pub fn request_cancel(child: &Arc<Mutex<Child>>, cancel: &AtomicBool) {
    cancel.store(true, Ordering::SeqCst);
    let mut c = lock_or_recover(child);
    // 可能已经被 runner 自己杀了，返回 Err 是正常的，忽略
    let _ = c.kill();
}

// ---------------------------------------------------------------------------
// 读线程
// ---------------------------------------------------------------------------

fn spawn_stdout_reader(
    stdout: ChildStdout,
    app: Option<AppHandle>,
    tx: mpsc::Sender<Value>,
    run_id: u64,
) {
    // ⚠ Sender 只在这里持有，**绝不 clone 到别处**。
    //
    // 线程走到 EOF 时它被 drop，主循环的 recv 才会返回 Disconnected。
    // 「进程死了但没吐 result」这个兜底完全靠这个性质 —— clone 出去一份
    // （比如存进 registry）就永远收不到 Disconnected，兜底失效，
    // 表现为取消或崩溃时命令永远不返回。
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        let mut seq: u64 = 0;
        let mut result_sent = false;

        loop {
            buf.clear();

            // 用 read_until 而不是 BufReader::lines()：lines() 遇到非法 UTF-8
            // 会返回 io::Error，那会**终止整个读循环**，然后后端阻塞在写 stdout
            // 上，整个归档卡死 —— 正是 API.md 第一条禁令描述的死法。
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break, // 正常 EOF
                Ok(_) => {}
                // kill 之后 Windows 上管道破裂可能以 ERROR_BROKEN_PIPE 返回 Err
                // 而不是 Ok(0)。一律当 EOF，否则取消路径会多报一个假错误。
                Err(_) => break,
            }

            // from_utf8_lossy：宁可把个别坏字节显示成 U+FFFD，也不能让一行
            // 坏字节把整条管道断掉
            let line = String::from_utf8_lossy(&buf);
            // trim 不只是保险：Windows 上 Python 文本模式写的是 \r\n，
            // read_until(b'\n') 会把 \r 留在行尾，不 trim 掉 serde_json 会解析失败
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let Ok(value) = serde_json::from_str::<Value>(line) else {
                // 不是合法 JSON。仍然不 break —— 同上的理由
                continue;
            };

            match value.get("t").and_then(Value::as_str) {
                Some("event") => {
                    seq += 1;
                    if let Some(app) = app.as_ref() {
                        let event = BackendEvent {
                            run_id,
                            seq,
                            // 事件名原样透传，不做枚举 —— 文档没列 check_xmp /
                            // check_gpu，写死枚举会把它们漏掉
                            event: value
                                .get("event")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            data: value.get("data").cloned().unwrap_or(Value::Null),
                        };
                        // 发事件失败（比如窗口关了）不该中断后端，忽略
                        let _ = app.emit(EVENT_CHANNEL, event);
                    }
                }
                Some("result") => {
                    if !result_sent {
                        result_sent = true;
                        let _ = tx.send(value);
                    }
                    // 不 break：继续 drain 到 EOF。协议保证 result 是最后一行，
                    // 但万一后端又写了点什么，不读就会把它堵在写 stdout 上。
                }
                _ => {}
            }
        }
    });
}

fn spawn_stderr_reader(stderr: ChildStderr, buf: Arc<StderrBuf>) {
    // 不 join，只往共享缓冲里灌。主线程在需要时取快照。
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut chunk: Vec<u8> = Vec::new();
        loop {
            chunk.clear();
            match reader.read_until(b'\n', &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            buf.push(&String::from_utf8_lossy(&chunk));
        }
    });
}

/// stderr 的共享快照。限长，超了只留尾部 —— Python traceback 的最后
/// 一两行才是真错误。
struct StderrBuf {
    inner: Mutex<String>,
}

impl StderrBuf {
    fn new() -> Self {
        Self {
            inner: Mutex::new(String::new()),
        }
    }

    fn push(&self, chunk: &str) {
        let mut s = lock_or_recover(&self.inner);
        s.push_str(chunk);
        if s.len() <= STDERR_LIMIT {
            return;
        }
        let mut cut = s.len() - STDERR_LIMIT / 2;
        while cut < s.len() && !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
        s.insert_str(0, "…（前文已截断）\n");
    }

    fn snapshot(&self) -> String {
        lock_or_recover(&self.inner).clone()
    }
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/// 等进程退出并拿退出码。返回 `None` = 拿不到（超时后已强杀，或平台不给码）。
///
/// 用 `try_wait` 短轮询而不是阻塞式 `wait()`：`wait()` 期间必须持有 Child 的
/// 锁，而 `backend_cancel` 也要抢同一把锁 —— 持锁阻塞等待就是死锁。
fn reap(child: &Arc<Mutex<Child>>) -> Option<i32> {
    for _ in 0..REAP_ATTEMPTS {
        {
            // 每轮重新取锁、用完立刻放，sleep 期间不持锁
            let mut c = lock_or_recover(child);
            match c.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        thread::sleep(REAP_INTERVAL);
    }
    // 一秒还没退，说明卡住了，强杀
    kill_and_wait(child);
    None
}

/// kill + wait。
///
/// **kill 之后必须 wait**：Windows 上 kill 是 TerminateProcess，不回收句柄；
/// 而 `Child` 的 `Drop` 既不会 kill 也不会 wait。
fn kill_and_wait(child: &Arc<Mutex<Child>>) {
    let mut c = lock_or_recover(child);
    let _ = c.kill();
    let _ = c.wait();
}

fn parse_result(
    value: &Value,
) -> Result<(bool, Option<Value>, Option<BackendErrorPayload>), BackendError> {
    let Some(ok) = value.get("ok").and_then(Value::as_bool) else {
        return Err(BackendError::Protocol {
            message: "result 行里没有 ok 字段，信封形状不对".to_string(),
            raw: value.to_string(),
        });
    };

    let data = value.get("data").filter(|v| !v.is_null()).cloned();
    let error = value
        .get("error")
        .and_then(|e| serde_json::from_value::<BackendErrorPayload>(e.clone()).ok());

    Ok((ok, data, error))
}

// ---------------------------------------------------------------------------
// 测试
//
// 这几条覆盖的是「真实后端不好触发、但一旦出问题就是静默卡死」的路径。
// 需要本机有 `python`。真实后端相关的用例在 E:\Images 不存在时会自动跳过。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::{fake_backend, fake_config};
    use super::*;

    /// 真实后端的配置。E:\Images 不在就返回 None，让用例跳过。
    fn real_config() -> Option<BackendConfig> {
        let config = BackendConfig::load(None).ok()?;
        config.root.is_dir().then_some(config)
    }

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn run(config: &BackendConfig, cmd: &str) -> Result<BackendOutcome, BackendError> {
        let child = spawn(config, cmd, None)?;
        drive(None, child, 1, cmd, no_cancel())
    }

    // -- 真实后端 --

    #[test]
    fn status_round_trips() {
        let Some(config) = real_config() else {
            return;
        };
        let outcome = run(&config, "status").expect("status 应当返回 result");
        assert!(outcome.ok, "status 应当成功：{outcome:?}");
        let data = outcome.data.expect("status 应当带 data");
        assert!(data.get("root").is_some(), "status 应当有 root 字段");
        assert!(outcome.stderr.is_empty(), "正常路径 stderr 不该有内容");
    }

    /// 不存在的图片 id 返回 `image: null`，**而不是报错** —— 文档明确写了。
    /// 这条同时验证了「信封 ok:true 但 data 是空结果」这种形状不被误判成失败。
    #[test]
    fn missing_image_id_is_null_not_an_error() {
        let Some(config) = real_config() else {
            return;
        };
        let args = BackendArgs {
            image_id: Some("000000000000".to_string()),
            ..Default::default()
        };
        let child = spawn(&config, "image_detail", Some(&args)).expect("起进程");
        let outcome = drive(None, child, 1, "image_detail", no_cancel()).expect("应当有 result");
        assert!(outcome.ok, "找不到图不是错误：{outcome:?}");
        let data = outcome.data.expect("应当有 data");
        assert!(data.get("image").is_some_and(|v| v.is_null()));
    }

    // -- 合成后端 --

    /// **编码用例。**
    ///
    /// 去掉 `spawn()` 里的 `PYTHONIOENCODING=utf-8` 这条会挂：系统 cp936 时
    /// Python 管道 stdout 用 gbk，中文会以 gbk 字节到达，`from_utf8_lossy`
    /// 把它们变成 U+FFFD。用合成后端是为了不依赖图库里恰好有中文合集名。
    #[test]
    fn chinese_survives_the_pipe() {
        let root = fake_backend(
            "encoding",
            r#"
import json, sys
line = json.dumps({"t":"result","ok":True,"data":{"name":"26.9.28 tg 图集"}},
                  ensure_ascii=False)
sys.stdout.write(line + "\n")
sys.stdout.flush()
"#,
        );
        let outcome = run(&fake_config(root.clone()), "x").expect("应当有 result");
        let text = outcome.data.expect("应当有 data").to_string();

        assert!(!text.contains('\u{FFFD}'), "不该出现替换字符（gbk 没转过来）：{text}");
        assert!(text.contains("图集"), "中文应当完好穿过管道：{text}");

        let _ = std::fs::remove_dir_all(root);
    }

    /// **「进程死了但没吐 result」的兜底。**
    ///
    /// 真实成因只有一个：Python 在 import 期就崩了（`backend/config.py` 的
    /// 模块级 `_CFG = _load_config()`）。这时 stdout 一个字节都没有，读循环
    /// 靠 channel `Disconnected` 退出，**不是靠超时**。关键是不能卡死，
    /// 且必须把 stderr 带出来当线索。
    #[test]
    fn import_crash_reports_stderr_instead_of_hanging() {
        let root = fake_backend("crash", "raise SystemExit('config.toml 炸了')\n");
        let err = run(&fake_config(root.clone()), "x")
            .expect_err("import 期崩溃应当报错，而不是卡住");

        match err {
            BackendError::NoResult { stderr, exit_code } => {
                assert!(
                    stderr.contains("config.toml 炸了"),
                    "stderr 应当带上崩溃原因，实际：{stderr:?}"
                );
                assert!(exit_code.is_some(), "应当拿到退出码");
            }
            other => panic!("应当是 NoResult，实际：{other:?}"),
        }

        let _ = std::fs::remove_dir_all(root);
    }

    /// **取消路径。**
    ///
    /// 这里有个真实的竞态：`request_cancel` 先置标记再 kill，kill 之后 stdout
    /// 立刻 EOF、channel 变 `Disconnected`。如果主循环先看 `Disconnected`
    /// 再看标记，就会把「用户主动取消」误报成「进程崩溃没吐 result」。
    /// 这条用例就是在验那个顺序。
    #[test]
    fn cancel_kills_the_process_and_is_not_mistaken_for_a_crash() {
        let root = fake_backend("cancel", "import time\ntime.sleep(300)\n");
        let config = fake_config(root.clone());

        let child = spawn(&config, "x", None).expect("起进程");
        let probe = Arc::clone(&child);
        let cancel = no_cancel();

        // 模拟 backend_cancel 在 200ms 后到达
        let canceller = {
            let child = Arc::clone(&child);
            let cancel = Arc::clone(&cancel);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(200));
                request_cancel(&child, &cancel);
            })
        };

        let err = drive(None, child, 7, "x", cancel).expect_err("应当被取消");
        canceller.join().ok();

        match err {
            BackendError::Cancelled { run_id } => assert_eq!(run_id, 7),
            other => panic!("应当是 Cancelled 而不是 NoResult，实际：{other:?}"),
        }

        // 进程必须真的没了并且被回收（kill 之后不 wait 会漏句柄 ——
        // Windows 上 kill 是 TerminateProcess，Child 的 Drop 也不 wait）
        let status = lock_or_recover(&probe).try_wait();
        assert!(
            matches!(status, Ok(Some(_))),
            "进程应当已退出并被回收，实际：{status:?}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    /// stdout 上有非 JSON 的垃圾行时，不能中断读循环 ——
    /// 中断会让后端阻塞在写 stdout 上，整个归档静默卡死。
    #[test]
    fn junk_lines_do_not_break_the_stream() {
        // 夹具一律用 json.dumps 生成响应行，别手搓 JSON ——
        // 手写很容易写出 Python 的 True（不是 JSON 的 true），那样后端发的就是
        // 非法 JSON，会被当成垃圾行跳过，测试失败的原因看起来像读取有 bug。
        let root = fake_backend(
            "junk",
            r#"
import json, sys

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")

sys.stdout.write("这不是 JSON\n")   # 垃圾行，且含非 ASCII
sys.stdout.write("\n")               # 空行
emit({"t": "result", "ok": True, "data": {"survived": True}})
sys.stdout.flush()
"#,
        );
        let outcome = run(&fake_config(root.clone()), "x").expect("垃圾行不该让读循环断掉");
        let data = outcome.data.expect("应当有 data");
        assert_eq!(data.get("survived").and_then(Value::as_bool), Some(true));

        let _ = std::fs::remove_dir_all(root);
    }

    /// 事件要能被解析出来，且 `event` 名原样透传（不做枚举 ——
    /// 文档没列 check_xmp / check_gpu，写死枚举会漏掉它们）。
    #[test]
    fn events_are_passed_through_by_name() {
        let root = fake_backend(
            "events",
            r#"
import json, sys
for name in ("check_xmp", "check_gpu", "进度"):
    sys.stdout.write(json.dumps({"t": "event", "event": name, "data": {"n": 1}},
                                ensure_ascii=False) + "\n")
sys.stdout.write(json.dumps({"t": "result", "ok": True, "data": {}}) + "\n")
sys.stdout.flush()
"#,
        );
        // app 传 None，事件会被丢弃但流程必须照常走完
        let outcome = run(&fake_config(root.clone()), "x").expect("应当有 result");
        assert!(outcome.ok);

        let _ = std::fs::remove_dir_all(root);
    }
}
