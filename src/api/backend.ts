/**
 * Rust 后端命令的 TS 绑定层。
 *
 * 对应的 Rust 实现在 `src-tauri/src/backend/commands.rs`，
 * 契约文档在 `E:\Images\API.md`（**会持续演进，改这里之前先读一遍**）。
 *
 * # 三个必须记住的坑
 *
 * 1. **`BackendArgs` 的字段名必须是 snake_case**（`tags_all`、`min_conf`）。
 *    它直接变成 Python 侧的参数字典键。Rust 那边特意没加 `rename_all`，
 *    这里也不要加 —— 写成 `tagsAll` 会被 Python **静默忽略**，搜索条件凭空失效。
 *    （注意：只有 Tauri **命令自己的**参数名才是 camelCase，`args` 这个参数名
 *    本来就全小写，所以没问题。）
 *
 * 2. **成败要看的地方因命令而异**，别统一判：
 *    - 信封 `ok` —— 传输/执行层，所有命令都有
 *    - `data.exit_code` —— **只有 `ingest` 有**，且 inbox 为空时这个键不存在
 *    - `data.ok` —— **只有 `reindex` 有**，OneDrive 占位符导致没执行时是 `false`，
 *      但信封 `ok` 仍是 `true`。只判信封会把「什么都没做」显示成成功。
 *
 * 3. **事件和返回值的到达顺序不保证**（emit 走 webview 事件队列，返回值走
 *    invoke 响应通道）。所以：进度只信事件，最终摘要只信命令的返回值；
 *    并按 `run_id` 丢弃上一轮被取消的残留事件。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ImageItem } from "../modules/types";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/**
 * 所有命令共用的参数表，24 个键，全部可选。
 *
 * 字段名必须与 `E:\Images\backend\ipc.py` 的 `_COMMON_DEFAULTS` 逐字一致。
 *
 * **传 `undefined` 和传 `null` 不是一回事**：Rust 侧会把 `undefined` 的字段整个
 * 跳过（不出现在 JSON 里），而 Python 侧是**覆盖**语义（`merged[k] = v`）——
 * 传 `null` 会把 Python 的默认值冲掉，比如 `device: null` 会覆盖默认的 `0`
 * 再传给 onnxruntime。所以不确定的字段就**不要写**，别写 `null`。
 */
export interface BackendArgs {
  // 分页与运行控制（入库类命令用）
  /** 分页。`ingest` 时按顶层条目计数（一个合集算一项）。不传 = 不限制 */
  limit?: number;
  offset?: number;
  /** `ingest`：只推理不落盘 */
  dry_run?: boolean;
  /** `ingest`：强制 CPU */
  cpu?: boolean;
  /** `ingest`：GPU 设备号 */
  device?: number;
  /** `ingest`：只写 `_tags.json` 边车，不碰 XMP */
  no_xmp?: boolean;
  /** 跳过确认（占位符下载、`prune`） */
  yes?: boolean;
  /** `reindex`：删除 library 里已不存在的行。**需要同时传 `yes` 才真删** */
  prune?: boolean;
  /** `reindex`：忽略 journal，逐图读 XMP。最慢但最权威 */
  from_images?: boolean;
  general_threshold?: number;
  character_threshold?: number;

  // 检索
  /** `search`：全部命中（AND）。**用下划线原形**，如 `long_hair` 而非 `long hair` */
  tags_all?: string[];
  /** `search`：任一命中（OR） */
  tags_any?: string[];
  /** `search`：`general` / `sensitive` / `questionable` / `explicit` */
  rating?: ImageRating;
  /** `search`：**入库日** `YYYY-MM-DD`（不是拍摄日） */
  date?: string;
  shot_from?: string;
  shot_to?: string;
  /** `search` / `top_tags`：置信度下限。默认 0，**能查到当初没过阈值的 tag** */
  min_conf?: number;
  /**
   * `search` / `collection_tags`：合集 id。
   *
   * ⚠ 是**合集文件夹名**（如 `20260928-205303_a174e15fa7d6`），不是数据库
   * 整数主键 —— 后端所有 id 都是「磁盘上的名字」，传数字只会得到 `missing`。
   */
  coll_id?: string;
  /** `search`：合集名（大小写不敏感） */
  collection_key?: string;

  // 单点与合集
  /** `image_detail`：图片 id = **归档文件名的主干**（不含扩展名） */
  image_id?: string;
  /** `collection_tags`：合集名 */
  name?: string;
  /** `collections`：只列含该 tag 的合集 */
  tag?: string;
  /** `collections`：最低出现频率（配合 `tag`） */
  min_freq?: number;

  // delete（和 image_ids / coll_ids 至少给一个）
  /** `delete`：图片 id 数组（文件名主干） */
  image_ids?: string[];
  /** `delete`：合集 id 数组（文件夹名）。**会连整棵子树一起删** */
  coll_ids?: string[];
}

/** 四个分级之一 */
export type ImageRating = "general" | "sensitive" | "questionable" | "explicit";

// ---------------------------------------------------------------------------
// 返回
// ---------------------------------------------------------------------------

/** 信封里 `ok: false` 时 `error` 字段的形状 */
export interface BackendErrorPayload {
  code: string;
  message: string;
}

/** 一次成功 IPC 往返的完整结果。Rust 侧 `BackendOutcome` 的原样镜像 */
export interface BackendOutcome {
  run_id: number;
  cmd: string;
  /** 信封层成败。注意它**不反映** ingest 的部分失败，也不反映 reindex 的未执行 */
  ok: boolean;
  /** 成功时的数据。形状因命令而异，见各命令的返回类型 */
  data?: unknown;
  error?: BackendErrorPayload;
  /** 进程退出码。**ingest 部分失败时它仍是 0**，判断成败要看 `data.exit_code` */
  exit_code?: number;
  /** 正常为空；崩溃时是 Python traceback */
  stderr?: string;
}

/** Rust 侧 `BackendError` 序列化后的扁平对象（传输层失败） */
export interface BackendTransportErrorPayload {
  kind: "spawn" | "no_result" | "protocol" | "cancelled" | "busy" | "config";
  message: string;
  exit_code?: number;
  stderr?: string;
  raw?: string;
  run_id?: number;
  running?: string;
}

/**
 * 调用后端失败时抛出的统一错误。
 *
 * 两种失败被归一成同一个类型，调用方只需要 `catch (e)` 一次：
 * - **传输层**（进程起不来 / 没吐 result / 被取消 / 忙）—— Rust 返回 `Err`，走 reject
 * - **执行层**（信封 `ok: false`，比如配置错、SQL 错）—— Rust 返回 `Ok`，
 *   但这里主动抛出来。这种是「成功的 IPC 往返 + 失败的执行」，埋进异常更好用
 */
export class BackendCallError extends Error {
  /** 传输层失败时是 Rust 的 kind；执行层失败时是 `"backend"` */
  readonly kind: string;
  /** 后端的错误码，如 `config_error`。只有执行层失败才有 */
  readonly code?: string;
  /** 崩溃时的 Python traceback。**这是排查「为什么起不来」的唯一线索** */
  readonly stderr?: string;
  readonly exitCode?: number;

  constructor(
    message: string,
    init: { kind: string; code?: string; stderr?: string; exitCode?: number } = {
      kind: "unknown",
    },
  ) {
    super(message);
    this.name = "BackendCallError";
    this.kind = init.kind;
    this.code = init.code;
    this.stderr = init.stderr;
    this.exitCode = init.exitCode;
  }
}

function isTransportPayload(value: unknown): value is BackendTransportErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

// ---------------------------------------------------------------------------
// 调用核心
// ---------------------------------------------------------------------------

/**
 * 调一条命令，成功时返回 `data`。
 *
 * `args` 整个为 `undefined` 时不传这个参数 —— 让 Rust 侧的
 * `Option<BackendArgs>` 落到 `None`，请求里连 `args` 键都不会出现。
 */
async function call<T>(cmd: string, args?: BackendArgs): Promise<T> {
  let outcome: BackendOutcome;
  try {
    outcome = await invoke<BackendOutcome>(cmd, args ? { args } : {});
  } catch (raw) {
    // 传输层失败
    if (isTransportPayload(raw)) {
      throw new BackendCallError(raw.message, {
        kind: raw.kind,
        stderr: raw.stderr,
        exitCode: raw.exit_code,
      });
    }
    throw new BackendCallError(
      raw instanceof Error ? raw.message : String(raw),
      { kind: "unknown" },
    );
  }

  if (!outcome.ok) {
    throw new BackendCallError(
      outcome.error?.message ?? "后端返回了失败，但没有给出原因",
      {
        kind: "backend",
        code: outcome.error?.code,
        stderr: outcome.stderr,
        exitCode: outcome.exit_code,
      },
    );
  }

  return outcome.data as T;
}

// ---------------------------------------------------------------------------
// 各命令
// ---------------------------------------------------------------------------

/**
 * 库的整体状态。**前端启动时第一个调它**，用它决定显示「空库引导」还是「图库」。
 *
 * `model_exists: false` 时应当隐藏/禁用「开始打标」。
 */
export interface StatusData {
  db_exists: boolean;
  root: string;
  library: string;
  inbox: string;
  model_exists: boolean;
  schema_version: number;
  layout_version: number;
  device_id: string | null;
  images: number;
  collections: number;
  tags: number;
  inbox_pending: number;
  index_stale: boolean;
}

export function getStatus(): Promise<StatusData> {
  return call<StatusData>("backend_status");
}

export interface SearchData {
  /** **本次返回的条数**，不是总命中数 */
  count: number;
  images: ImageItem[];
}

/**
 * 按 tag / 分级 / 日期 / 合集查图。
 *
 * ⚠ 每次调用都是一次 Python 冷启动（150–300ms）。**别做「打字即搜」**，
 * 要么像现在这样回车才搜，要么加 debounce。
 */
export function search(args: BackendArgs): Promise<SearchData> {
  return call<SearchData>("backend_search", args);
}

export interface TagHit {
  tag: string;
  /** 0 = 普通，4 = 角色，9 = 分级 */
  category: number;
  confidence: number;
  passed: boolean;
}

export interface ImageDetailData {
  /** 找不到时是 `null`（**不是报错**） */
  image: ImageItem | null;
  tags: TagHit[];
}

export function getImageDetail(imageId: string): Promise<ImageDetailData> {
  return call<ImageDetailData>("backend_image_detail", { image_id: imageId });
}

export interface TopTagsData {
  tags: Array<{ tag: string; count: number }>;
}

export function getTopTags(args?: BackendArgs): Promise<TopTagsData> {
  return call<TopTagsData>("backend_top_tags", args);
}

export interface Collection {
  /** == 目录名，稳定身份。**这就是合集的 id** */
  coll_id: string;
  name: string;
  /** 0 = 根；1/2/3 = 父下的第 N 个子合集 */
  side: number;
  parent_coll_id: string | null;
  depth: number;
  dir_rel_path: string;
  date_dir: string;
  image_count: number;
}

export interface CollectionsData {
  /** **已按树序排好**（父在前，同级按 side）。按 depth 缩进即可，不用自己排 */
  collections: Collection[];
}

export function getCollections(args?: BackendArgs): Promise<CollectionsData> {
  return call<CollectionsData>("backend_collections", args);
}

export interface CollectionTagStat {
  tag: string;
  category: number;
  /** 过了阈值的图片数 */
  count: number;
  /** 只要落库就算，含低分 tag */
  count_loose: number;
  /** `count / image_count`，**后端算好的，直接用** */
  freq: number;
  avg_confidence: number;
}

export interface CollectionTagsData {
  collections: Array<Collection & { tags: CollectionTagStat[] }>;
}

/** 同名合集可能有多个（每次投放算一个新合集），**全部返回** */
export function getCollectionTags(args: BackendArgs): Promise<CollectionTagsData> {
  return call<CollectionTagsData>("backend_collection_tags", args);
}

// ---- 流式命令 ----
//
// 这几条会走单飞闸门：同一时刻只能跑一个，第二个会以 `kind: "busy"` 抛出来。
// 进度靠下面 onBackendEvent 收，**最终摘要靠这里的返回值**。

/** delete 里每张图的结果。`status` 的语义见文档的六条说明 */
export interface DeleteImageResult {
  image_id: string;
  rel_path?: string;
  /** 内部用的数据库 id，别拿它去调接口 */
  collection_id?: number | null;
  /** `deleted` = 真删了 / `would_delete` = dry_run 预演 / `partial` = 文件删不掉但库行已删 / `missing` = 本来就没有 */
  status: "deleted" | "would_delete" | "partial" | "missing";
}

export interface DeleteCollectionResult {
  coll_id: string;
  name?: string;
  status: "deleted" | "would_delete" | "partial" | "missing";
  /** 真删掉的文件名（`index.json`、journal、图片…） */
  removed?: string[];
}

export interface DeleteData {
  images: DeleteImageResult[];
  collections: DeleteCollectionResult[];
  /** 合集下有图片被删、`image_count` 变了的那些 */
  refreshed_collections: Array<{
    coll_id: string;
    name: string;
    image_count: number;
  }>;
  journal_entries_removed: number;
  totals: {
    images: number;
    collections: number;
    missing: number;
    /** `partial` 的数量 —— 文件没删掉（被占用）但库行已经删了 */
    leftover: number;
  };
  /** true = 预演，什么都没动 */
  dry_run: boolean;
}

/**
 * 删除图片 / 合集。**不可逆** —— 文件、`_tags.json` 边车、嵌在图里的 XMP 一起消失。
 * 这是唯一自洽的语义：library 是真相源，只删库行的话 `reindex` 会把它们复活。
 *
 * `image_ids` / `coll_ids` **至少给一个**，可以混用。删合集会连**整棵子树**一起删。
 *
 * 幂等：重发同一批参数得到 `missing`，不是报错 —— 中断之后重发一遍即可收尾。
 * 建议先传 `dry_run: true` 让用户确认，再真删。
 *
 * ⚠ 传数据库数字（如 `"1"`）会得到 `missing`。id 是磁盘上的名字。
 */
export function runDelete(args: BackendArgs): Promise<DeleteData> {
  return call<DeleteData>("backend_delete", args);
}

export interface IngestData {
  total: number;
  ok: number;
  dupe: number;
  failed: number;
  collections: number;
  seconds: number;
  /** ⚠ **inbox 为空时这个键不存在**，用可选链读 */
  exit_code?: number;
  failures?: Array<{ name: string; reason: string }>;
}

/** 处理 `inbox/`。**成败看 `data.exit_code`（0 全成功 / 2 部分失败）**，不是信封 ok */
export function runIngest(args?: BackendArgs): Promise<IngestData> {
  return call<IngestData>("backend_ingest", args);
}

export interface ReindexData {
  /** ⚠ **成败看这里**，不是信封的 ok。OneDrive 占位符导致没执行时是 false */
  ok: boolean;
  [key: string]: unknown;
}

/** 从 `library/` 重建索引（不需要模型）。`prune` 时必须同时传 `yes` 才真删 */
export function runReindex(args?: BackendArgs): Promise<ReindexData> {
  return call<ReindexData>("backend_reindex", args);
}

export interface VerifyData {
  checked: number;
  bad: number;
}

export function runVerify(args?: BackendArgs): Promise<VerifyData> {
  return call<VerifyData>("backend_verify", args);
}

export interface CheckData {
  xmp_ok: boolean;
  problems: string[];
  /** XMP 自检失败时是 null */
  gpu: {
    provider: string;
    ms: number;
    target_size: number;
    tags_in_csv: number;
    warning: string | null;
  } | null;
}

/** 自检：GPU 加速 + XMP 段链往返。XMP 部分不依赖模型 */
export function runCheck(args?: BackendArgs): Promise<CheckData> {
  return call<CheckData>("backend_check", args);
}

// ---------------------------------------------------------------------------
// 取消与事件
// ---------------------------------------------------------------------------

/**
 * 取消正在跑的流式命令。没有在跑时返回 `false`（幂等）。
 *
 * 取消就是**直接 kill 进程**。后端的崩溃安全设计保证已归档的图片安全留在
 * library，未完成的记录是 `pending`，下次启动自动收拾。取消后可以提示
 * 「已取消，已处理的 N 张已安全入库」。
 */
export function cancelBackend(): Promise<boolean> {
  return invoke<boolean>("backend_cancel");
}

/** 流式命令推给前端的事件 */
export interface BackendEvent {
  /** 本次运行的 id。用来丢弃上一轮被取消的残留事件 */
  run_id: number;
  /** 单调递增序号 */
  seq: number;
  /**
   * 事件名，**原样来自后端，不做枚举**。已知的有：
   * `model_loading` / `model_ready` / `log` / `warning` / `collection_start` /
   * `image_done` / `progress` / `collection_done` / `run_done` /
   * `check_xmp` / `check_gpu`（最后两个文档里没写，只在 `check` 时出现）
   */
  event: string;
  data: Record<string, unknown>;
}

/**
 * 订阅后端事件。返回退订函数。
 *
 * `run_id` 用来过滤：命令返回（或被取消）之后，上一轮的读线程可能还会吐出
 * 缓冲区里的几行，前端应当丢弃它们，否则旧进度会污染新一轮的显示。
 */
export function onBackendEvent(
  handler: (event: BackendEvent) => void,
): Promise<UnlistenFn> {
  return listen<BackendEvent>("backend://event", (e) => handler(e.payload));
}
