<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import { BackendCallError, search } from "./api/backend";
import ImageDetailPanel from "./modules/ImageDetailPanel.vue";
import MasonryGrid from "./modules/MasonryGrid.vue";
import SideRail from "./modules/SideRail.vue";
import TagSearchBar from "./modules/TagSearchBar.vue";
import { useImageDetailStore } from "./stores/imageDetail";
import type { ImageItem } from "./modules/types";

// ---------------------------------------------------------------------------
// 左侧功能列（视图切换）
// ---------------------------------------------------------------------------

/**
 * 功能列的按钮清单。5 格：第 0 格是「看图」（当前主页），
 * 其余四格是占位 —— 图标暂时都用 tags.svg，点击也还没绑视图。
 */
const railItems = [
  { id: "gallery", label: "看图" },
  { id: "placeholder-1", label: "占位 1" },
  { id: "placeholder-2", label: "占位 2" },
  { id: "placeholder-3", label: "占位 3" },
  { id: "placeholder-4", label: "占位 4" },
];

/** 当前打开的视图下标。现在只有看图，所以恒为 0 */
const activeRail = ref(0);

function onRailSelect(index: number): void {
  // 第 0 格 = 看图（现在唯一的视图）。其余占位格还没绑视图，
  // 切过去也没东西可显示，所以先不响应 —— 等视图做出来再在这里分发。
  if (index === 0) activeRail.value = 0;
}

/** 一次查询最多取多少张。后端 limit 不传 = 不限制，库大了会把界面拖垮 */
const RESULT_LIMIT = 100;

const images = ref<ImageItem[]>([]);
const loading = ref(false);
const error = ref("");
const hasSearched = ref(false);

/**
 * 请求序号。
 *
 * 搜索可以连着按回车，而每次调用都是一次 Python 冷启动（150–300ms）——
 * 先发的慢查询完全可能后到，把后发的结果覆盖掉。只认最后一次。
 */
let latestRequest = 0;

/** tag 数组由 TagSearchBar 解析好传来；空数组表示不带筛选条件查全部 */
async function runSearch(tags: string[]): Promise<void> {
  const requestId = ++latestRequest;

  loading.value = true;
  error.value = "";

  try {
    const result = await search({
      tags_all: tags.length > 0 ? tags : undefined,
      limit: RESULT_LIMIT,
    });
    if (requestId !== latestRequest) return; // 已经有更新的查询了，丢弃
    images.value = result.images;
    hasSearched.value = true;
    // 结果换了，之前那张图可能已经不在里面 —— 面板留着只会显示过期数据
    detailStore.closeDetail();
  } catch (e) {
    if (requestId !== latestRequest) return;
    error.value = describeError(e);
    images.value = [];
    hasSearched.value = true;
    detailStore.closeDetail();
  } finally {
    if (requestId === latestRequest) loading.value = false;
  }
}

/**
 * 后端返回的 message 通常已经够清楚；stderr 只在「进程起不来」那类问题上
 * 才有内容，而那种情况它恰恰是唯一的线索，所以一并显示。
 */
function describeError(e: unknown): string {
  if (e instanceof BackendCallError) {
    return e.stderr ? `${e.message}\n\n${e.stderr}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 图片详情面板
//
// 状态和定位逻辑都在 store 里（见 stores/imageDetail.ts）。这里只剩两件事：
// 把 app-main 登记给 store 当定位区，以及 Esc 关闭。
// ---------------------------------------------------------------------------

/** app-main 本体（定位层）。面板 absolute 挂在它里面 */
const mainRef = ref<HTMLElement | null>(null);

const detailStore = useImageDetailStore();

/** Esc 关闭。`keydown` 挂在 window 上，焦点不在面板里也能关 */
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") detailStore.closeDetail();
}

// 进页面先列一遍图库，免得对着空白页发呆
onMounted(() => {
  void runSearch([]);

  window.addEventListener("keydown", onGlobalKeydown);
  if (mainRef.value) detailStore.registerArea(mainRef.value);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  detailStore.unregisterArea();
});
</script>

<template>
  <div class="app">
    <SideRail :items="railItems" :active="activeRail" @select="onRailSelect" />

    <TagSearchBar @search="runSearch" />

    <!--
      app-main 是**定位层**（position: relative），真正滚动的是里面的 __scroll。
      拆开的原因：详情面板要钉在 app-main 的可见区里、高度铺满 app-main ——
      如果让 app-main 自己滚动，absolute 的面板会跟着内容一起滚走。
    -->
    <main ref="mainRef" class="app-main">
      <div class="app-main__scroll">
        <MasonryGrid :images="images" />
      </div>

      <ImageDetailPanel />
    </main>
  </div>
</template>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;

  /*
   * 颜色来自 theme.css 选中的配色文件（public/colors/*.css）。
   * var(...) 的第二个值是兜底：配色文件没加载到时退回原来的颜色，
   * 不至于白底黑字裸奔。
   */
  color: var(--color-text);
  background-color: var(--color-primary-100);

  /* 瀑布流的间距。网格的行列间距和列内的图片间距都用它，改一处就够。
     用 clamp 而不是固定值，窄窗口下不至于把图挤得太小 */
  --masonry-gap: clamp(8px, 1.2vw, 16px);
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #2f2f2f;
  }
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
}

.app {
  /* 给浮动查询条当定位锚点：它 absolute 定位到屏幕右上角，需要一个已定位的祖先 */
  position: relative;
  display: flex;
  /* 横排：左边功能列，右边主内容区。查询条是 absolute，不参与这个流 */
  flex-direction: row;
  height: 100%;
}

.app-main {
  /* min-width: 0：flex 子项默认最小宽度是 auto，不给 0 的话
     瀑布流内容会把主区撑宽、把整页挤出滚动条 */
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 定位层自己不滚，overflow hidden 只是兜底：别让详情面板从这里戳出去 */
  position: relative;
  overflow: hidden;
}

.app-main__scroll {
  height: 100%;
  overflow: auto;
  padding: clamp(0.5rem, 2vw, 1.5rem);
}

.app-status {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: rgba(128, 128, 128, 1);
}

.app-status--error {
  color: #d9534f;
  /* 错误信息里可能带着多行 Python traceback */
  white-space: pre-wrap;
}
</style>
