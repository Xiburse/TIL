<script setup lang="ts" generic="T">
/**
 * 瀑布流的最外层包裹层：决定分几列、把图分到各列、再把列横向排开。
 *
 * **两个页面共用**（看库里的图 / 待入库的图），所以它不认识任何一种具体的图 ——
 * 只认三样：条目数组、怎么取 key、用哪个卡片组件渲染。各自的右键行为、选中态、
 * 尺寸有无，全是卡片自己的事。
 *
 * # 分列规则
 *
 * 图片**按顺序**放进「当前最矮的那一列」。高度不是等图片加载完量出来的，
 * 而是用条目上的 `width`/`height` 直接算出来 —— 原理见 masonry.ts 的文件头。
 * **尺寸缺失或读不出来时按正方形算**（`inbox_scan` 读不出文件头的那几条是
 * `null`），这时分列退化成按张数平摊。
 *
 * # 列数怎么定
 *
 * 自己量容器宽度，每 200 逻辑像素一列，钳在 [2, 8]。窗口一变就重算，
 * 重算完立刻重新分列 —— 因为「这张图该进哪一列」取决于当时各列的高度，
 * 列数不同结论就不同。
 *
 * # 为什么用泛型组件
 *
 * `generic="T"` 让 `items` 的元素类型一路透到调用方的模板里：传
 * `WallItem<ImageItem>[]` 就按它检查，传 `WallItem<InboxImage>[]` 也按它检查。
 * 不用泛型的话只能退成 `unknown[]`，调用方每处都要自己断言。
 *
 * **`T` 故意不加约束。** 分列要读 `width` / `height`，但这两种记录都没有直接的
 * 尺寸字段（库里的靠 `ImageItem`、待入库的可能是 `null`、合集更是要往**封面**上
 * 找），写成 `T extends { width?: number; height?: number }` 会因为「弱类型」
 * 直接编译不过（详见 masonry.ts 的 `Sized`）。所以尺寸既不进类型系统、也不由
 * 网格自己去找 —— 由调用方通过 `sizeOf` 交出「量哪张」，网格按 `unknown` 收。
 *
 * # 为什么列状态在这里而不是在列组件里
 *
 * 挑「最矮的列」需要同时看到所有列，单列组件看不到兄弟列。所以状态放在这一层，
 * 列组件只负责渲染。
 */
import {
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Component,
} from "vue";

import MasonryColumn from "./MasonryColumn.vue";
import {
  MIN_COLUMNS,
  columnCountForWidth,
  createColumns,
  placeImages,
  type Column,
} from "./masonry";

const props = defineProps<{
  /** 要展示的图，按顺序分列 */
  items: T[];
  /**
   * 拿条目的稳定 key（库里是 `image_id`，待入库是 `rel_path`）。
   *
   * 做成函数而不是约定一个 `key` 字段：两种数据的字段名对不上，而给后端原样
   * 透传的记录**加一个前端字段**（`{...image, key}`）每张图都要多复制一份对象。
   */
  keyOf: (item: T) => string;
  /**
   * 从一条里取出「用哪张图来量高」。
   *
   * 墙上的一条可能是个**合集**（见 `wall.ts`），它自己没有尺寸 —— 尺寸在**封面**
   * 那张图上。所以两页都传 `wallCover`。不传的话合集会被按正方形算，分列能跑但
   * 每列高度都是错的。
   */
  sizeOf?: (item: T) => unknown;
  /**
   * 用哪个卡片组件渲染每一条。
   *
   * **约定它收一个名为 `item` 的 prop** —— 网格把条目原样传下去
   * （见 MasonryColumn 的模板）。两个卡片（ImageCard / InboxCard）都符合。
   */
  card: Component;
}>();

const root = ref<HTMLElement | null>(null);
const columnCount = ref(MIN_COLUMNS);

/**
 * 分好的列。用 **shallowRef 而不是 ref**，两层原因：
 *
 * 1. 这里只做**整体替换**（`columns.value = next`），从不原地改某一列 —— 浅层
 *    就足够驱动渲染，深层的 Proxy 白建；
 * 2. `ref` 会对泛型里的 `T[]` 展开 `UnwrapRef`，元素类型一复杂就会触发
 *    「类型实例化过深」那种编译错误，而 `T` 在泛型组件里恰恰是复杂的那个。
 */
const columns = shallowRef<Column<T>[]>(createColumns<T>(MIN_COLUMNS));

/**
 * 用 ResizeObserver 而不是 window 的 resize 事件。
 *
 * 前者量的是**容器自己的内容宽度**，padding 已经排除在外；后者只能拿到窗口宽度，
 * 还得自己减掉 padding，布局一改就对不上。而且 Tauri 窗口缩放、侧栏折叠这类
 * 不触发 window resize 的布局变化，ResizeObserver 也能捕捉到。
 */
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!root.value) return;
  observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    // contentRect 是 content box，不含 padding —— 正是能用来放列的那块宽度
    columnCount.value = columnCountForWidth(entry.contentRect.width);
  });
  // 首次 observe 会立刻回调一次，所以不用另外测一次初始宽度
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/**
 * 图变了、或列数变了，就重新分列。
 *
 * 整体重算而不是增量追加：结果和逐张追加**完全一致**（分列只依赖前面放了什么，
 * 是确定性的），但不用担心状态同步漏了哪一步。
 *
 * 拖动窗口边缘不会每一像素都重排 —— `columnCount` 只在跨过 200px 台阶时才变，
 * 而 Vue 对相同值的 ref 赋值不触发更新。
 *
 * 重分时卡片是按 `keyOf` 的结果做 key 的，Vue 会尽量复用组件，不会重新发起加载。
 */
watch(
  [() => props.items, columnCount],
  ([items, count]) => {
    const next = createColumns<T>(count);
    placeImages(next, items, props.sizeOf);
    columns.value = next;
  },
  { immediate: true },
);
</script>

<template>
  <div
    ref="root"
    class="masonry"
    :style="{ '--masonry-columns': String(columnCount) }"
  >
    <MasonryColumn
      v-for="(column, index) in columns"
      :key="index"
      :items="column.items"
      :key-of="keyOf"
      :card="card"
    />
  </div>
</template>

<style scoped>
.masonry {
  display: grid;
  /*
   * minmax(0, 1fr) 而不是 1fr：后者的最小宽度是 auto，列里的图片一旦撑不进去
   * 就会溢出，把网格顶宽。minmax(0, ...) 让列可以真正收缩。
   * 用 fr 而不是固定像素，列宽自动跟着容器走 —— 这就是响应式的那一半。
   */
  grid-template-columns: repeat(var(--masonry-columns, 2), minmax(0, 1fr));
  gap: var(--masonry-gap);
  /*
   * 关键：不让短列被拉伸到和最高列一样高。
   * 不加这条的话，grid 默认 stretch，每列底部会留一大块空白，
   * 看起来就不像瀑布流了。
   */
  align-items: start;

  padding: clamp(0.5rem, 1.3vw, 1.5rem);
}
</style>
