<script setup lang="ts">
/**
 * ImageCard —— 在页面上展示单张图片。
 *
 * # 悬浮效果
 *
 * 鼠标移到图片上时，**图片后面那个盒子向四边等距外扩**，从图片边缘露出一圈，
 * 看起来像把图片包住了。移开就缩回去，变回只有一张图的样子。
 *
 * # 为什么分成「盒子 + 图片」两层
 *
 * 图片**完全不参与任何 transform 和尺寸变化**，永远按原始像素渲染。
 * 之前试过直接放大图片、以及放大外层再给图片反向缩放抵消，两种都会让浏览器
 * 按缩放后的尺寸重新栅格化图片，边缘发虚。
 *
 * # 为什么用 margin 而不是 scale
 *
 * `scale(1.1)` 是按比例放大：长方形盒子横竖各放大 10%，看着是「变形」不是
 * 「外扩」—— 越长的图，上下多出来的那圈比左右厚得越明显。
 *
 * 负 margin 才是四边**等距**外扩。而且百分比 margin 在上下左右**都按容器宽度**
 * 解析（CSS 的规定），所以天然就是一圈等宽的边，并且随列宽等比缩放。
 */
import { computed, ref } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useImageDetailStore } from "../stores/imageDetail";
import type { ImageItem } from "./types";

const props = defineProps<{
  /** 一条图片记录 */
  image: ImageItem;
}>();

const detailStore = useImageDetailStore();

/** 加载失败时切成占位符，免得页面上只剩一个破图标 */
const failed = ref(false);

/**
 * 右键 = 打开详情面板。
 *
 * `.prevent` 同时吃掉浏览器/WebView 的默认右键菜单，否则 Tauri 的 webview
 * 会弹出「返回 / 刷新 / 另存为」那个系统菜单，把交互打断。
 *
 * 直接写 store，不再往上 emit —— 位置决策（贴左还是贴右）依赖 app-main，
 * 由 store 统一算，叶子组件不该知道页面布局。
 */
function onContextMenu(event: MouseEvent): void {
  detailStore.openDetail(props.image, event.currentTarget as HTMLElement);
}

/* ---------- 【新增】鼠标进入：把图片高度写进幽灵 ---------- */
function onEnter() {}

/* ---------- 【新增】鼠标离开：幽灵高度归零 ---------- */
function onLeave() {}

/**
 * Tauri 的 webview 不能直接加载文件系统路径——`E:\Images\...` 原样塞给
 * <img src> 会 404。必须先过 convertFileSrc 转成 asset:// 协议的地址。
 *
 * 前提是 src-tauri/tauri.conf.json 里 `app.security.assetProtocol` 已开启，
 * 且图片所在目录落在 scope 里；漏了这一步图片会静默加载失败。
 */
const src = computed(() => convertFileSrc(props.image.abs_path));

/** 原始文件名比入库后的名字好认 */
const alt = computed(() => props.image.origin_name || props.image.filename);
</script>

<template>
  <div class="image-card"
       @mouseenter="onEnter"
       @mouseleave="onLeave"
       @contextmenu.prevent="onContextMenu">

    <!-- 图片本体。没有任何 transform，也不改尺寸 -->
    <div class="image-card__content">
      <img
        ref="imgRef"
        v-if="!failed"
        class="image-card__img"
        :src="src"
        :alt="alt"
        :width="image.width"
        :height="image.height"
        loading="lazy"
        decoding="async"
        draggable="false"
        @error="failed = true"
      />
      <div v-else class="image-card__failed" :title="image.abs_path">
        图片加载失败
      </div>
    </div>
  </div>
</template>

<style scoped>
.image-card {
  /* 外扩多少：容器宽度的百分比，四边都一样宽。改这一个数就够 */
  --hover-ring: 5%;

  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  border-radius: 12px;

  /*
   * 不要加 overflow: hidden —— 盒子要能扩到图片外面去。
   * 也不要加 padding —— 那会改变卡片实际高度，把这一列下面的图推开。
   */
}

.image-card:hover {
  /* 浮到相邻列上面去，否则右边那一列会盖住外扩出来的一圈 */
  z-index: 10;
}

/* ---- 图片 ---- */

.image-card__content {
  position: relative;
  /* 盖在盒子上面 */
  z-index: 1;
  display: block;
  width: 100%;
}

.image-card__img {
  display: block;
  width: 100%;
  height: auto;
  background-color: rgba(128, 128, 128, 0.12);
  border-radius: 8px;
  animation: fade-in 0.35s ease-out both;
}

.image-card__failed {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  font-size: 0.8rem;
  color: rgba(128, 128, 128, 0.9);
  background-color: rgba(128, 128, 128, 0.12);
  border: 1px dashed rgba(128, 128, 128, 0.4);
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 触屏设备没有 hover，关掉这些效果，省电又避免卡顿 */
@media (hover: none) {
  .image-card:hover .image-card__box {
    margin: 0;
    background-color: transparent;
    box-shadow: none;
  }
}

/*
 * 尊重「减少动画」的无障碍设置：只去掉过渡，效果本身保留 ——
 * 状态还是要变的，只是瞬间到位，不该因为关掉动画就整个功能失效。
 */
@media (prefers-reduced-motion: reduce) {
  .image-card__box {
    transition: none;
  }
}
</style>
