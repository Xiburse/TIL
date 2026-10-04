<script setup lang="ts">
/**
 * 图片详情面板。右键图片时出现在它旁边。
 *
 * # 出现在哪
 *
 * `position: absolute` 挂在 `.app-main` 里（那边是 `position: relative`），
 * 钉在 app-main 的**可见区**，不随内容滚动：
 *
 * - **横向**：贴 app-main 的左边或右边，占 1/3 宽。图片左上角在 app-main 偏左
 *   → 面板贴**右**；偏右 → 贴**左**（永远不挡住被点的那张图）。
 *   用 `left:0` / `right:0` 锚边而不是 JS 算 x，窗口缩放时面板自动贴边。
 * - **纵向**：`top` 对齐图片左上角在 app-main 里的 y。至少留 280px 高度，
 *   免得右键最下面那行图只得到一个贴底的小条。
 *
 * 具体坐标由父组件算好传进来（`side` / `top`）。定位要同时拿到 app-main 和图片
 * 元素的矩形、还要处理出界钳制 —— 这些和「显示详情」是两件事，不该揉进本组件。
 *
 * # 大小
 *
 * - **宽度 = app-main 的 1/3**，`calc(100% / 3)` 随容器缩放 —— 这是「响应式」的落点
 * - **高度最高铺满 app-main**：`max-height: calc(100% - top)`，从 top 一路到底边，
 *   再多也不越出 app-main。内容超了面板自己滚
 *
 * # 内容
 *
 * 目前展示 `ImageItem` 里已有的元信息，不额外发请求。完整的 tag 列表（带置信度）
 * 要另调 `image_detail` 接口，等窗口定型了再接。
 */
import { computed, ref } from "vue";
import { convertFileSrc } from "@tauri-apps/api/core";
import { storeToRefs } from "pinia";

import { useImageDetailStore } from "../stores/imageDetail";

/**
 * 详情数据从 store 读，不收 props —— 这是当初上 Pinia 的目的：右键图 → 写 store →
 * 面板读 store，中间不需要经父组件层层传。
 *
 * **解构 store 必须走 `storeToRefs`**，直接 `const { image } = store` 拿到的是
 * 快照值，之后 store 更新了组件不会重新渲染。这是 Pinia 最常见的坑。
 */
const detailStore = useImageDetailStore();
const { image, side, top } = storeToRefs(detailStore);

/** 面板没开就不渲染任何东西 */
const previewFailed = ref(false);

/**
 * 图片本地文件不能直接给 `<img src>`，必须过 convertFileSrc 转成 asset:// 地址。
 * 前提见 tauri.conf.json 的 assetProtocol —— 理由和 ImageCard.vue 里那条注释相同。
 */
const src = computed(() =>
  image.value ? convertFileSrc(image.value.abs_path) : "",
);

/**
 * top 用内联给，同时算出剩下多少高度给 max-height —— 面板从 top 一路铺到底边，
 * 再多也不越出 app-main（需求里的「高度最高铺满整个 app-main」）。
 */
const style = computed(() => ({
  top: `${top.value}px`,
  maxHeight: `calc(100% - ${top.value}px)`,
}));

/** rating_score 是 0~1 的小数，显示成百分比更好读 */
const scoreText = computed(() =>
  image.value ? `${Math.round(image.value.rating_score * 100)}%` : "",
);

/** `shot_at` 可能为 null —— 图里没有 EXIF 拍摄时间 */
const shotText = computed(() => image.value?.shot_at ?? "无 EXIF");

/** xmp_ok: 1 = tag 嵌在图片里，0 = 写在边车 */
const xmpText = computed(() =>
  image.value?.xmp_ok === 1 ? "嵌在图片里" : "边车文件",
);
</script>

<template>
  <!-- 面板自己判空：store 里没图就不渲染。App 那边不用 v-if -->
  <aside v-if="image" class="image-detail" :style="style" :data-side="side">
    <button
      class="image-detail__close"
      type="button"
      title="关闭（Esc）"
      aria-label="关闭详情"
      @click="detailStore.closeDetail()"
    >
      ×
    </button>

    <!--
      预览图。只用它占个大致位置，所以限高；原图在 ImageCard 那边看。
      alt 留空：这里是装饰性预览，信息在下面的元数据里。
    -->
    <img
      v-if="!previewFailed"
      class="image-detail__preview"
      :src="src"
      alt=""
      :width="image.width"
      :height="image.height"
      @error="previewFailed = true"
    />
    <div v-else class="image-detail__preview-failed">预览加载失败</div>

    <dl class="image-detail__meta">
      <dt>原名</dt>
      <dd>{{ image.origin_name }}</dd>

      <dt>文件名</dt>
      <dd>{{ image.filename }}</dd>

      <dt>尺寸</dt>
      <dd>{{ image.width }} × {{ image.height }}</dd>

      <dt>分级</dt>
      <dd>{{ image.rating }}（{{ scoreText }}）</dd>

      <dt>标签数</dt>
      <dd>{{ image.tag_count }}</dd>

      <dt>拍摄</dt>
      <dd>{{ shotText }}</dd>

      <dt>修改</dt>
      <dd>{{ image.mtime }}</dd>

      <dt>创建</dt>
      <dd>{{ image.ctime }}</dd>

      <!--
        collection_id 是后端的内部数字，对外定位合集要用 coll_id（合集文件夹名）。
        image 对象里没带 coll_id，要的话可以从 rel_path 推。这里先按原样显示。
      -->
      <dt>合集</dt>
      <dd>{{ image.collection_id ?? "散图" }}</dd>

      <dt>XMP</dt>
      <dd>{{ xmpText }}</dd>
    </dl>

    <!-- prompt 是逗号分隔的完整 tag 串，可能很长，整段换行显示 -->
    <div class="image-detail__prompt">
      <div class="image-detail__prompt-label">标签</div>
      <div class="image-detail__prompt-text">{{ image.prompt }}</div>
    </div>
  </aside>
</template>

<style scoped>
.image-detail {
  /*
   * absolute 挂在 .app-main 里（那边是 position: relative）。
   * top 由父组件按图片位置算好（内联给），横向由 data-side 锚左/右边。
   */
  position: absolute;
  z-index: 50;

  /* 写死：app-main 的三分之一。用百分比所以容器一变宽面板跟着变 —— 响应式 */
  width: calc(100% / 3);
  /* max-height 由内联给（calc(100% - top)），保证从 top 铺到底边也不越界 */
  overflow: auto;

  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;

  border: 1px solid rgba(128, 128, 128, 0.3);
  /* 圆角朝向随贴的那侧翻转：外侧圆、贴图片那侧平 */
  border-radius: 12px;
  background-color: var(--color-surface);
  color: var(--color-text);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);

  animation: detail-in 0.22s ease-out both;
}

.image-detail[data-side="right"] {
  /* 贴 app-main 右边：内侧（朝图片那侧）平，外侧圆 */
  right: 0;
  border-top-left-radius: 4px;
  border-bottom-left-radius: 4px;
}

.image-detail[data-side="left"] {
  left: 0;
  border-top-right-radius: 4px;
  border-bottom-right-radius: 4px;
}

.image-detail__close {
  position: absolute;
  top: 0.35rem;
  right: 0.5rem;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 1.15rem;
  line-height: 1;
  cursor: pointer;
}

.image-detail__close:hover {
  background-color: rgba(128, 128, 128, 0.25);
}

/*
 * 预览图限高 + 等比缩放。不写死宽度，跟随面板宽度（也就是 app-main 的 1/3），
 * 所以窗口缩放时预览图一起变。
 */
.image-detail__preview {
  display: block;
  width: 100%;
  height: auto;
  max-height: 32vh;
  object-fit: contain;
  border-radius: 8px;
  background-color: rgba(128, 128, 128, 0.12);
}

.image-detail__preview-failed {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 16 / 10;
  font-size: 0.85rem;
  color: rgba(128, 128, 128, 0.9);
  background-color: rgba(128, 128, 128, 0.12);
  border: 1px dashed rgba(128, 128, 128, 0.4);
  border-radius: 8px;
}

/* 元数据：两列，标签固定宽、值自适应 */
.image-detail__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.35rem 0.75rem;
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
}

.image-detail__meta dt {
  color: rgba(128, 128, 128, 1);
  white-space: nowrap;
}

.image-detail__meta dd {
  margin: 0;
  /* 文件名很长，必须能断行，否则会把面板横向撑破 */
  overflow-wrap: anywhere;
}

.image-detail__prompt {
  font-size: 0.85rem;
  line-height: 1.55;
}

.image-detail__prompt-label {
  margin-bottom: 0.25rem;
  color: rgba(128, 128, 128, 1);
}

.image-detail__prompt-text {
  /* tag 串很长，必须任意断行 */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@keyframes detail-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 尊重「减少动画」：状态照变，只是瞬间到位 */
@media (prefers-reduced-motion: reduce) {
  .image-detail {
    animation: none;
  }
}
</style>
