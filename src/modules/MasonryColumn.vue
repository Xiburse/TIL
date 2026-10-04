<script setup lang="ts">
/**
 * 瀑布流的一列。只负责把这一列的图竖着排出来，**不做分列决策**。
 *
 * 为什么不在这里决定「这张图该不该进我这一列」：分列要比较**所有列**的当前
 * 高度，单列看不到兄弟列。所以决策在 MasonryGrid 里，那里持有全部列的状态
 * （每列装了多少张、占了多高），本组件只拿渲染需要的部分。
 *
 * 宽度不设限，由外层的网格按列数分配（`minmax(0, 1fr)`）；高度不设限，
 * 有几张图就多高 —— 这正是瀑布流要的效果。
 */
import ImageCard from "./ImageCard.vue";
import type { Column } from "./masonry";

defineProps<{
  /** 这一列的状态。`images` 是要渲染的图，`heightUnits` 是已占用高度 */
  column: Column;
}>();
</script>

<template>
  <div class="masonry-column">
    <!-- key 用 image_id（文件名主干，跨设备稳定）：重新查询时 Vue 能复用没变的图片，避免整列重挂载导致图片闪烁 -->
    <ImageCard
      v-for="image in column.images"
      :key="image.image_id"
      :image="image"
    />
  </div>
</template>

<style scoped>
.masonry-column {
  display: flex;
  flex-direction: column;
  /* 和网格的行列间距同一个值，由 App.vue 的 :root 提供 */
  gap: var(--masonry-gap);
  /* 列宽由网格决定，这里只管纵向堆叠 */
  min-width: 0;
}
</style>
