<template>
  <el-scrollbar ref="root" @scroll="onScroll">
    <virtual-item v-if="$slots.header" @resize="virtual.saveSize" uid="header">
      <slot name="header"/>
    </virtual-item>
    <div class="k-virtual-list-wrapper" :style="wrapperStyle">
      <virtual-item v-for="(item, index) in dataShown"
        :tag="itemTag" :class="resolveItemClass(item, index)" :uid="item[keyName]"
        @click.stop="emit('click', item, $event)" @resize="virtual.saveSize">
        <slot v-bind="item" :index="index + range.start"/>
      </virtual-item>
    </div>
    <virtual-item v-if="$slots.footer" @resize="virtual.saveSize" uid="footer">
      <slot name="footer"/>
    </virtual-item>
    <div ref="shepherd"/>
  </el-scrollbar>
</template>

<script lang="ts" setup>

import { ref, computed, watch, nextTick, onActivated, onMounted, onUpdated, onBeforeUnmount, defineComponent, h } from 'vue'
import { ElScrollbar } from 'element-plus'
import Virtual from './virtual'

const emit = defineEmits(['click', 'scroll', 'top', 'bottom', 'update:activeKey'])

const props = defineProps({
  keyName: { type: String, required: true },
  data: { type: Array, required: true },
  count: { default: 50 },
  estimated: { default: 50 },
  itemTag: { default: 'div' },
  itemClass: {},
  pinned: Boolean,
  activeKey: { default: '' },
  threshold: { default: 0 },
})

const dataShown = computed<any[]>(() => props.data.slice(range.start, range.end))

function resolveItemClass(item: any, index: number) {
  return typeof props.itemClass === 'function'
    ? props.itemClass(item, index + range.start)
    : props.itemClass
}

const root = ref<typeof ElScrollbar>()

watch(() => props.data.length, () => {
  const { scrollTop, clientHeight, scrollHeight } = root.value.wrap$
  if (!props.pinned || Math.abs(scrollTop + clientHeight - scrollHeight) < 1) {
    nextTick(scrollToBottom)
  }
  virtual.updateUids(getUids())
  virtual.handleDataChange()
})

watch(() => props.activeKey, (value) => {
  if (!value) return
  emit('update:activeKey', null)
  scrollToUid(value, true)
})

const shepherd = ref<HTMLElement>()

const wrapperStyle = computed(() => {
  const { padFront, padBehind } = range
  return { padding: `${padFront}px 0px ${padBehind}px` }
})

const virtual = new Virtual({
  count: props.count,
  estimated: props.estimated,
  buffer: Math.floor(props.count / 3),
  uids: getUids(),
})

const range = virtual.range

function getUids() {
  const { keyName, data } = props
  return data.map(item => item[keyName])
}

onMounted(() => {
  if (props.activeKey) {
    scrollToUid(props.activeKey)
  } else {
    scrollToBottom()
  }
})

function scrollToOffset(offset: number, smooth = false) {
  if (smooth) {
    root.value.wrap$.scrollTo({ top: offset, behavior: 'smooth' })
  } else {
    root.value.wrap$.scrollTop = offset
  }
}

// set current scroll position to a expectant index
function scrollToUid(uid: string, smooth = false) {
  scrollToOffset(virtual.getUidOffset(uid), smooth)
}

function scrollToBottom() {
  if (shepherd.value) {
    const offset = shepherd.value.offsetTop
    scrollToOffset(offset)

    // check if it's really scrolled to the bottom
    // maybe list doesn't render and calculate to last range
    // so we need retry in next event loop until it really at bottom
    setTimeout(() => {
      const offset = Math.ceil(root.value.wrap$.scrollTop)
      const clientLength = Math.ceil(root.value.wrap$.clientHeight)
      const scrollLength = Math.ceil(root.value.wrap$.scrollHeight)
      if (offset + clientLength < scrollLength) {
        scrollToBottom()
      }
    }, 3)
  }
}

let scrollTop = 0

onActivated(() => {
  root.value.setScrollTop(scrollTop)
})

function onScroll(ev: MouseEvent) {
  const offset = Math.ceil(scrollTop = root.value.wrap$.scrollTop)
  const clientLength = Math.ceil(root.value.wrap$.clientHeight)
  const scrollLength = Math.ceil(root.value.wrap$.scrollHeight)

  // iOS scroll-spring-back behavior will make direction mistake
  if (offset < 0 || (offset + clientLength > scrollLength + 1) || !scrollLength) {
    return
  }

  virtual.handleScroll(offset)
  emitEvent(offset, clientLength, scrollLength, ev)
}

function emitEvent(offset: number, clientLength: number, scrollLength: number, ev: MouseEvent) {
  emit('scroll', ev, virtual.range)
  if (virtual.direction < 0 && !!props.data.length && (offset - props.threshold <= 0)) {
    emit('top')
  } else if (virtual.direction > 0 && (offset + clientLength + props.threshold >= scrollLength)) {
    emit('bottom')
  }
}

const VirtualItem = defineComponent({
  props: {
    tag: String,
    uid: String,
  },

  emits: ['resize'],

  setup(props, { slots, emit }) {
    let resizeObserver: ResizeObserver
    const root = ref<HTMLElement>()

    onMounted(() => {
      resizeObserver = new ResizeObserver(dispatchSizeChange)
      resizeObserver.observe(root.value)
    })

    onUpdated(dispatchSizeChange)

    onBeforeUnmount(() => {
      resizeObserver.disconnect()
    })

    function dispatchSizeChange() {
      const marginTop = +(getComputedStyle(root.value).marginTop.slice(0, -2))
      emit('resize', props.uid, root.value.offsetHeight + marginTop)
    }

    return () => h(props.tag, { ref: root }, slots.default())
  },
})

</script>
