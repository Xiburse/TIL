<script setup lang="ts">
/**
 * 浮动式 tag 查询条，默认锚定在屏幕右上角，可拖动。
 *
 * # 三态
 *
 * | 状态 | 样子 |
 * |---|---|
 * | 静止 | 一个正圆，中心是 tags 图标 |
 * | 鼠标移上去 | 向**左**展开成输入框（右端不动，所以右上角位置不变） |
 * | 有内容 / 有焦点 | 保持展开，鼠标移开也不收回 |
 *
 * # 为什么不收回
 *
 * 输入框里有内容时收起来会让人以为查询条件丢了。所以「有没有内容」也是展开
 * 条件之一 —— 清空文字（或按 Esc）才会缩回成按钮。
 *
 * 另外把「输入框有焦点」也算进展开条件：否则刚点进去还没来得及打字，鼠标一移开
 * 就缩回去，输入框带着光标被裁掉，明显是 bug 感。
 *
 * # 拖动
 *
 * 按住**图标**可以拖动整个胶囊（输入框区域不拖，那里要留着选文字）。
 * 拖动只挪位置、不动大小；拖过之后位置由内联的 right/top 覆盖 CSS 默认值。
 *
 * 锚定用 **right/top 而不是 left/top**，有两个原因：
 * 1. 和默认的右上角右锚定一致 —— 展开时向左长、图标那端不动的视觉不变。
 *    换成 left 锚定的话，展开方向会反过来（向右长），拖到左边还能把图标
 *    顶出屏幕外，之后就没法再抓着它拖回来了。
 * 2. 从默认位置起拖不会跳变（right 本来就小，钳制边界咬不到它）。
 *
 * 位置**不持久化**，重启回默认右上角。要持久化（localStorage）另说。
 *
 * 只负责「用户敲进去的文字」→「tag 数组」，发请求是父组件的事 ——
 * 这样它不知道后端长什么样，换个页面也能直接用。
 */
import { computed, ref } from "vue";

const emit = defineEmits<{
  /** 回车时触发。tag 数组可能为空，表示「不带筛选条件查全部」 */
  search: [tags: string[]];
}>();

const root = ref<HTMLElement | null>(null);
const text = ref("");
const hovering = ref(false);
const focused = ref(false);

/** 拖动中（用来换 cursor、冻结 hover 判断） */
const dragging = ref(false);

/**
 * 拖动后的位置，**right/top 都是距窗口边缘的像素**。null = 还没拖过，
 * 走 CSS 的默认右上角。
 */
const pos = ref<{ right: number; top: number } | null>(null);

/** 从按下到当前的总位移小于它就当点击 —— 免得手抖把按钮挪走 */
const DRAG_THRESHOLD = 5;

/*
 * --open-width 的 JS 版，**必须和 CSS 里那行保持一致**：
 * min(360px, calc(100vw - 3rem))，根字号 16px → 3rem = 48px。
 * 拖动钳制边界时拿它算，否则拖到屏幕左边再展开，输入框会有大半截挂到屏幕外。
 * 改 CSS 里 --open-width 的话，这里要跟着改。
 */
const OPEN_WIDTH_MAX = 360;
const OPEN_WIDTH_MARGIN = 48;

/** 展开时胶囊的实际宽度（窄窗口下比 360 小） */
function openWidthPx(): number {
  return Math.min(OPEN_WIDTH_MAX, window.innerWidth - OPEN_WIDTH_MARGIN);
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  /** 按下时胶囊右边缘到窗口右边缘的距离 */
  baseRight: number;
  /** 按下时胶囊上边缘的 y 坐标 */
  baseTop: number;
  height: number;
}

/** 拖动中的中间值不需要驱动渲染，用普通变量，不用 ref */
let drag: DragState | null = null;

/** 展开 = 鼠标在上面 / 输入框有焦点 / 输入框里有内容 */
const open = computed(
  () => hovering.value || focused.value || text.value.trim().length > 0,
);

/** 拖过之后覆盖 CSS 的右上角默认值；没拖过返回 undefined，完全交给 CSS */
const positionStyle = computed(() => {
  const p = pos.value;
  return p ? { right: `${p.right}px`, top: `${p.top}px` } : undefined;
});

// ---------------------------------------------------------------------------
// 拖动
// ---------------------------------------------------------------------------

function clampPosition(
  right: number,
  top: number,
  height: number,
): { right: number; top: number } {
  // right 大 = 更靠左。上限保证展开（向左长）后左边缘不越出屏幕；
  // 下限 0 保证右边缘不越出屏幕（图标永远抓得到）。
  const maxRight = Math.max(window.innerWidth - openWidthPx(), 0);
  return {
    right: Math.min(Math.max(right, 0), maxRight),
    top: Math.min(Math.max(top, 0), Math.max(window.innerHeight - height, 0)),
  };
}

function onPointerDown(event: PointerEvent): void {
  // 只认左键（触摸时 button 就是 0），右键菜单不能被拖动劫持
  if (event.button !== 0 || drag) return;
  const el = root.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    baseRight: window.innerWidth - rect.right,
    baseTop: rect.top,
    height: rect.height,
  };
  dragging.value = true;
  // 别让浏览器顺手把焦点挪走 / 开始选中页面文字
  event.preventDefault();
  // 捕获指针：之后指针跑出胶囊（甚至跑出窗口），move/up 仍然送回这个元素，
  // 不用担心拖快了事件断掉
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;

  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  // 没过阈值就不动位置：按下 + 微小抖动应当算「点击」而不是「拖走」
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

  // 向右拖 dx > 0 → right 变小（右边缘往右移）
  const raw = { right: drag.baseRight - dx, top: drag.baseTop + dy };
  pos.value = clampPosition(raw.right, raw.top, drag.height);
}

function onPointerUp(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag = null;
  dragging.value = false;

  /*
   * 拖动期间 mouseenter/mouseleave 被冻结了（见 onEnter/onLeave），松手时
   * 指针可能已经在按钮外面 —— 拖到屏幕边界被钳住、指针继续往外走就是这情况。
   * 问一次浏览器，别让按钮卡在「展开」状态。
   */
  const el = root.value;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  hovering.value = Boolean(el && hit && el.contains(hit));
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 接口要求用**下划线原形**查询（`long_hair` 而不是 `long hair`），
 * 所以这里把空格换成下划线 —— 让用户手敲下划线太反人类。
 *
 * 逗号分隔多个 tag（中英文逗号都认），多个 tag 之间是 AND 关系。
 */
function parseTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((part) => part.trim().replace(/\s+/g, "_"))
    .filter((tag) => tag.length > 0);
}

function submit(): void {
  emit("search", parseTags(text.value));
}

/** Esc = 清空并失焦。清掉内容就满足了收回条件，输入框缩回成按钮 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  text.value = "";
  (event.currentTarget as HTMLInputElement).blur();
}

function onEnter(): void {
  // 拖动中指针会随胶囊移动、可能短暂出界，这时候的进出事件不能信
  if (!dragging.value) hovering.value = true;
}

function onLeave(): void {
  if (!dragging.value) hovering.value = false;
}
</script>

<template>
  <div
    ref="root"
    class="tag-search"
    :class="{ 'tag-search--open': open }"
    :style="positionStyle"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <input
      v-model="text"
      class="tag-search__input"
      type="text"
      placeholder="输入 tag 回车查询，多个用逗号分隔（如 long_hair, solo）"
      spellcheck="false"
      autocomplete="off"
      :tabindex="open ? 0 : -1"
      @focus="focused = true"
      @blur="focused = false"
      @keydown="onKeydown"
      @keyup.enter="submit"
    />
    <!--
      图标：既是收起时那个圆、展开时胶囊的右半截，也是**唯一的拖动把手**。
      只挂在它上面是为了让输入框区域保持正常（选中文字、点进光标）。
    -->
    <span
      class="tag-search__icon"
      :class="{ 'tag-search__icon--dragging': dragging }"
      aria-hidden="true"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
  </div>
</template>

<style scoped>
.tag-search {
  /* 圆的直径 = 展开后的高度，两者必须一样，收起时才不会变形 */
  --size: 44px;

  /*
   * 展开宽度用 min() 而不是固定值 —— 窗口比 360px 还窄时不能顶出屏幕。
   * 这是「响应式」的落点：尺寸跟着视口走，不留写死的魔法数。
   *
   * ⚠ 数值被 JS 侧的钳制逻辑抄了一份（OPEN_WIDTH_MAX / OPEN_WIDTH_MARGIN），
   * 改这里记得一起改。
   */
  --open-width: min(360px, calc(100vw - 3rem));

  position: absolute;
  top: clamp(0.5rem, 2vw, 1.25rem);
  right: clamp(0.5rem, 2vw, 1.25rem);
  /* 浮在瀑布流上面 */
  z-index: 100;

  display: flex;
  align-items: center;
  height: var(--size);
  /* 静止：正圆 */
  width: var(--size);
  /*
   * 关键：overflow hidden 把输入框裁掉，容器才能保持正圆。
   * 没有它，flex:1 的输入框会把容器撑成一个方块。
   */
  overflow: hidden;

  /* 收起是正圆、展开是胶囊，半径都用 size/2，不用跟着动画变 */
  border-radius: calc(var(--size) / 2);

  background-color: var(--color-primary-800);
  color: var(--color-surface);

  /* 只过渡 width，够了。半径和高度都不变，不跟着过渡；位置也不过渡（拖动要跟手） */
  transition: width 0.28s ease;
}

/* 展开：宽度向左长（right 锚定，右端不动），不管有没有拖过都成立 */
.tag-search--open {
  width: var(--open-width);
}

.tag-search__input {
  flex: 1;
  /* 允许收缩到 0，收起时才不占宽度 */
  min-width: 0;
  height: 100%;
  /*
   * 收起时必须是 0。
   *
   * 全局是 box-sizing: border-box，padding **在盒子里**、不参与收缩 ——
   * 所以就算 flex 把内容盒压到 0，1em + 0.25rem 的内边距照样撑着，输入框的
   * 最小外宽就是这约 20px。这 20px 会把右边的图标顶过去，再被容器的
   * overflow: hidden 裁掉一截，看着就是「图标没居中」。
   */
  padding: 0;
  border: none;
  background: transparent;

  font-size: 0.95rem;
  outline: none;

  /* 收起时不显示，也不接受点击 */
  opacity: 0;
  pointer-events: none;
  transition:
    /* 延迟 120ms 再淡入：等宽度先展开一点，文字才不会在半路挤成一团。
       淡出不延迟（延迟只写在这一条上），收起时立刻消失 */
    opacity 0.12s ease 120ms,
    padding 0.28s ease;

  color: var(--color-surface);
  caret-color: var(--color-surface);
}

.tag-search__input::placeholder {
  color: var(--color-surface);
  opacity: 0.5;
}

.tag-search--open .tag-search__input {
  opacity: 1;
  pointer-events: auto;
  padding: 0 0.25rem 0 1em;
  transition:
    opacity 0.16s ease,
    padding 0.28s ease;
}

.tag-search__icon {
  flex: none;
  width: var(--size);
  height: var(--size);

  /* 拖动把手。touch-action: none 是给触屏的：拖动时别让浏览器抢去做页面滚动 */
  cursor: grab;
  user-select: none;
  touch-action: none;

  /*
   * 用 CSS mask 而不是 <img src="/tags.svg">，原因是 **主题色**：
   *
   * tags.svg 里的填充是 fill="currentColor"，但它一旦被 <img> 加载，就成了一张
   * 独立的图片文档，里面的 currentColor 解析成它自己的 color（永远是黑色），
   * 拿不到页面的颜色 —— 结果暗色主题下图标全黑看不见。
   *
   * mask 是取这张图的**轮廓**，再用 background-color: currentColor 上色，
   * 所以图标颜色永远跟文字颜色走，明暗主题自动正确。
   */
  background-color: currentColor;
  -webkit-mask: url("/tags.svg") center / 22px 22px no-repeat;
  mask: url("/tags.svg") center / 22px 22px no-repeat;
}

/*
 * 拖动时指针始终停在把手上（位置跟手，按下点不动），所以 grabbing 光标
 * 整个拖动过程都成立。
 */
.tag-search__icon--dragging {
  cursor: grabbing;
}

@media (prefers-color-scheme: dark) {
  .tag-search {
    background-color: rgba(38, 38, 38, 0.9);
  }
}

/* 尊重「减少动画」的无障碍设置：状态照变，只是瞬间到位 */
@media (prefers-reduced-motion: reduce) {
  .tag-search,
  .tag-search__input {
    transition: none;
  }
}
</style>
