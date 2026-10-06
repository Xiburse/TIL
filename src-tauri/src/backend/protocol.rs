//! 与 Python 后端的协议类型。契约文档：`E:\Images\API.md`。
//!
//! 设计原则：**参数侧强类型，返回侧透传**。
//!
//! - `BackendArgs` 强类型 —— Python 侧对未知键**静默接受、零校验**，Rust 是
//!   唯一的字段名防线。
//! - 返回值一律 `serde_json::Value` —— 文档会持续演进（比如 `collection`
//!   对象实际已有文档未列的 `gen_threshold`/`char_threshold`），在 Rust 里
//!   镜像这些结构只会腐烂。透传自动保持兼容。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 事件推给前端用的频道名。
///
/// Tauri 对事件名的限制是只能有 `[alphanumeric, '-', '/', ':', '_']`，
/// `backend://event` 合法。
pub const EVENT_CHANNEL: &str = "backend://event";

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/// 请求信封：`{"cmd": "...", "args": {...}}`
#[derive(Debug, Clone, Serialize)]
pub struct BackendRequest<'a> {
    pub cmd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<&'a BackendArgs>,
}

/// 所有命令共用的参数表。键名必须与 `E:\Images\backend\ipc.py` 的
/// `_COMMON_DEFAULTS` 逐字一致 —— 一共 27 个。
///
/// # 为什么每个字段都必须 `skip_serializing_if`
///
/// 这不是为了省几个字节，是**正确性要求**。
///
/// Python 侧的 `_args()` 是**覆盖**语义，不是「缺省才填」：
///
/// ```python
/// merged = dict(_COMMON_DEFAULTS)
/// for k, v in (raw or {}).items():
///     merged[k] = v        # 无条件覆盖
/// ```
///
/// 所以序列化出 `"device": null` 会把 Python 的默认值 `0` 冲掉，然后被直接
/// 传给 `WDTaggerLocal(..., args.device, ...)` → onnxruntime。`offset: null` /
/// `dry_run: null` 同理。
///
/// **漏一个不会报错**，只会在 GPU 设备号之类的地方以诡异方式表现。加字段时
/// 照着抄这行属性。
///
/// # 别加 `rename_all = "camelCase"`
///
/// 那会把 `tags_all` 变成 `tagsAll`，Python 侧静默忽略 —— 搜索条件凭空失效。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackendArgs {
    // ---- 分页与运行控制（入库类命令用）----
    /// 分页。`ingest` 时按**顶层条目**计数（一个合集算一项）。null = 不限制
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    /// `ingest`：只推理不落盘
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
    /// `ingest`：强制 CPU
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<bool>,
    /// `ingest`：GPU 设备号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<i64>,
    /// `ingest`：只写 `_tags.json` 边车，不碰 XMP
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_xmp: Option<bool>,
    /// 跳过确认（占位符下载、`prune`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes: Option<bool>,
    /// `reindex`：删除 library 里已不存在的行。**需要同时传 `yes` 才真删**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prune: Option<bool>,
    /// `reindex`：忽略 journal，逐图读 XMP。最慢但最权威
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_images: Option<bool>,
    /// `ingest`：普通标签阈值。null 时 Python 回落到 config.toml 的值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub general_threshold: Option<f64>,
    /// `ingest`：角色名阈值。null 时同上
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_threshold: Option<f64>,

    // ---- 检索（查询类命令用）----
    /// `search`：全部命中（AND）。**用下划线原形**，不是显示用的空格形式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_all: Option<Vec<String>>,
    /// `search`：任一命中（OR）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_any: Option<Vec<String>>,
    /// `search`：`general` / `sensitive` / `questionable` / `explicit`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<String>,
    /// `search`：**入库日** `YYYY-MM-DD`（不是拍摄日）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// `search`：拍摄时间区间起
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_from: Option<String>,
    /// `search`：拍摄时间区间止
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_to: Option<String>,
    /// `search` / `top_tags`：置信度下限。默认 0 —— **能查到当初没过阈值的 tag**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_conf: Option<f64>,
    /// `search` / `collection_tags`：合集 id。
    ///
    /// ⚠ 是**合集文件夹名**（`20260928-205303_a174e15fa7d6`），不是数据库整数
    /// 主键 —— 后端所有 id 都是「磁盘上的名字」，传数字只会得到 `missing`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coll_id: Option<String>,
    /// `search`：合集名（大小写不敏感）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_key: Option<String>,

    // ---- 单点与合集 ----
    /// `image_detail`：图片 id = **归档文件名的主干**（不含扩展名）。
    /// **不传会静默返回 `image: null`**，见 commands.rs 的校验
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    /// `collection_tags`：合集名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `collections`：只列含该 tag 的合集
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// `collections`：最低出现频率（配合 `tag`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_freq: Option<f64>,
    /// `tag_suggest`：输入串，匹配名字**含**它的 tag。
    ///
    /// 空串/全空白是合法的（输入框清空是常态），后端会回空列表而不是报错。
    /// 大小写不敏感，空格转下划线（打 `long hair` 等于 `long_hair`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,

    // ---- delete（image_ids / coll_ids 至少给一个，可以混用）----
    /// `delete`：图片 id 数组（文件名主干）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_ids: Option<Vec<String>>,
    /// `delete`：合集 id 数组（文件夹名）。**会连整棵子树一起删**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coll_ids: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/// 信封里 `ok: false` 时 `error` 字段的形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendErrorPayload {
    pub code: String,
    pub message: String,
}

/// 流式命令产生的进度事件，原样转发给前端。
///
/// `event` 字段**不做枚举**，原样透传字符串。文档列的只是一部分 —— 实际还有
/// `check_xmp` / `check_gpu`（只在 `check` 命令里出现）没写进文档。写死枚举
/// 会把这些漏掉。
#[derive(Debug, Clone, Serialize)]
pub struct BackendEvent {
    /// 本次运行的 id。前端据此丢弃上一轮被 kill 的残留事件
    pub run_id: u64,
    /// 单调递增序号。多线程 emit 时理论上可能乱序，前端可据此排序
    pub seq: u64,
    /// 事件名，原样来自后端
    pub event: String,
    pub data: Value,
}

/// 一次成功 IPC 往返的完整结果。
///
/// # 成败要看三个地方，别只看一个
///
/// | 字段 | 含义 |
/// |---|---|
/// | `ok` | 信封层。传输/执行整体成败 |
/// | `data["exit_code"]` | **只有 `ingest` 有**，且 **inbox 为空时这个键不存在** |
/// | `data["ok"]` | **只有 `reindex` 有**。OneDrive 占位符导致没执行时是 `false`，但信封 `ok` 仍是 `true` |
///
/// **进程退出码不可靠**：`ingest` 部分失败时进程退出码仍是 0，「部分失败」在
/// `data["exit_code"] == 2`。所以这里三个字段都原样透出，不做归一化 ——
/// 归一化会丢信息，前端要自己按命令判。
#[derive(Debug, Clone, Serialize)]
pub struct BackendOutcome {
    pub run_id: u64,
    pub cmd: String,
    /// 信封层成败
    pub ok: bool,
    /// 成功时的数据，原样透传
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// 失败时的结构化错误
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BackendErrorPayload>,
    /// 进程退出码。**注意它不反映 ingest 的部分失败**
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// stderr 快照。正常情况是空串；崩溃时是 Python traceback
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **这是本文件最重要的一条测试。**
    ///
    /// Python 侧 `_args()` 是覆盖语义（`merged[k] = v`），所以任何一个没加
    /// `skip_serializing_if` 的字段都会被序列化成 `null` 发过去，把 Python 的
    /// 默认值冲掉 —— 比如 `"device": null` 会覆盖默认的 `0` 再传给
    /// onnxruntime。加了新字段忘记抄那行属性时，这条会挂。
    #[test]
    fn default_args_serialize_to_empty_object() {
        let json = serde_json::to_string(&BackendArgs::default()).expect("序列化");
        assert_eq!(
            json, "{}",
            "所有 None 字段都必须被跳过。序列化出 null 会覆盖 Python 的默认值。"
        );
    }

    /// 只设一个字段时，不该带上别的键
    #[test]
    fn only_set_fields_are_serialized() {
        let args = BackendArgs {
            tags_all: Some(vec!["1girl".to_string(), "solo".to_string()]),
            ..Default::default()
        };
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&args).expect("序列化")).expect("解析");
        let obj = value.as_object().expect("应当是对象");
        assert_eq!(obj.len(), 1, "只该有 tags_all 一个键，实际：{obj:?}");
        // 键名必须保持 snake_case —— 加 rename_all = "camelCase" 会让
        // tags_all 变成 tagsAll，Python 侧静默忽略，搜索条件凭空失效
        assert!(obj.contains_key("tags_all"), "键名必须是 snake_case");
    }

    /// 请求信封在没参数时不该冒出 "args": null
    #[test]
    fn request_omits_missing_args() {
        let json = serde_json::to_string(&BackendRequest {
            cmd: "status",
            args: None,
        })
        .expect("序列化");
        assert_eq!(json, r#"{"cmd":"status"}"#);
    }
}
