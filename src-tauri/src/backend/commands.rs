//! 13 条后端命令的 Tauri 封装，外加取消。
//!
//! # 为什么是 9 个命令而不是一个 `backend_invoke(cmd, args)`
//!
//! 1. 前端的可发现性 —— `invoke('backend_search', ...)` 比传字符串命令名清楚。
//! 2. **必填参数校验需要按命令做。** Python 侧对必填参数零校验，不传就静默
//!    返回空结果（详见下面 `require` 的注释）。
//!
//! # 返回值形状
//!
//! 全部返回 `Result<BackendOutcome, BackendError>`：
//!
//! - **后端跑完了**（哪怕信封里 `ok: false`）→ `Ok(BackendOutcome)`。
//!   `config_error` 之类是一次**成功的 IPC 往返**，不该变成 JS 异常。
//! - **传输层失败**（起不了进程 / 没吐 result / 被取消 / 忙）→ `Err(BackendError)`，
//!   序列化成一个扁平对象给前端 `catch`。
//!
//! # 参数名是 camelCase
//!
//! Tauri 默认把 command 的**顶层参数名**转成 camelCase，但 `BackendArgs`
//! **内部字段保持 snake_case**（serde 自己处理，正好匹配 Python 的键名）。
//! 所以前端要写 `invoke('backend_search', { args: { tags_all: [...] } })`。

use tauri::{AppHandle, Manager, State};

use super::throttle::Turn;
use super::{BackendArgs, BackendError, BackendOutcome, BackendState};

/// 把活儿丢进 blocking 线程池再 await。
///
/// `#[tauri::command]` 的 fn 体是跑在 tokio worker 上的，而这里可能一阻塞就是
/// 几十分钟（`ingest` 一万张图）。直接阻塞会把 worker 占死 —— 并发几条命令
/// 再叠加一个 `cancel`，就会互相饿死。`spawn_blocking` 把活儿挪出 worker。
async fn dispatch(
    app: AppHandle,
    cmd: &'static str,
    args: Option<BackendArgs>,
    streaming: bool,
) -> Result<BackendOutcome, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        state.execute(Some(&app), cmd, args, streaming)
    })
    .await
    .map_err(|e| BackendError::Spawn {
        message: format!("后台任务异常终止：{e}"),
    })?
}

/// 过限流闸门的 `dispatch`。见 [`backend_tag_suggest`]。
///
/// 和 [`dispatch`] 的唯一区别是**跑之前先排队**：闸门每 `WINDOW` 只放行一次，
/// 窗口内挤进来的请求只留最新那条，其余在这里直接翻成
/// [`BackendError::Superseded`] 返回，**不会起 Python 进程**。
///
/// ⚠ 排队是阻塞的（最多 `WINDOW`），所以整段都包在 `spawn_blocking` 里 ——
/// 直接在 command 的 fn 体里排队会占死 tokio worker。
async fn dispatch_gated(
    app: AppHandle,
    cmd: &'static str,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        match state.tag_suggest_gate().acquire() {
            Turn::Superseded => Err(BackendError::Superseded {
                cmd: cmd.to_string(),
            }),
            Turn::Go => state.execute(Some(&app), cmd, args, false),
        }
    })
    .await
    .map_err(|e| BackendError::Spawn {
        message: format!("后台任务异常终止：{e}"),
    })?
}

/// 必填参数校验。
///
/// Python 侧**对必填参数零校验**，不传就静默返回空结果，前端会把「忘了传」
/// 显示成「没有数据」：
///
/// - `image_detail` 不传 `image_id` → 返回 `{"image": null}`，**与「真的找不到」无法区分**
/// - `collection_tags` 既不给 `name` 也不给 `coll_id` → 静默返回空列表
/// - `delete` 两个 id 数组都不给 → 等于什么都没删，却看起来成功了
///
/// 这是 `BackendArgs` 用强类型的另一半价值 —— 不校验就白强类型了。
fn require(
    args: Option<BackendArgs>,
    satisfied: impl FnOnce(&BackendArgs) -> bool,
    requirement: &str,
) -> Result<BackendArgs, BackendError> {
    let args = args.unwrap_or_default();
    if satisfied(&args) {
        Ok(args)
    } else {
        Err(BackendError::Protocol {
            message: format!("参数不完整：{requirement}"),
            raw: String::new(),
        })
    }
}

// ---------------------------------------------------------------------------
// 非流式（可并发）
// ---------------------------------------------------------------------------

/// 库的整体状态。**前端启动时第一个调它**，用它决定显示「空库引导」还是「图库」。
///
/// 注意 `model_exists: false` 时前端应当隐藏/禁用「开始打标」。
#[tauri::command]
pub async fn backend_status(app: AppHandle) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "status", None, false).await
}

/// 按 tag / 分级 / 日期 / 合集查图。
///
/// `min_conf` 默认 0 —— **能查到当初没过阈值的 tag**。想要「只查确定的」传 0.35。
/// `limit` 不传表示不限制。
///
/// ⚠ 每次调用都是一次 Python 冷启动（150–300ms），前端搜索框**必须 debounce**。
#[tauri::command]
pub async fn backend_search(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "search", args, false).await
}

/// 单张图的完整 tag 列表（含置信度）。找不到时 `data.image` 为 `null`（不是报错）。
#[tauri::command]
pub async fn backend_image_detail(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    let args = require(
        args,
        |a| a.image_id.is_some(),
        "image_detail 需要 image_id（归档文件名的主干，不是数据库 id）",
    )?;
    dispatch(app, "image_detail", Some(args), false).await
}

/// 标签频次排行。
#[tauri::command]
pub async fn backend_top_tags(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "top_tags", args, false).await
}

/// 合集树。返回**树序**（父在前，同级按 `side`），前端直接按 `depth` 缩进即可 ——
/// 返回顺序就是正确的显示顺序，不用自己排。
#[tauri::command]
pub async fn backend_collections(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "collections", args, false).await
}

/// 按 tag 子串查候选**集合**，每条带「多少张图有它」。
///
/// 给查询框做补全用：`query` 是子串（**包含**匹配，不是前缀），大小写不敏感，
/// 空格转下划线。`limit` 默认 50（按图数从多到少，同数的按字母序）。
///
/// `min_conf` 是**图数口径**：默认 0 = 「进库就算」，含当初没过阈值的 tag；
/// 要「真正命中」的图数就传 0.35（config.toml 里的 general 阈值）。同一个 tag
/// 两个口径能差出好几张，别混。
///
/// 源是 CSV 词表而不是数据库，所以会回出**库里一张图都没有的 tag**
/// （`count: 0`，排在最后、默认被 `limit` 截掉）。
/// 返回里还有 `total`（截断前的命中总数），可用来显示「还有更多」。
///
/// # 限流：这条是唯一一条会被「顶掉」的命令
///
/// 输入框每敲一个字母前端就会调一次，而**每次调用都是一次 Python 冷启动**
/// （150–300ms）—— 敲四个字母就排四个进程，回来的顺序还不保证。所以这条走
/// [`dispatch_gated`]：**每 200ms 最多真跑一次**，窗口内挤进来的请求只留最新的
/// 那条，其余的直接返回 `kind: "superseded"`（见 throttle.rs）。
///
/// 前端拿到 `superseded` **直接忽略**，别弹提示、也别当成失败 —— 输入框里每敲
/// 一下都可能产生几条，真正要显示的是最后那条没被顶掉的。
///
/// ⚠ `query` **必传**（可以是空串）。不传的话 Python 那边按 `null` 处理、静默
/// 回空列表，和「这个词没有候选」长得一模一样 —— 前端会以为是自己查错了。
#[tauri::command]
pub async fn backend_tag_suggest(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    let args = require(
        args,
        |a| a.query.is_some(),
        "tag_suggest 需要 query（空串是合法的：输入框清空是常态）",
    )?;
    dispatch_gated(app, "tag_suggest", Some(args)).await
}

/// 某个合集的 tag 频次表。
///
/// 同名合集可能有多个（每次投放算一个新合集），**全部返回**。
/// `data.collections[].tags[].freq` 是后端算好的 `count / image_count`，
/// 前端直接用，别自己反推。
#[tauri::command]
pub async fn backend_collection_tags(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    let args = require(
        args,
        |a| a.name.is_some() || a.coll_id.is_some(),
        "collection_tags 需要 name 或 coll_id（合集文件夹名，不是数据库 id）",
    )?;
    dispatch(app, "collection_tags", Some(args), false).await
}

/// 待入库清单：`inbox/` 里有哪些散图、哪些合集（合集**递归嵌套**）。
///
/// **不带参数**，也不加载模型、不碰数据库。每张图会开一次文件头读尺寸，所以比
/// 纯目录扫描贵一点（实测约 0.19s，19 张），可以放心在用户拖完文件夹后立刻调。
///
/// 几个容易用错的地方（详见 `E:\Images\API.md` 的 `inbox_scan` 一节）：
///
/// - **`total_images` 才是「待入库多少张图」**。`status.inbox_pending` 数的是
///   **顶层条目**（一个含 4 张图的合集算 1），两者对不上是正常的。
/// - `image_count`（本层直接图片数）≠ `image_total`（整棵子树），父层加子层会
///   **重复计**。
/// - 每条图片记录都带 `width` / `height` / `size_bytes`（**可能是 `null`** ——
///   连文件头都读不了，那种必然入库失败）。尺寸是**显示尺寸**，EXIF 旋转已套用。
///   但**像素数据被截断的图照样报得出尺寸**，所以它只能用来排版，不能当
///   「必能入库」的保证。
/// - 进不进列表只看扩展名，不做内容校验。
#[tauri::command]
pub async fn backend_inbox_scan(app: AppHandle) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "inbox_scan", None, false).await
}

// ---------------------------------------------------------------------------
// 流式（单飞，同一时刻只能跑一个）
// ---------------------------------------------------------------------------

/// 处理 `inbox/`。流式，会产生 `model_loading` / `collection_start` /
/// `image_done` / `progress` / `run_done` 等事件。
///
/// **成败要看 `data.exit_code`（0 全成功 / 2 部分失败），不是进程退出码，
/// 也不是只看信封 `ok`。** 进程退出码永远是 0。
///
/// ⚠ `inbox` 为空时 `data` 里**没有 `exit_code` 这个键**，前端要用可选链。
#[tauri::command]
pub async fn backend_ingest(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "ingest", args, true).await
}

/// 从 `library/` 重建索引（不需要模型）。流式。
///
/// ⚠ `reindex` 的成败在 **`data.ok`**（不是信封的 `ok`）—— 遇到 OneDrive
/// 占位符而没执行时 `data.ok` 是 `false`，但信封 `ok` 仍是 `true`。
/// 只判信封会把「什么都没做」显示成成功。
///
/// `prune: true` 时**必须同时传 `yes: true`** 才真删，否则只报「将删除 N 行」。
#[tauri::command]
pub async fn backend_reindex(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "reindex", args, true).await
}

/// 巡检 `library/` 结构完整性。流式，坏的会发 `warning` 事件。
#[tauri::command]
pub async fn backend_verify(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "verify", args, true).await
}

/// 自检：GPU 加速 + XMP 段链往返。流式。
///
/// XMP 自检**不依赖模型**，所以没装模型也能验证图片读写链路。
/// 这个命令还会发文档没列的两个事件：`check_xmp` / `check_gpu`。
#[tauri::command]
pub async fn backend_check(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    dispatch(app, "check", args, true).await
}

/// 删除图片 / 合集。**不可逆** —— 文件、`_tags.json` 边车、嵌在图里的 XMP
/// 一起消失。这是唯一自洽的语义：library 是真相源，只删库行的话 `reindex`
/// 会把它们复活。
///
/// `image_ids` / `coll_ids` **至少给一个**，可以混用。删合集会连**整棵子树**
/// 一起删（子合集物理嵌在父目录里，不连带删会留下断链）。
///
/// 幂等：重发同一批参数得到 `missing`，不是报错 —— 中断之后重发一遍即可收尾。
/// 建议先 `dry_run: true` 让用户确认，再真删。
///
/// ⚠ id 是**磁盘上的名字**（图片=文件名主干、合集=文件夹名）。
/// 传数据库数字会得到 `missing` —— 数字换台设备就变了，不可靠。
///
/// 建议真删完立刻刷新当前列表：文件已经从磁盘上没了，留着只会加载失败。
#[tauri::command]
pub async fn backend_delete(
    app: AppHandle,
    args: Option<BackendArgs>,
) -> Result<BackendOutcome, BackendError> {
    let args = require(
        args,
        |a| a.image_ids.is_some() || a.coll_ids.is_some(),
        "delete 需要 image_ids 或 coll_ids 至少一个",
    )?;
    // 走单飞闸门：删一半再被别的写任务插进来会收拾不干净
    dispatch(app, "delete", Some(args), true).await
}

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

/// 取消正在跑的流式命令。没有在跑时返回 `false`（幂等）。
///
/// **取消就是直接 kill 进程** —— 协议层没有取消信令。后端的崩溃安全设计保证
/// 已归档的图片安全留在 `library`，未完成的记录是 `pending`，下次启动自动收拾。
///
/// 前端建议：kill 之后提示「已取消，已处理的 N 张已安全入库」。
#[tauri::command]
pub async fn backend_cancel(state: State<'_, BackendState>) -> Result<bool, BackendError> {
    Ok(state.cancel())
}
