<script setup lang="ts">
/**
 * 瀑布流的最外层包裹层：决定分几列、把图片分到各列、再把列横向排开。
 *
 * # 分列规则
 *
 * 图片**按顺序**放进「当前最矮的那一列」。高度不是等图片加载完量出来的，
 * 而是用后端给的 `width`/`height` 直接算出来 —— 原理见 masonry.ts 的文件头。
 *
 * # 列数怎么定
 *
 * 自己量容器宽度，每 150 逻辑像素一列，钳在 [2, 8]。窗口一变就重算，
 * 重算完立刻重新分列 —— 因为「这张图该进哪一列」取决于当时各列的高度，
 * 列数不同结论就不同。
 *
 * # 为什么列状态在这里而不是在列组件里
 *
 * 挑「最矮的列」需要同时看到所有列，单列组件看不到兄弟列。所以状态放在这一层，
 * 列组件只负责渲染。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import MasonryColumn from "./MasonryColumn.vue";
import {
  MIN_COLUMNS,
  columnCountForWidth,
  createColumns,
  placeImages,
  type Column,
} from "./masonry";
import type { ImageItem } from "./types";

const props = defineProps<{
  /** 要展示的图片，按顺序分列 */
  images: ImageItem[];
}>();

const root = ref<HTMLElement | null>(null);
const columnCount = ref(MIN_COLUMNS);
const columns = ref<Column[]>(createColumns(MIN_COLUMNS));

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
 * 拖动窗口边缘不会每一像素都重排 —— `columnCount` 只在跨过 150px 台阶时才变，
 * 而 Vue 对相同值的 ref 赋值不触发更新。
 *
 * 重分时 ImageCard 是按 image_id 做 key 的，Vue 会尽量复用组件，不会重新发起加载。
 */
watch(
  [() => props.images, columnCount],
  ([images, count]) => {
    const next = createColumns(count);
    placeImages(next, images);
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
      :column="column"
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
