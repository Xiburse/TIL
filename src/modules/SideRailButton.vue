<script setup lang="ts">
/**
 * 功能列里的单个方块按钮（视图切换器的一格）。
 *
 * 颜色规则（配色来自 public/colors/*.css 的 primary 梯度）：
 *
 * | 状态 | 按钮底色 | 图标色 |
 * |---|---|---|
 * | 默认 | `--color-primary-300` | `--color-primary-800` |
 * | 激活 | `--color-primary-800` | `--color-primary-300`（两者对调） |
 *
 * 图标用 CSS mask 上色（`background-color: currentColor`），所以只要在按钮上
 * 切换 `color`，图标颜色自动跟着对调，不用写两套图标规则 —— 和 TagSearchBar
 * 里图标用 mask 的理由相同：tags.svg 是 `fill="currentColor"`，用 `<img>` 加载
 * 拿不到页面颜色。
 *
 * 激活状态表达的是「**当前打开的视图**」，由父组件下发 —— 按钮自己不存这个状态，
 * 否则会出现「按钮亮着但页面没切过去」的假象。
 */
defineProps<{
  /** 是否是当前激活的按钮 */
  active: boolean;
  /** 可访问名 + tooltip。不传则只有图标 */
  label?: string;
}>();

const emit = defineEmits<{
  /** 点击。要不要真的切换视图由父组件决定 */
  select: [];
}>();
</script>

<template>
  <button
    type="button"
    class="side-rail-button"
    :class="{ 'side-rail-button--active': active }"
    :title="label"
    :aria-label="label"
    :aria-pressed="active"
    @click="emit('select')"
  >
    <!-- 占位图标：暂时全用 tags.svg，之后每个按钮换自己的图标 -->
    <span class="side-rail-button__icon" aria-hidden="true" />
  </button>
</template>

<style scoped>
.side-rail-button {
  /*
   * 横向填满功能列 + 正方形：宽度被拉满，高度由 aspect-ratio 按宽度算，
   * 列宽改了按钮自动跟着变方，不用维护第二个数。
   */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;

  padding: 0;
  border: none;
  /* 方块就用方角，不留圆角 */
  border-radius: 0;

  background-color: var(--color-primary-300);
  /* 图标经 mask 上色用的是 currentColor，改这里的 color 就同时换了图标色 */
  color: var(--color-primary-800);
  cursor: pointer;

  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}

.side-rail-button--active {
  background-color: var(--color-primary-800);
  color: var(--color-primary-300);
}

/* 悬停：同色系再深一档，激活态是反过来的两档（800 → 700） */
.side-rail-button:hover {
  background-color: var(--color-primary-400);
}

.side-rail-button--active:hover {
  background-color: var(--color-primary-700);
}

/* 键盘焦点也看得见。用 currentColor：默认态是 800 压在 300 上、
   激活态是 300 压在 800 上，两种背景下的对比度都够 */
.side-rail-button:focus-visible {
  outline: 2px solid currentColor;
  /* 收在方块内部，别被相邻按钮盖住 */
  outline-offset: -2px;
}

.side-rail-button__icon {
  /* 占按钮宽度的一半：列宽变了图标跟着缩放，不写死像素 */
  width: 50%;
  height: 50%;
  background-color: currentColor;
  -webkit-mask: url("/tags.svg") center / contain no-repeat;
  mask: url("/tags.svg") center / contain no-repeat;
}
</style>
