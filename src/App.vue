<script setup lang="ts">
/**
 * 应用外壳：左边一条功能列，右边是当前打开的视图。
 *
 * 这里**只有「哪个视图开着」这一件事** —— 每个视图自己的数据、搜索、右键菜单
 * 全在各自的页组件里（见 `modules/gallery/GalleryView.vue`、
 * `modules/inbox/InboxView.vue`）。外壳不认识「图片」。
 *
 * `modules/` 根下的组件是**两页共用**的（瀑布流、自绘滚动条、功能列本身），
 * 页面私有的组件分别在 `modules/gallery/` 和 `modules/inbox/` 两个文件夹里。
 */
import { ref } from "vue";

import GalleryView from "./modules/gallery/GalleryView.vue";
import InboxView from "./modules/inbox/InboxView.vue";
import SideRail from "./modules/SideRail.vue";

/**
 * 功能列的按钮清单。5 格：第 0 格「看图」、第 1 格「待入库」是已经做出来的
 * 两个视图；第 2–4 格是占位 —— 图标暂时都用 tags.svg，点了也不切视图。
 */
const railItems = [
  { id: "gallery", label: "看图" },
  { id: "inbox", label: "待入库" },
  { id: "placeholder-1", label: "占位 1" },
  { id: "placeholder-2", label: "占位 2" },
  { id: "placeholder-3", label: "占位 3" },
];

/** 当前打开的视图下标。0 = 看图，1 = 待入库 */
const activeRail = ref(0);

function onRailSelect(index: number): void {
  // 2–4 格还是占位，切过去没东西可显示 —— 等视图做出来再在这里分发
  if (index === 0 || index === 1) activeRail.value = index;
}
</script>

<template>
  <div class="app">
    <SideRail :items="railItems" :active="activeRail" @select="onRailSelect" />

    <!--
      视图切换用 `v-if` 而不是 `v-show`：两页各自挂着 ResizeObserver、window
      键盘监听、自绘滚动条的 mousemove，`v-show` 只是藏起来、那些全都还在跑，
      而且两边都会去量同一块布局。`v-if` 让没在看的那个彻底下工。

      代价是**切回来会重新拉一次数据**（各页的 `onMounted` 会再跑）—— 现在数据量
      不大，先这样；真要留住滚动位置和搜索结果，再换成 `<KeepAlive>`。
    -->
    <GalleryView v-if="activeRail === 0" />
    <InboxView v-else-if="activeRail === 1" />
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

  /*
   * 框选选中后，图片四周让出的那圈主题色的宽度，按卡片宽度取百分比。
   *
   * 2.5% 的两倍就是宽度上让掉的量 —— 也就是「图片缩到 95%」。写成百分比而不是
   * 像素：列宽随窗口变，固定像素在宽屏上看着太细、窄屏上又把图切掉太多。
   * 四边用的是同一个值（CSS 规定百分比内边距在上下左右**都按包含块宽度**解析），
   * 所以这一圈天生等宽，不用为长方形图片额外算竖直方向的量。
   */
  --card-ring: 2.5%;

  /*
   * 多选小方框距图片右上角多远 = **那圈主题色的两倍宽**。
   *
   * 由 --card-ring 推出来而不是另写一个 5%：这两个数本来就该绑在一起 ——
   * 圈宽一改，方框的间距跟着变，比例永远是对的，只需要调 --card-ring 一处。
   * 想让方框独立于圆圈，把这里换成一个写死的百分比即可。
   *
   * 和 --card-ring 一样是百分比、跟着列宽缩放：固定像素在宽屏上会缩在角里，
   * 窄屏上又会盖住画面。基准是**卡片宽**（没选中时图片正好铺满卡片，
   * 所以也就是图片宽）。
   */
  --check-gap: calc(var(--card-ring) * 2);
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

/*
 * 视图的根元素（两个页组件的最外层都是它）。
 *
 * 这两条样式放在外壳里而不是各页里，是因为**外层是外壳的事**：页组件只管往
 * 里面填内容，不该关心自己在 flex 里占多宽。等下要多加视图，也是照着这个类名挂。
 */
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

  /*
   * 原生滚动条整个撤掉，改用自绘的那条（ScrollIndicator.vue）。
   * 两条并存的话会重复：原生那条还要占宽，内容会白白缩掉十几个像素，
   * 位置也对不上。滚动能力不受影响，滚轮 / 键盘 / 触摸照常。
   */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.app-main__scroll::-webkit-scrollbar {
  display: none;
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
