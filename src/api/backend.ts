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

  // tag_suggest（输入框候选）
  /**
   * `tag_suggest`：输入串，匹配名字**含**它的 tag。**必传**（空串是合法的，
   * 输入框清空是常态）。
   *
   * 大小写不敏感，空格转下划线（打 `long hair` 等于 `long_hair`）。
   * 不传的话 Python 侧按 `null` 处理、静默回空列表，和「这个词没有候选」
   * 长得一模一样 —— 前端会以为是自己查错了。
   */
  query?: string;

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
  kind:
    | "spawn"
    | "no_result"
    | "protocol"
    | "cancelled"
    | "busy"
    | "config"
    /** 被后来的同名请求顶掉了（限流）。**不是故障**，见 `tagSuggest` 的说明 */
    | "superseded";
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

  /**
   * 被限流顶掉了（见 Rust 侧 `throttle.rs`）。
   *
   * **这不是失败**：只有限流的命令（现在只有 `tag_suggest`）会产生，而且只会
   * 落在「排队期间又来了一条更新的」那种请求上 —— 它的结果本来就没人要了。
   * 调用方**直接忽略**，既不弹提示也不走错误分支。
   */
  get superseded(): boolean {
    return this.kind === "superseded";
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

/** `tag_suggest` 返回里的一条候选 */
export interface TagSuggestion {
  /** tag 的**下划线原形**（`long_hair`），不是显示用的空格形式 */
  tag: string;
  /** 0 = 普通，4 = 角色，9 = 分级 */
  category: number;
  /** 有多少张图带这个 tag。口径受 `min_conf` 支配，默认含没过阈值的 */
  count: number;
}

export interface TagSuggestData {
  /** 回显这次的输入串 */
  query: string;
  /** 命中总数（**`limit` 截断之前**），可用来显示「还有更多」 */
  total: number;
  /** **已按图数从多到少排好，同数的按字母序 —— 顺序直接就是显示顺序** */
  tags: TagSuggestion[];
}

/**
 * 按字母补全 tag，各带图数。给输入框做候选用。
 *
 * 匹配是「**包含**」不是前缀，大小写不敏感，空格转下划线。`limit` 默认 50。
 * 源是 CSV 词表而不是数据库，所以会回出**库里一张图都没有的 tag**（`count: 0`，
 * 排在最后、默认被 `limit` 截掉）。
 *
 * ⚠ **别做前端防抖。** 每敲一个字母发一次是设计好的：Rust 侧有一道 200ms 的
 * 限流闸门，窗口内挤进来的请求只留最新那条，其余的直接以 `kind: "superseded"`
 * 抛出来（用 `e.superseded` 判）。**拿到它直接忽略** —— 输入框里每敲一下都可能
 * 产生几条，弹提示就是刷屏；真正要显示的是最后那条没被顶掉的。
 */
export function tagSuggest(args: BackendArgs): Promise<TagSuggestData> {
  return call<TagSuggestData>("backend_tag_suggest", args);
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

// ---------------------------------------------------------------------------
// 待入库（inbox）
// ---------------------------------------------------------------------------

/**
 * `inbox/` 里的一张图。**没有 `image_id`** —— 它还没入库，那是入库后才有的名字，
 * 所以定位它只能靠 `rel_path`（顶层散图另有 `kind: "image"`，这里不依赖它）。
 */
export interface InboxImage {
  /** 文件名（含扩展名） */
  name: string;
  /** 相对项目根的路径 */
  rel_path: string;
  /** 绝对路径。给 `<img>` 用之前要先过 convertFileSrc，见 InboxCard.vue */
  abs_path: string;
  /**
   * **显示**尺寸 —— EXIF 旋转已套用，和入库后 `images.width` / `height` 同一个
   * 口径（竖拍图不会差一次宽高对调）。
   *
   * `null` = **连文件头都读不了**（签名不对 / chunk 结构坏了 / 根本不是图片），
   * 这种必然入库失败。
   *
   * ⚠ **反过来不成立**：读文件头不解码像素，所以**像素数据被截断的图照样报得出
   * 尺寸** —— 实测一张截半的 PNG 这里仍回 `1458x2500`，而 `ingest` 解码时会失败。
   * 尺寸能用来**排版和显示**，不能当「必能入库」的保证。
   *
   * ⚠ EXIF 朝向**只对 JPEG 读**，带旋转元数据的 PNG 这里报的是原始尺寸。
   */
  width: number | null;
  height: number | null;
  /** 文件字节数。`null` 的语义同 `width` / `height` */
  size_bytes: number | null;
}

/**
 * `inbox/` 里的一个合集 —— 子合集**递归嵌套**在 `children` 里。
 *
 * 两个「图片数」别搞混：`image_count` 是**本层直接**的图片数，`image_total` 含
 * 全部后代。父层加子层会**重复计**，要「总共有多少」只看顶层的 `total_images`。
 */
export interface InboxCollection {
  kind: "collection";
  name: string;
  rel_path: string;
  abs_path: string;
  /** 0 = 根合集 */
  depth: number;
  /** 同级序号，父下的第 N 个 */
  side: number;
  /** **本层直接**图片数 */
  image_count: number;
  /** **整棵子树**的图片数（含全部后代） */
  image_total: number;
  images: InboxImage[];
  /** 不是图片、入库时会被跳过的文件 */
  skipped_files: string[];
  /** 超过 max_coll_depth 而被忽略的子目录 */
  skipped_dirs: string[];
  children: InboxCollection[];
}

/** 顶层条目：散图或合集 */
export type InboxEntry = (InboxImage & { kind: "image" }) | InboxCollection;

export interface InboxScanData {
  /** **整棵树的图片总数** —— 「待入库多少张图」看它，不是 `status.inbox_pending` */
  total_images: number;
  /** 顶层散图数 */
  loose_count: number;
  /** 顶层合集数 */
  collection_count: number;
  /** 顶层条目，**已按名字排好**（和文件夹里看到的一致）。顺序就是显示顺序 */
  items: InboxEntry[];
}

/**
 * 待入库清单：`inbox/` 里有哪些散图、哪些合集（合集递归嵌套）。
 *
 * 给前端展示用 —— 用户先看清楚有什么，再决定怎么入库。**不带参数**。
 *
 * ⚠ 它**不加载模型、不碰数据库**，但每张图要开一次文件头读尺寸，所以比纯目录
 * 扫描贵一点（实测约 0.19s，19 张）。可以在用户拖完文件夹后立刻调。
 * 也是**只读**的：调多少次都不会改变 inbox。
 *
 * ⚠ **进不进列表只看扩展名** —— 像素数据被截断的 `.jpg` 也会出现在这里（而且
 * 尺寸照样报得出来，见 `InboxImage`），能不能真入库要等 `ingest` 才知道。
 * 别拿这个列表当「必能成功」的保证。
 */
export function inboxScan(): Promise<InboxScanData> {
  // 不带参数：让 Rust 侧的 `Option<BackendArgs>` 落到 None，请求里连 args 键都没有
  return call<InboxScanData>("backend_inbox_scan");
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
