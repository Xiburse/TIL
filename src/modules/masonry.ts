/**
 * 瀑布流的分列逻辑。纯函数 + 一个可变的列状态，不碰 DOM。
 *
 * # 为什么不需要等图片加载完
 *
 * 后端返回的 `width` / `height` 就是图片的真实像素尺寸，所以 `height / width`
 * 就是渲染后的宽高比。列宽确定之后，每张图的显示高度是**算得出来**的，
 * 不用等 `onload`。好处有两个：
 *
 * 1. 分列结果确定，不依赖网络和加载顺序 —— 同一批图每次分出来的列一模一样。
 * 2. 图片陆续加载时**不会跳版**。等 onload 才排的话，先加载完的会先占位，
 *    后加载的把布局挤来挤去。
 *
 * # 尺寸可能缺失 —— 这时按正方形算
 *
 * 两页的数据都会给 `width` / `height`（`inbox_scan` 连**显示尺寸**都算好了，
 * EXIF 旋转已套用），但**都可能没有**：`inbox_scan` 里读不出文件头的图给的是
 * `null`。这种情况下面这些函数一律按「高 = 宽」兜底，分列退化成**按张数**平摊
 * （各列一样高、轮流落），各列真实高度会参差。
 *
 * 这也是刻意的：**等图片加载完再重排会让整版跟着抖**（正是上面第 2 条要避免的）。
 * 所以尺寸的**有无**在这里是「精度」问题，不是「能不能用」问题。
 *
 * # 高度为什么用「列宽 = 1」单位
 *
 * `heightUnits` 累计的是 `Σ (h/w)`，也就是**假设列宽为 1 时这列有多高**。
 * 乘上真实列宽才是像素值。
 *
 * 这么做是因为窗口可以缩放、列数以后可能变，这些都会改变列宽。存像素高度的
 * 话每次变化都得把所有列重算一遍；存比例和则完全不用动 —— 它天然与列宽无关，
 * 而且**比大小**这件事在任何列宽下都成立（所有列等宽）。
 */

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/**
 * 分列要读的那两个字段。宽或高**缺一个都行** —— 缺的按正方形算。
 *
 * ⚠ 这**不是**给泛型用的约束，只是 [`heightUnits`] 内部读取时的形状。两条理由：
 *
 * 1. 它两个字段都可选，在 TS 眼里是「弱类型（weak type）」—— 一个**没有**这两个
 *    字段的类型拿它当约束，会直接报「has no properties in common with」；
 * 2. 后端给的尺寸是 **`number | null`**（`inbox_scan` 读不出文件头就是 `null`），
 *    也满足不了 `width?: number`。
 *
 * 所以泛型一律不加约束，尺寸在 `heightUnits` 里按 `unknown` 收、在这里收窄 ——
 * 「有没有、坏不坏」本来就是运行时才知道的事。
 */
export interface Sized {
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// 列数
// ---------------------------------------------------------------------------

/** 宽度台阶：容器每宽 200 逻辑像素就多给一列 */
export const COLUMN_WIDTH_STEP = 200;

/** 列数上下限 */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 8;

/**
 * 按容器宽度算该展示几列：每 200 逻辑像素一列，结果钳在 [2, 8]。
 *
 * 这里的「逻辑像素」就是 CSS 像素 —— 浏览器在系统缩放（125% / 150%）下已经
 * 把 CSS 像素换算过了，`getBoundingClientRect().width` 拿到的就是这个值，
 * 所以**不用**再自己去乘 devicePixelRatio。
 *
 * 宽度小于一档（< 150）时仍然给到下限 2 列，而不是 1 列 —— 单列在视觉上
 * 就不叫瀑布流了，而且窄窗口下两列比一列更实用。
 */
export function columnCountForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MIN_COLUMNS;
  const raw = Math.floor(width / COLUMN_WIDTH_STEP);
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, raw));
}

// ---------------------------------------------------------------------------
// 分列
// ---------------------------------------------------------------------------

/** 一列的状态 */
export interface Column<T> {
  /** 按放入顺序排列 */
  items: T[];
  /**
   * 已占用高度，单位是「列宽 = 1」。见文件头的说明。
   *
   * 由 [`placeImage`] 增量维护，不要在别处直接改。
   */
  heightUnits: number;
}

/**
 * 一张图在「列宽 = 1」单位下的高度，也就是它的宽高比。
 *
 * 宽或高为 `null` / 缺失 / 0 / 非有限值时按正方形兜底 —— `inbox_scan` 读不出
 * 文件头时给的就是 `null`。这里兜住是为了不让 `NaN` 或 `Infinity` 渗进累加值
 * （一旦渗进去，那一列的高度就永远是 NaN，再也不会被选中，表现为「图片全堆在
 * 其它列」）。
 */
export function heightUnits(image: unknown): number {
  const { width, height } = (image ?? {}) as Sized;
  // 先判「有没有」再判「是不是好数」：`Number.isFinite` 收 `unknown`，
  // 不会把 `number | null | undefined` 收窄成 `number`，所以这一步得分开写。
  // `typeof null === "object"`，所以 null 在这里就被挡掉了。
  if (typeof width !== "number" || typeof height !== "number") return 1;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return height / width;
}

/** 一列所有图的高度和（同样以「列宽 = 1」为单位） */
export function columnHeightUnits(images: unknown[]): number {
  let sum = 0;
  for (const image of images) sum += heightUnits(image);
  return sum;
}

/** 建一个空的列状态 */
export function createColumns<T>(count: number): Column<T>[] {
  const safe = Math.max(1, Math.floor(count));
  return Array.from({ length: safe }, () => ({ items: [], heightUnits: 0 }));
}

/**
 * 把一条放进**当前最矮**的列，返回被选中的列下标。
 *
 * 并列最矮时取下标最小的，让结果稳定可复现 —— 否则同一批图在不同浏览器/
 * 不同运行下可能分出不同的列。
 *
 * 直接改传入的 `columns`（原地更新，不产生新数组）。
 *
 * @param sizeOf 从一条里取出**用哪张图来量高**。不给就量它自己。
 *   墙上的一条可能是个**合集**（见 `wall.ts`）—— 它自己没有 `width`/`height`，
 *   尺寸在**封面**上，所以要由调用方说清楚量的是谁。不传的话合集会被当成正方形，
 *   整版高度全算错（分列虽然还能跑，但每列都会莫名其妙地长）。
 */
export function placeImage<T>(
  columns: Column<T>[],
  image: T,
  sizeOf: (item: T) => unknown = (item) => item,
): number {
  if (columns.length === 0) {
    throw new Error("placeImage: 至少需要一列");
  }

  let best = 0;
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].heightUnits < columns[best].heightUnits) best = i;
  }

  columns[best].items.push(image);
  columns[best].heightUnits += heightUnits(sizeOf(image));
  return best;
}

/** 把一批依次放进最矮的列。`sizeOf` 的含义见 [`placeImage`] */
export function placeImages<T>(
  columns: Column<T>[],
  images: T[],
  sizeOf?: (item: T) => unknown,
): void {
  for (const image of images) placeImage(columns, image, sizeOf);
}
