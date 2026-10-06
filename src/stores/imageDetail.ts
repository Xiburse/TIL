import { defineStore } from "pinia";
import { computed, nextTick, ref } from "vue";

import {
  getCollectionTags,
  type CollectionTagStat,
} from "../api/backend";
import type { ImageItem } from "../modules/types";
import { collectionKeyOf, imageKey, type CollectionRef } from "../modules/wall";

/**
 * 面板的全局状态与定位。
 *
 * 右键卡片 → `openDetail()` 把**目标**挂进来 → 详情面板读这个 store 渲染。
 * 好处是不用再把 `openDetail` 事件从卡片一路转发过列、网格到 App ——
 * 组件树里任何一层都能直接读/写。
 *
 * # 面板区有**两块**面板，各自独立
 *
 * | kind | 组件 | 什么时候开 | 看什么 |
 * |---|---|---|---|
 * | `detail` | `DetailPanel` | **右键**一条 | 一张图（元信息 + 标签）或一个合集（元信息 + tag 频次） |
 * | `images` | `CollectionImagesPanel` | **左键**一个合集 | 那个合集的图，竖着一列 |
 *
 * 两块**可以同时开着**，而且这正是常见用法：左键开一个合集看里面的图，再右键其中
 * 一张看它自己的详情 —— 合集那一栏留着不动。所以「开着什么」「摆在哪儿」「锚点是
 * 哪个元素」都得**各有一套**，不能共用一个槽位（早先就是共用的，代价是开一块必然
 * 顶掉另一块）。
 *
 * # 定位
 *
 * 两块面板共用一套算法（`computePosition`）：贴住各自的锚点卡片、**互相躲开**
 * （都在场时不叠在一起）、整体钳进 app-main。锚点/面板元素/观察者则各一份 ——
 * 见下面那两组变量。
 *
 * # 为什么 DOM 元素不在 state 里
 *
 * `HTMLElement` 放进 `ref`/`reactive` 会被深度代理，出各种怪问题（`instanceof`
 * 判断、性能、DevTools 卡顿）。所以定位要用的那些元素放在 store 闭包里的
 * **普通变量**中 —— 它们只用于读位置，不需要驱动渲染。
 */

/**
 * 箭头从面板内侧边探出多远（px）。
 *
 * 面板的内侧边和卡片之间就留这么宽一条缝，箭头正好填满 —— 尖头顶到卡片边，
 * 看上去面板和箭头是一体的（做法见 `src/styles/panel.css` 的 `.panel__arrow`）。
 *
 * 组件只把它写进 `--panel-arrow-tip` 这一条 CSS 变量，箭头自己的尺寸和偏移
 * 都由它在 CSS 里推出来，所以「缝留多宽」和「箭头多大」永远是同一个数。
 */
export const ARROW_TIP = 8;

/** 合集是从哪儿来的。决定开面板之前要不要先拉 tag 频次表 */
export type DetailSource = "library" | "inbox";

/**
 * 「最后一次真正的 key」——只给 <Transition :key> 用。
 *
 * 关闭时 detailTarget 变 null，detailKey 会跟着变空串；而 <Transition> 同一帧
 * 看到「key 从 i:123 变 ""」会判成「换了另一个元素」而不是「同一元素移除」，
 * 于是直接卸载、leave 流程被跳过（退场动画没了）。所以另存一份：开面板时更新，
 * 关闭时**不动**。这样关闭时 key 保持不变、只有 v-if 变 false，leave 正常走。
 */
const lastDetailKey = ref("");
const lastImagesKey = ref("");


/**
 * 库页的合集详情 —— 开面板**之前**就拉好的那一份。
 *
 * `CollectionRef` 里那份是从 `rel_path` 推出来的占位（名字是文件夹名、张数未知），
 * 这里才是后端认得的真值。待入库的合集没有这一份，也用不着（`ref` 里全有）。
 */
export interface CollectionDetail {
  name: string;
  /** 本层直属图片数 */
  imageCount: number;
  dirPath: string;
  dateDir: string | null;
  /** tag 频次表。**后端已按出现张数排好序**，直接显示即可 */
  tags: CollectionTagStat[];
}

/** 详情面板正在看的东西 */
export type DetailTarget =
  | { kind: "image"; image: ImageItem }
  | {
      kind: "collection";
      ref: CollectionRef;
      source: DetailSource;
      /**
       * 库页：`openCollection` 预先拉回来的那份。**拉不到时是 null**（面板据此
       * 说明「没能读到」），不是「还在路上」—— 面板挂载时它一定已经有结论了。
       *
       * 待入库页：**永远是 null**，那是设计如此，不是失败。
       */
      detail: CollectionDetail | null;
    };

/** 面板区那两块面板 —— 定位、登记、关闭都要指名道姓说是哪一块 */
export type PanelKind = "detail" | "images";

/**
 * 详情目标的稳定 key。
 *
 * 面板外面套着 `<Transition :key>`：换一条时 Vue 要把它认成「旧的走、新的来」
 * 而不是「同一块面板改了内容」，否则退场动画会变成「原地闪现新内容再缩掉」。
 * 用的就是**墙上那条的 key**（`modules/wall.ts` 那一套），不是面板自己的。
 */
export function targetKey(target: DetailTarget): string {
  return target.kind === "image"
    ? imageKey(target.image.image_id)
    : collectionKeyOf(target.ref);
}

/** 一块面板摆在哪儿。都是相对 app-main 的像素值 */
export interface PanelPos {
  /** 面板在锚点卡片的哪一侧（同时决定箭头朝向和圆角方向） */
  side: "left" | "right";
  /** 面板左边缘距 app-main 左边多远 */
  left: number;
  /** 面板顶边距 app-main 顶部多远 */
  top: number;
  /** 箭头中心距面板顶边多远 —— 也是展开动画的起点 */
  arrowY: number;
}

/**
 * 算一块面板该放哪。
 *
 * 三条规则，按这个顺序：
 *
 * 1. **贴住锚点卡片**。卡片在 app-main 左半边 → 面板放它**右**边，否则放左边
 *    （永远不挡住被点的那条）。内侧边离卡片留 `ARROW_TIP` 的缝，箭头正好填进去。
 * 2. **躲开另一块面板**。两块可能同时开着（图片栏 + 它里面某张图的详情），
 *    按第 1 条算出来的位子要是和另一块**撞上了**，就改贴到那一块的外侧，
 *    挑空得多的一边 —— 两块各占 1/3 宽，两侧空着的加起来是 2/3，所以总有
 *    一边塞得下，不会真的叠在一起。
 * 3. **整体钳进 app-main**，别戳出去。
 *
 * 纵向照旧：面板**中心**对准卡片竖直中线，再钳进 app-main。所以面板多高都不受
 * 卡片位置牵制，卡片贴着屏幕底边时面板一样能往上铺满。
 *
 * **导出是为了能单独验算**：它只认矩形、不碰 store 里任何状态，是这段布局里唯一
 * 能脱离浏览器验的部分。
 */
export function computePosition(opts: {
  areaRect: DOMRect;
  anchorRect: DOMRect;
  /** 面板自己多高。还不知道（没挂上）就先按 0 算，挂上后 `registerPanel` 会重算 */
  panelHeight: number;
  /** 另一块面板占的横向区间（相对 area 左边），要躲开；没开就给 null */
  avoid: { left: number; right: number } | null;
}): PanelPos {
  const { areaRect, anchorRect, panelHeight, avoid } = opts;

  // 面板宽度由 CSS 定死成 app-main 的 1/3。这里要拿它推位置，得自己算一遍
  const panelWidth = areaRect.width / 3;
  const anchorLeft = anchorRect.left - areaRect.left;

  // 1. 贴住锚点
  let side: "left" | "right" = anchorLeft < areaRect.width / 2 ? "right" : "left";
  let wanted =
    side === "right"
      ? anchorRect.right - areaRect.left + ARROW_TIP
      : anchorLeft - ARROW_TIP - panelWidth;

  // 2. 和另一块撞上了 → 改贴它的外侧
  if (avoid && wanted < avoid.right && wanted + panelWidth > avoid.left) {
    const freeRight = areaRect.width - avoid.right;
    const freeLeft = avoid.left;
    side = freeRight >= freeLeft ? "right" : "left";
    wanted =
      side === "right"
        ? avoid.right + ARROW_TIP
        : avoid.left - ARROW_TIP - panelWidth;
  }

  // 3. 钳进 app-main
  const left = Math.min(
    Math.max(0, wanted),
    Math.max(0, areaRect.width - panelWidth),
  );

  const centerY = anchorRect.top + anchorRect.height / 2 - areaRect.top;
  const maxTop = Math.max(0, areaRect.height - panelHeight);
  const top = Math.min(Math.max(0, centerY - panelHeight / 2), maxTop);

  // 箭头对准卡片竖直中点；换算成「距面板顶边」的量，CSS 那边再钳进面板内
  return { side, left, top, arrowY: centerY - top };
}

export const useImageDetailStore = defineStore("imageDetail", () => {
  // ---------------------------------------------------------------------------
  // 状态（响应式）
  // ---------------------------------------------------------------------------

  /** 详情面板正在看的东西。null = 那块没开 */
  const detailTarget = ref<DetailTarget | null>(null);

  /**
   * 合集图片栏开着的是哪个合集。null = 那块没开。
   *
   * ⚠ **只记身份，不记图。** 图由页面自己从它的墙上条目里按 `collectionKeyOf(ref)`
   * 取回来（两页各写一小段，见 `openCollectionImages` 的说明）—— store 是两页共用
   * 的，而两页的图片记录**形状不同**（库里是 `ImageItem`、待入库是 `InboxImage`），
   * 真把图塞进来就只能声明成联合类型，页面取回去还得断言。身份放这儿、数据留页面，
   * 类型从头到尾都是准的。
   */
  const imagesRef = ref<CollectionRef | null>(null);

  /** 两块面板各自的摆位。每块一份，互不干扰 */
  const detailPos = ref<PanelPos>({ side: "right", left: 0, top: 0, arrowY: 0 });
  const imagesPos = ref<PanelPos>({ side: "right", left: 0, top: 0, arrowY: 0 });

  /**
   * 详情面板的 key。两处用它：
   *
   * - 驱动 `<Transition>` 换实例（旧的走、新的来）；
   * - 卡片判「我是不是正被某块面板指着」（ImageCard 的选中放大态，见 `imagesKey`）。
   *
   * 之所以是个字符串而不是让卡片去比对象：比字符串时，换目标只让真正相关的那两张
   * 卡片重算。没开时是空串，和任何 key 都不相等。
   */
  const detailKey = computed(() =>
    detailTarget.value ? targetKey(detailTarget.value) : "",
  );

  /** 图片栏的 key。同一个合集算出来和详情那条**一样**（都是 `c:<路径>`） */
  const imagesKey = computed(() =>
    imagesRef.value ? collectionKeyOf(imagesRef.value) : "",
  );

  const detailOpen = computed(() => detailTarget.value !== null);
  const imagesOpen = computed(() => imagesRef.value !== null);

  // ---------------------------------------------------------------------------
  // 详情信息的便捷访问（名字 / 地址 / 标签 / 时间）
  //
  // 底层数据仍然是 `detailTarget` 这一个来源，这里只是把「看图信息」常要用的几项
  // 提到 store 顶层，调用方不用记 ImageItem 的字段名。
  // 面板之外的组件（状态栏、导出对话框…）也能直接读这些。
  //
  // ⚠ **这些只对单图有意义。** 目标是合集时一律给空值 —— 合集没有 `prompt` /
  // 尺寸 / EXIF 这些东西，硬凑一个出来只会让调用方拿到看着像真的的假数据。
  // 合集的字段在 `detailTarget.ref` 里，面板自己读。
  // ---------------------------------------------------------------------------

  /** 当前看的单图。目标不是单图时是 null */
  const image = computed(() =>
    detailTarget.value?.kind === "image" ? detailTarget.value.image : null,
  );

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
  //
  // 两块面板各一组：自己的锚点卡片、自己的根元素、自己盯高度的观察者。
  // ---------------------------------------------------------------------------

  /** 被右键/左键的那张卡片，位置从它身上读 */
  let detailAnchor: HTMLElement | null = null;
  let imagesAnchor: HTMLElement | null = null;

  /**
   * 两块面板各自的根元素。
   *
   * 面板要竖直居中，就得知道自己多高 —— 高度是内容撑的（预览图加载完、删掉几个
   * tag、合集那张 tag 表拉回来都会变），只能量。所以面板挂载时把元素登记进来。
   */
  let detailEl: HTMLElement | null = null;
  let imagesEl: HTMLElement | null = null;

  let detailObserver: ResizeObserver | null = null;
  let imagesObserver: ResizeObserver | null = null;

  /** `.app-main` —— 两块面板共用的定位区 */
  let area: HTMLElement | null = null;

  let areaObserver: ResizeObserver | null = null;

  /**
   * 打开合集详情的请求序号 —— 用来丢弃「晚到的旧请求」。
   *
   * 右键是可以连着来的：连着右键两个合集，第一个的后端调用可能比第二个还慢，
   * 回来的顺序颠倒 —— 不管的话，面板会先显示第二个、再被第一个顶掉。
   * `openDetail` 和 `closeDetail` 都要自增：前者作废更早的请求，后者保证
   * Esc 关掉之后那个还在飞的请求不会把面板又弹出来。
   */
  let detailSeq = 0;

  // ---------------------------------------------------------------------------
  // 定位
  // ---------------------------------------------------------------------------

  /**
   * 另一块面板占的横向区间（相对 area 左边）；那块没开就返回 null。
   *
   * 宽度直接用 `areaRect.width / 3`：面板宽度是 CSS 写死的 app-main 三分之一，
   * 和这里推出来的是同一个数（见 `computePosition`），不用去量 DOM。
   */
  function spanOf(
    anchor: HTMLElement | null,
    pos: PanelPos,
    areaRect: DOMRect,
  ): { left: number; right: number } | null {
    if (!anchor) return null;
    return { left: pos.left, right: pos.left + areaRect.width / 3 };
  }

  /**
   * 重算两块面板的位置。任何一处变化都走它 —— 开面板、面板挂上、面板高度变了、
   * app-main 变了（窗口缩放、功能列折叠都会）。
   *
   * 两块都在场时**互相躲开**（见 `computePosition`）。这里先算详情、再算图片栏，
   * 后者读到的是前者**这一轮刚定下来**的位子，所以一轮就收敛；反过来也一样。
   * 不会来回振荡 —— 每次调用都由事件触发（不是响应式循环），最坏情况是某个刁钻
   * 尺寸下两块谁躲谁的先后不理想，而不是无限循环。
   */
  function repositionAll(): void {
    if (!area) return;
    const areaRect = area.getBoundingClientRect();

    if (detailAnchor) {
      detailPos.value = computePosition({
        areaRect,
        anchorRect: detailAnchor.getBoundingClientRect(),
        panelHeight: detailEl?.offsetHeight ?? 0,
        avoid: spanOf(imagesAnchor, imagesPos.value, areaRect),
      });
    }

    if (imagesAnchor) {
      imagesPos.value = computePosition({
        areaRect,
        anchorRect: imagesAnchor.getBoundingClientRect(),
        panelHeight: imagesEl?.offsetHeight ?? 0,
        avoid: spanOf(detailAnchor, detailPos.value, areaRect),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  /**
   * 打开**详情面板**。合集请走 `openCollection`（库页那份得先把频次表拉回来）。
   *
   * 面板上的 `<Transition :key>` 由页面拿 `detailKey` 给，所以这里是「旧的走、
   * 新的来」，而不是「同一块面板改了内容」。
   *
   * @param next  要看的目标（一张图，或一个合集）
   * @param el    卡片根元素（用来算位置）
   */
  function openDetail(next: DetailTarget, el: HTMLElement): void {
    // 自增等于「从这一刻起，之前发出去的打开请求都作废」
    detailSeq += 1;
    detailTarget.value = next;
    lastDetailKey.value = targetKey(next);
    detailAnchor = el;
    repositionAll();
  }

  /** 关掉详情面板。图片栏不受影响（那是另一块） */
  function closeDetail(): void {
    // 也要自增：还在飞的 `openCollection`（库页要先拉频次表）回来时不该把面板又弹出来
    detailSeq += 1;
    detailTarget.value = null;
    detailAnchor = null;
    // 它一走，另一块（刚才是躲着它放的）可以挪回自己该在的地方
    repositionAll();
  }

  /**
   * 打开一个合集（右键）—— **库页会先把 tag 频次表拉回来，拉完才真正开面板。**
   *
   * 为什么要等：面板的高度是**内容撑出来的**，而合集的内容有一半来自这个请求。
   * 不等的话会这样 ——
   *
   * 1. 面板带着「只有元信息」的矮内容渲染出来，按矮高度居中（第一帧）；
   * 2. 频次表回来，面板长高，重新居中（第二帧）。
   *
   * 两帧的高度和位置都不一样，看上去就是展开时抖一下（从矮变高）。而单图面板
   * 没有这个问题：它的内容全在 `ImageItem` 里，挂载那一刻就是最终高度。
   *
   * 代价是库页右键一个合集之后，要等一次后端冷启动（150–300ms）面板才出现。
   * 这一下安静比抖一下好 —— 面板一露面就是最终样子，emerge 那段展开动画也才是
   * 从箭头尖上**完整长出来**的，而不是长到一半又抻一下。
   *
   * 待入库的合集走不到这条路径：它的名称/张数/子合集数全在 `ref` 里，没有请求
   * 可等，所以那边仍然是即时打开的。
   */
  async function openCollection(
    coll: CollectionRef,
    source: DetailSource,
    el: HTMLElement,
  ): Promise<void> {
    if (source === "inbox") {
      openDetail({ kind: "collection", ref: coll, source, detail: null }, el);
      return;
    }

    // 先占住序号：后面 `openDetail` 里那次自增只能作废更早的请求，不能作废自己
    const seq = ++detailSeq;

    let detail: CollectionDetail | null = null;
    try {
      // 用 coll_id 精确查，所以最多回一条（同名合集才可能有多条）
      const data = await getCollectionTags({ coll_id: coll.id });
      const hit = data.collections[0];
      if (hit) {
        detail = {
          name: hit.name,
          imageCount: hit.image_count,
          dirPath: hit.dir_rel_path,
          dateDir: hit.date_dir,
          tags: hit.tags,
        };
      }
    } catch {
      /*
       * 拉不到照样开：从 `rel_path` 推出来的那份元信息本身就有用，面板会说明
       * 标签没拿到。为这一点信息卡住整个面板不值得。
       */
    }

    // 这期间又开了别的、或者用户 Esc 关掉了 —— 这次的结果已经没人要了
    if (seq !== detailSeq) return;

    openDetail({ kind: "collection", ref: coll, source, detail }, el);
  }

  /**
   * 打开**合集图片栏**（左键点合集卡片）。
   *
   * 只做一件事：把「开着哪个合集」记下来（连同一秒就能定好的位置）。这里
   * **不发任何请求**，图也不经过这儿 —— 页面拿到这个 `ref` 之后，从自己那份墙上
   * 条目里把该合集的图取出来喂给面板（面板内部是一条 `MasonryColumn`）。
   *
   * 为什么不把图一起塞进来：见 `imagesRef` 那段 —— 两页的记录形状不同。
   *
   * ⚠ 顺带一个代价：页面取回的那批图**只是当前结果里属于该合集的**（库页那次
   * `search` 带 `limit`，标签一筛就只剩命中的几张）。这是刻意的 —— 显示的语义是
   * 「你眼前这批里属于这个合集的有哪些」，不是「磁盘上那个文件夹里有什么」。
   * 要看完整清单得等以后加一个按 `coll_id` 查的入口。
   */
  function openCollectionImages(coll: CollectionRef, el: HTMLElement): void {
    // 换一个合集 = 那一列里的卡片全要重挂：从旧合集某张图上打开的详情会没锚点
    dropDetachedDetail();
    imagesRef.value = coll;
    lastImagesKey.value = collectionKeyOf(coll);
    imagesAnchor = el;
    repositionAll();
  }

  /** 关掉图片栏。详情不受影响（那是另一块，锚点在墙上时更没它什么事） */
  function closeImages(): void {
    imagesRef.value = null;
    imagesAnchor = null;
    // 详情要是从这一栏里的图上打开的，它的锚点跟着没了
    dropDetachedDetail();
    repositionAll();
  }

  /**
   * 两块一起收。
   *
   * 换搜索结果（或那一列整个换掉）时用：墙上所有卡片都会重挂，两块面板的锚点
   * 全都失效，留着只会指向脱离文档的死元素。
   *
   * ⚠ 平时**别用它**：两块面板各自有自己的 × 和 Esc 顺序，点谁的 × 就关谁
   * （那两块各调 `closeDetail` / `closeImages`）。
   */
  function closePanels(): void {
    detailTarget.value = null;
    detailAnchor = null;
    imagesRef.value = null;
    imagesAnchor = null;
  }

  /**
   * 详情要是从**图片栏里某张图**上右键打开的，那一栏一关（或换成另一个合集），
   * 它的锚点就没了 —— 面板会停在半空、位置再也量不准。
   *
   * ⚠ **必须等 DOM 更新**：调用这一刻 Vue 还没把那些卡片摘掉，`isConnected`
   * 仍然为真，当场判不出来。所以丢到 `nextTick`。
   *
   * 锚点在墙上的详情不受影响（墙上的卡片还在），那正是我们要的：图片栏关了，
   * 墙上那张图的详情照旧开着。
   */
  function dropDetachedDetail(): void {
    if (!detailAnchor) return;
    void nextTick(() => {
      if (detailAnchor && !detailAnchor.isConnected) closeDetail();
    });
  }

  // ---------------------------------------------------------------------------
  // 登记（定位区、面板）
  // ---------------------------------------------------------------------------

  /**
   * 登记定位区（`.app-main`）。
   *
   * 顺带挂上 ResizeObserver —— 窗口缩放、功能列变宽都会让瀑布流重新分列、
   * 卡片位置跟着变，不重算面板会停在旧位置。
   */
  function registerArea(el: HTMLElement): void {
    area = el;
    areaObserver?.disconnect();
    areaObserver = new ResizeObserver(() => {
      // 卡片可能已经被新查询换掉了（元素脱离文档），那种面板只能收掉
      if (detailAnchor && !detailAnchor.isConnected) closeDetail();
      if (imagesAnchor && !imagesAnchor.isConnected) closeImages();
      repositionAll();
    });
    areaObserver.observe(el);
  }

  /** 解绑定位区。组件卸载时调用，不然 ResizeObserver 会一直挂着 */
  function unregisterArea(): void {
    areaObserver?.disconnect();
    areaObserver = null;
    area = null;
  }

  /**
   * 登记一块面板（它 `onMounted` 时调用），并**同步**先重算一次位置。
   *
   * 同步这一步不是优化，是必要的：`openDetail()` 里那次 `repositionAll()` 时面板
   * 刚被创建、元素还没交进来，只能按高度 0 算出一个临时位置。挂载后立刻拿真实
   * 高度重算，才能在浏览器绘制之前把位置定下来 —— 否则会先画一帧错位的面板再跳。
   *
   * 顺带挂 ResizeObserver：预览图加载完、删掉几个 tag、合集的 tag 表拉回来、
   * 图片栏里那一列图解码完都会改变面板高度，高度一变就要重新居中。
   */
  function registerPanel(kind: PanelKind, el: HTMLElement): void {
    const observer = new ResizeObserver(() => repositionAll());

    if (kind === "detail") {
      detailEl = el;
      detailObserver?.disconnect();
      detailObserver = observer;
    } else {
      imagesEl = el;
      imagesObserver?.disconnect();
      imagesObserver = observer;
    }

    observer.observe(el);
    repositionAll();
  }

  /**
   * 解绑面板。**必须传回自己是哪个元素**。
   *
   * 关掉旧面板、开新面板时两块面板会短暂共存（退场动画还没跑完），而旧的那块
   * 卸载得比新的那块**晚**。不比对一下，旧面板的卸载就会把新面板的登记顺手清掉，
   * 之后新面板的高度变化再没人管。
   */
  function unregisterPanel(kind: PanelKind, el: HTMLElement): void {
    if (kind === "detail") {
      if (detailEl !== el) return;
      detailObserver?.disconnect();
      detailObserver = null;
      detailEl = null;
      return;
    }

    if (imagesEl !== el) return;
    imagesObserver?.disconnect();
    imagesObserver = null;
    imagesEl = null;
  }

  return {
    // 详情面板
    detailTarget,
    detailKey,
    lastDetailKey,
    detailPos,
    detailOpen,
    // 合集图片栏
    imagesRef,
    imagesKey,
    lastImagesKey,
    imagesPos,
    imagesOpen,
    // 动作
    openDetail,
    openCollection,
    openCollectionImages,
    closeDetail,
    closeImages,
    closePanels,
    // 定位与登记
    repositionAll,
    registerArea,
    unregisterArea,
    registerPanel,
    unregisterPanel,
    // 详情信息（名字 / 地址 / 标签 / 时间）—— **只对单图有意义**，见上面的说明
    image,
    name,
    path,
    tags,
    tagCount,
    mtime,
    ctime,
    shotAt,
  };
});
