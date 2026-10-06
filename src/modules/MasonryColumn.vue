<script setup lang="ts" generic="T">
/**
 * 瀑布流的一列。只负责把这一列的条目竖着排出来，**不做分列决策**，也**不认识
 * 具体的卡片**（由调用方把组件传下来）。
 *
 * # 两处在用
 *
 * | 谁 | 传进来的 `items` |
 * |---|---|
 * | `MasonryGrid` | 它分好的**其中一列** |
 * | `CollectionImagesPanel`（合集图片栏）| 那个合集的全部图，**就一列** |
 *
 * 所以它只管「竖着排」这一件事。合集图片栏要的恰好就是一列，于是直接拿它当那
 * 一列用 —— 不必再写一个只排一列的组件（分列、间距、卡片的进出场都是现成的）。
 * 也因此它**不收 `Column`**：那里面还有个 `heightUnits`，那是**网格**用来挑最矮
 * 一列的账，只有 `MasonryGrid` 有义务维护它（见 `masonry.ts` 的 `Column`），
 * 硬塞个 0 进来只会让两边都以为对方管着这件事。
 *
 * 为什么不在这里决定「这张图该不该进我这一列」：分列要比较**所有列**的当前
 * 高度，单列看不到兄弟列。所以决策在 MasonryGrid 里，那里持有全部列的状态
 * （每列装了多少张、占了多高），本组件只拿渲染需要的部分。
 *
 * 宽度不设限，由外层的网格按列数分配（`minmax(0, 1fr)`）；高度不设限，
 * 有几张图就多高 —— 这正是瀑布流要的效果。
 *
 * # 卡片组件由外面传
 *
 * `card` 是个组件引用，收一个名为 `item` 的 prop —— 本组件把条目原样传给它。
 * 条目是「一张图 / 一个合集」的联合（见 wall.ts）：**右键干什么、要不要画合集
 * 标记**各页不同（库里右键看图、待入库只给合集开详情），所以卡片必须分化；
 * 但「怎么排」是一样的，那部分留在网格里。
 *
 * # 卡片的进出场
 *
 * `<TransitionGroup name="emerge">` 用的是详情面板那套共享动效（`src/styles/emerge.css`），
 * 但**只用「进」不用「出」**：
 *
 * - **进**：图片出现时从中心浮现。
 * - **出**：不做动画，元素立即移除。重新搜索要的是「旧队列瞬间清空」，逐个淡出
 *   反而会和正在逐张入场的新图挤在一起，糊成一团。实现见下面那条 CSS。
 *
 * 它只认**直接子元素**，所以必须放在这一层（列里），不能提到网格那层 —— 卡片要留在
 * 列内才能被 flex 竖排。代价是：某张图**换了一列**时，Vue 在旧列卸载它、在新列重建它，
 * 于是会再走一次浮现。这种情况在列数变化时会发生。
 * （重新查询已经不会了 —— 那张图不在新队列里，是「出」，而「出」不动画。）
 *
 * 顺带说明：换列时重新挂载**本来就存在**（卡片的 key 只在同一列内复用），
 * 不是这个动画引入的。
 */
import { type Component } from "vue";

defineProps<{
  /** 这一列要渲染的条目，顺序就是显示顺序 */
  items: T[];
  /** 取条目的稳定 key。见 MasonryGrid */
  keyOf: (item: T) => string;
  /** 渲染每一条的卡片组件。约定它收一个 `item` prop */
  card: Component;
}>();
</script>

<template>
  <div class="masonry-column">
    <TransitionGroup name="emerge">
      <!--
        key 用 keyOf 的结果（库里的图 = 文件名主干 / 合集 = 文件夹路径，都是磁盘上
        的名字、跨设备稳定）：重新查询时 Vue 能复用没变的条目，避免整列重挂载
        导致图片闪烁。前缀区分图与合集的理由见 wall.ts。
      -->
      <component
        :is="card"
        v-for="item in items"
        :key="keyOf(item)"
        :item="item"
      />
    </TransitionGroup>
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

  /*
   * 卡片一屏能有几十上百张，`emerge` 默认那 28px 模糊是给单块面板调的 ——
   * 同时糊这么多块太费，而且视觉上会糊成一团。压到 12px。
   * 自定义属性会继承，写在这里卡片就都读得到（见 styles/emerge.css）。
   */
  --emerge-blur: 12px;
}

/*
 * 卡片**不做退场**：重新搜索时要的是旧队列瞬间清空，不是逐个缩掉。
 *
 * 为什么得在这里压一下：卡片自己（比如 ImageCard）没声明 transition，所以
 * emerge 预设那条 `.emerge-leave-active`（权重 0-1-0）本来是会生效的。这里用
 * `:deep()` 把它抬到（0-3-0）再声明 `transition: none` 覆盖掉 —— 元素身上就
 * 查不到任何过渡了，Vue 也就不等，直接把它移除。
 *
 * 选择器**故意不写具体的卡片类**（原来是 `.image-card.emerge-leave-active`）：
 * 卡片是外面传进来的，两种卡片类名不同，写死一个就只对那一页生效。反过来，
 * 这也意味着卡片如果自己声明了退场过渡，会被这条压掉 —— 想留退场的卡片得
 * 在 `-leave-active` 上加点权重抗住（权重 0-3-0 起步）。
 *
 * `-leave-to`（透明 / 缩到 0）留着不冲突：没有过渡，那几条只会在被移除的那一帧
 * 生效，而这一帧和移除同属一次任务，浏览器不会画出来。
 */
.masonry-column :deep(.emerge-leave-active) {
  transition: none;
}
</style>
