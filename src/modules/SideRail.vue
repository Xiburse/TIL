<script setup lang="ts">
/**
 * 页面左侧的功能列：一列竖排的正方形按钮，充当视图切换器。
 *
 * - 按钮之间**不留间隔**、横向填满整列（整列看起来是一条连续的方块带）。
 * - 只负责渲染和把点击下标报出去；**哪个视图开着、点了该不该切，都是父组件的
 *   事** —— 列组件不知道现在有哪些视图。
 *
 * 目前 5 格：第 0 格是「看图」（当前主页），其余是占位。
 */
import SideRailButton from "./SideRailButton.vue";

const props = defineProps<{
  /** 按钮清单。不传 label 的只有图标 */
  items: Array<{ id: string; label?: string }>;
  /** 当前激活项的下标（= 当前打开的视图） */
  active: number;
}>();

const emit = defineEmits<{
  /** 用户点了第 index 个按钮，切不切由父组件裁决 */
  select: [index: number];
}>();
</script>

<template>
  <nav class="side-rail">
    <SideRailButton
      v-for="(item, index) in props.items"
      :key="item.id"
      :label="item.label"
      :active="index === props.active"
      @select="emit('select', index)"
    />
  </nav>
</template>

<style scoped>
.side-rail {
  flex: none;
  display: flex;
  flex-direction: column;
  /* 不设 gap —— 按钮之间不留间隔，一个接一个铺满整列 */
  width: clamp(48px, 5vw, 64px);
  height: 100%;
  /* 窗口太矮装不下时，只让这一列自己滚，不动主内容区 */
  min-height: 0;
  overflow-y: auto;

  /* 和内容区的分界线，颜色沿用项目里一直用的那档灰 */
  border-right: 1px solid rgba(128, 128, 128, 0.25);
}
</style>
