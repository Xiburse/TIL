import { defineStore } from "pinia";
import { computed, ref } from "vue";

import type { ImageItem } from "../modules/types";

/**
 * 图片详情面板的全局状态。
 *
 * 右键图片 → `openDetail()` 把信息挂进来 → 详情面板读这个 store 渲染。
 * 好处是不用再把 `openDetail` 事件从 ImageCard 一路转发过列、网格到 App ——
 * 组件树里任何一层都能直接读/写。
 *
 * # 存了什么
 *
 * **详情图片的完整信息**（`image`）：
 *
 * | 你要的 | 对应 `ImageItem` 字段 |
 * |---|---|
 * | 名字 | `origin_name`（入库前）/ `filename`（入库后） |
 * | 地址 | `abs_path`（给 `<img>` 用）/ `rel_path` |
 * | 标签 | `prompt`（逗号分隔）+ `tag_count` |
 * | 时间 | `mtime` / `ctime` / `shot_at`（EXIF，可能 null） |
 *
 * 另有尺寸、分级、合集、XMP 状态等 —— 整个 `ImageItem` 存进来，不拆成散字段。
 * 拆散就得和 `modules/types.ts` 的结构重复一遍，后端加字段要改两处。
 *
 * **面板的定位**（`side` / `top`）。
 *
 * # 为什么 DOM 元素不在 state 里
 *
 * `HTMLElement` 放进 `ref`/`reactive` 会被深度代理，出各种怪问题（`instanceof`
 * 判断、性能、DevTools 卡顿）。所以定位要用的两个元素放在 store 闭包里的
 * **普通变量**中 —— 它们只用于读位置，不需要驱动渲染。
 */

/** 面板纵向至少留这么高（px）。没有它的话右键最下面那行图，面板只剩一条缝 */
const MIN_PANEL_HEIGHT = 280;

export const useImageDetailStore = defineStore("imageDetail", () => {
  // ---------------------------------------------------------------------------
  // 状态（响应式）
  // ---------------------------------------------------------------------------

  /** 详情图片的完整信息。null = 面板没开 */
  const image = ref<ImageItem | null>(null);

  /**
   * 面板贴 app-main 的哪一边。
   *
   * 值是**面板所在的那一侧**（不是「图片在哪边」）：图片偏左时是 `right`。
   * 除了定位，还用来翻转面板圆角 —— 贴图片那侧平、外侧圆。
   */
  const side = ref<"left" | "right">("right");

  /** 面板距 app-main 顶部的像素 */
  const top = ref(0);

  const isOpen = computed(() => image.value !== null);

  // ---------------------------------------------------------------------------
  // 详情信息的便捷访问（名字 / 地址 / 标签 / 时间）
  //
  // 底层数据仍然是 `image` 这一个来源，这里只是把「看图信息」常要用的几项
  // 提到 store 顶层，调用方不用记 ImageItem 的字段名。
  // 面板之外的组件（状态栏、导出对话框…）也能直接读这些。
  // ---------------------------------------------------------------------------

  /** 名字：入库前的原始文件名；没有就退到入库后的文件名 */
  const name = computed(() => image.value?.origin_name ?? image.value?.filename ?? "");

  /** 地址：磁盘绝对路径（给 `<img>` 用，需过 convertFileSrc） */
  const path = computed(() => image.value?.abs_path ?? "");

  /** 标签：逗号分隔的完整 tag 串（下划线已转空格） */
  const tags = computed(() => image.value?.prompt ?? "");

  /** 标签数：过了阈值的那部分 */
  const tagCount = computed(() => image.value?.tag_count ?? 0);

  /** 时间：文件修改时间 `YYYY-MM-DDTHH:mm:ss` */
  const mtime = computed(() => image.value?.mtime ?? "");

  /** 时间：文件创建时间 */
  const ctime = computed(() => image.value?.ctime ?? "");

  /** 时间：EXIF 拍摄时间。图里没有 EXIF 就是 null */
  const shotAt = computed(() => image.value?.shot_at ?? null);

  // ---------------------------------------------------------------------------
  // 非响应式：DOM 元素只用来读位置，不参与渲染
  // ---------------------------------------------------------------------------

  /** 被右键的卡片根元素，位置从它身上读 */
  let anchor: HTMLElement | null = null;

  /** `.app-main` —— 面板的定位区 */
  let area: HTMLElement | null = null;

  let observer: ResizeObserver | null = null;

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  /**
   * 算面板该贴哪边、贴多高。
   *
   * - **左右**：看图片左上角在 app-main 里的 x，偏左 → 面板贴**右**边，
   *   偏右 → 贴**左**边。这样面板永远不压在被点的那张图上。
   *   （需求说的是「以图片左上角的位置在 app-main 里的位置决定」，
   *   所以判左右只看左上角，不看图片中心。）
   * - **上下**：`top` 对齐图片左上角的 y，再钳到 [0, app-main 高 - MIN_PANEL_HEIGHT]。
   *
   * 宽度和高度上限不在这算 —— 那两条由面板的 CSS 负责（`calc(100% / 3)` 宽、
   * `max-height: calc(100% - top)`），跟着容器缩放，不用 JS 维护。
   */
  function reposition(): void {
    if (!anchor || !area) return;

    const areaRect = area.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();

    const anchorLeftInArea = anchorRect.left - areaRect.left;
    side.value = anchorLeftInArea < areaRect.width / 2 ? "right" : "left";

    const maxTop = Math.max(0, areaRect.height - MIN_PANEL_HEIGHT);
    top.value = Math.min(Math.max(0, anchorRect.top - areaRect.top), maxTop);
  }

  /**
   * 右键图片时调用：挂上信息并定位。
   *
   * @param img   这张图的完整信息
   * @param el    卡片根元素（用来算位置）
   */
  function openDetail(img: ImageItem, el: HTMLElement): void {
    image.value = img;
    anchor = el;
    reposition();
  }

  /** 关掉面板 */
  function closeDetail(): void {
    image.value = null;
    anchor = null;
  }

  /**
   * 登记定位区（`.app-main`）。
   *
   * 顺带挂上 ResizeObserver —— 窗口缩放、功能列变宽都会让瀑布流重新分列、
   * 图片位置跟着变，不重算面板会停在旧位置。
   */
  function registerArea(el: HTMLElement): void {
    area = el;
    observer?.disconnect();
    observer = new ResizeObserver(() => {
      // 图片可能已经被新查询换掉了（元素脱离文档），这时候只能关掉
      if (!anchor?.isConnected) {
        closeDetail();
        return;
      }
      reposition();
    });
    observer.observe(el);
  }

  /** 解绑定位区。组件卸载时调用，不然 ResizeObserver 会一直挂着 */
  function unregisterArea(): void {
    observer?.disconnect();
    observer = null;
    area = null;
  }

  return {
    // 状态
    image,
    side,
    top,
    isOpen,
    // 详情信息（名字 / 地址 / 标签 / 时间）
    name,
    path,
    tags,
    tagCount,
    mtime,
    ctime,
    shotAt,
    // 动作
    openDetail,
    closeDetail,
    reposition,
    registerArea,
    unregisterArea,
  };
});
