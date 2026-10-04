/**
 * 四个分级之一。取值按 danbooru 的惯例推断，若后端用的是别的字面量，改这里即可。
 */
export type ImageRating = "general" | "sensitive" | "questionable" | "explicit";

/**
 * 一条图片记录，对应磁盘上的一个图片文件。
 * 字段与后端返回的 JSON 一一对应，不要随手改名。
 */
export interface ImageItem {
  /**
   * 图片 id = **归档文件名的主干**（不含扩展名），比如
   * `20260928-044002_20260928-044002_c772aa6ea37f`。
   *
   * ⚠ 不是数据库主键。后端所有 id 都是「磁盘上的名字」——跨设备稳定，
   * 换台设备重建数据库也不会变。传数据库数字会得到 `missing`。
   */
  image_id: string;
  /** 相对项目根的路径 */
  rel_path: string;
  /** 绝对路径。不能直接给 <img src>，要先过 convertFileSrc，见 ImageCard.vue */
  abs_path: string;
  /** 入库后的文件名 */
  filename: string;
  /** 入库前的原始文件名 */
  origin_name: string;
  /**
   * 文件修改时间，形如 "2026-09-28T03:23:52"。
   * 后端给的是本地时间、不带时区，所以别直接 new Date() 当 UTC 使唤。
   */
  mtime: string;
  /** 文件创建时间，格式同 mtime */
  ctime: string;
  /** EXIF 拍摄时间；图里没有 EXIF 时为 null */
  shot_at: string | null;
  width: number;
  height: number;
  /** 分级 */
  rating: ImageRating;
  /** 分级模型的置信度，0~1 */
  rating_score: number;
  /** 过阈值的 tag 数量 */
  tag_count: number;
  /** 逗号分隔的 tag 串，下划线已转成空格 */
  prompt: string;
  /**
   * 所属合集的**数据库 id**（内部用，别拿它去调接口）。
   * 对外定位合集用 `coll_id`（= 合集文件夹名）；它没有出现在 image 对象里，
   * 但可以从 `rel_path` 取中间那一段推出来。
   */
  collection_id: number | null;
  /** tag 写入方式：1 = 已嵌进图片的 XMP，0 = 写在边车文件里 */
  xmp_ok: 0 | 1;
}
