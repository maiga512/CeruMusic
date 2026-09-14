<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import { PinFilledIcon, PinIcon, PlayCircleIcon } from 'tdesign-icons-vue-next'
import QRCode from 'qrcode'
import songCover from '@assets/images/song.jpg'
import podcastApi from '@renderer/api/podcast'
import PagerBar from '@renderer/components/Pager/PagerBar.vue'
import { nasFavoriteAPI, togglePodcastFavoritePinned } from '@renderer/api/nasSync'
import {
  HOME_BLOCKS,
  HOME_SHELF,
  type PodcastCategorySpec,
  type PodcastHomeBlockSpec
} from './podcastHomeSpec'

interface Category {
  id: number
  rawId?: string
  name: string
  subCategories?: { id: string; name: string }[]
}

interface RadioCard {
  id: string
  name: string
  desc?: string
  img?: string
  author?: string
  total?: number
  play_count?: string
  playCount?: number
  category?: string
  replaceRadioId?: string
  source?: string
}

const plainCategory = (category?: Category | null) => {
  if (!category) return null
  return {
    id: category.id,
    rawId: category.rawId || '',
    name: category.name,
    subCategories: (category.subCategories || []).map((item) => ({
      id: item.id,
      name: item.name
    }))
  }
}

const plainRadio = (radio: RadioCard) => ({
  id: radio.id,
  name: radio.name,
  desc: radio.desc || '',
  img: radio.img || '',
  author: radio.author || '',
  total: radio.total || 0,
  play_count: radio.play_count || '',
  playCount: radio.playCount || 0,
  category: radio.category || '',
  replaceRadioId: radio.replaceRadioId || '',
  source: radio.source || 'wy'
})

const router = useRouter()
const loginLabel = ref('未登录')
const loginLoggedIn = ref(false)
const showLogin = ref(false)
const podcastQr = ref('')
const podcastQrKey = ref('')
const podcastBusy = ref(false)
const loginMessage = ref('打开网易云 App 扫码后确认登录')
let podcastTimer: number | null = null

const categories = ref<Category[]>([])
const selectedCategory = ref<Category | null>(null)
const selectedSecond = ref('')
const categoryRadios = ref<RadioCard[]>([])
const secondCategories = ref<string[]>([])
const categoryLoading = ref(false)
const categoryError = ref('')
const categoryPage = ref(1)
const categoryEstimatedPages = ref(1)
const categoryHasMore = ref(false)
const categoryPageSize = ref(18)
const categoryTotal = ref(0)
const categoryTotalPending = ref(false)
const categoryGridRef = ref<HTMLElement | null>(null)
const categoryCols = ref(6)
const CATEGORY_ROWS = 3

const shelfRadios = ref<RadioCard[]>([])
const shelfLoading = ref(false)
const podcastFavorites = ref<RadioCard[]>([])
const podcastFavoritesLoading = ref(false)
const pinnedPodcastFavoriteKeys = ref(new Set<string>())

const podcastFavoriteKey = (radio: Pick<RadioCard, 'id' | 'source'>) =>
  `${radio.source || 'wy'}:${radio.id}`

const loadPodcastFavorites = async () => {
  podcastFavoritesLoading.value = true
  try {
    const result = await nasFavoriteAPI.listPodcastFavorites()
    podcastFavorites.value = result.items.map((item) => ({
      id: item.radioId,
      name: item.title,
      desc: item.description,
      img: item.coverUrl,
      author: item.author,
      total: item.total,
      play_count: item.playCount,
      source: item.source
    }))
    pinnedPodcastFavoriteKeys.value = new Set(
      result.items
        .filter((item) => item.pinned)
        .map((item) => podcastFavoriteKey({ id: item.radioId, source: item.source }))
    )
  } catch {
    podcastFavorites.value = []
    pinnedPodcastFavoriteKeys.value = new Set()
  } finally {
    podcastFavoritesLoading.value = false
  }
}

const togglePodcastPin = async (radio: RadioCard) => {
  const result = await togglePodcastFavoritePinned(radio.source, radio.id)
  await loadPodcastFavorites()
  if (result.syncError) {
    MessagePlugin.warning(`${result.syncError.message}，已保留本机置顶状态`)
  }
}

interface BlockViewState {
  sub: string
  page: number
  radios: RadioCard[]
  loading: boolean
}

/** 首页板块只做预览：一排卡片 + 换一批翻页，避免小窗口下横向滚动看不全 */
const BLOCK_FETCH_LIMIT = 12
const blockStates = ref<Record<string, BlockViewState>>(
  Object.fromEntries(
    HOME_BLOCKS.map((block) => [block.title, { sub: '', page: 1, radios: [], loading: false }])
  )
)

const visibleCategoryRadios = computed(() => categoryRadios.value.slice(0, categoryPageSize.value))
const visibleShelfRadios = computed(() => shelfRadios.value.slice(0, 10))

/** 总量探测是异步的：拿到真实总量就用它算页数，否则退回「当前页 + 是否还有下一页」估算 */
const categoryTotalPages = computed(() =>
  categoryTotal.value
    ? Math.max(1, Math.ceil(categoryTotal.value / categoryPageSize.value))
    : Math.max(1, categoryEstimatedPages.value)
)

const radioKey = (radio: RadioCard) =>
  radio.replaceRadioId && radio.replaceRadioId !== '0' ? radio.replaceRadioId : radio.id

const radioMeta = (radio: RadioCard) => {
  const bits = [radio.category, radio.author, radio.total ? `${radio.total} 期` : '']
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  return bits.slice(0, 2).join(' · ') || '网易云电台'
}

const normalizeSeconds = (category?: Category | null, fallback: string[] = []) => {
  const fromTree = (category?.subCategories || [])
    .map((item) => String(item?.name || '').trim())
    .filter((name) => name && name !== '全部')
  const fromFallback = fallback
    .map((name) => String(name || '').trim())
    .filter((name) => name && name !== '全部')
  return Array.from(new Set(fromTree.length ? fromTree : fromFallback))
}

const openRadio = (radio: RadioCard) => {
  router.push({
    name: 'radio-detail',
    params: { id: radioKey(radio) },
    query: {
      title: radio.name,
      source: radio.source || 'wy',
      author: radio.author || '',
      cover: radio.img || '',
      total: String(radio.total || 0),
      playCount: radio.play_count || '',
      desc: radio.desc || ''
    }
  })
}

const playRadio = async (radio: RadioCard) => {
  try {
    const res = await podcastApi.getPrograms({
      radioId: radioKey(radio),
      page: 1,
      limit: 1,
      asc: false,
      radio: plainRadio(radio)
    })
    const first = res?.list?.[0]
    if (!first) {
      MessagePlugin.warning('这个电台暂未返回可播放节目')
      return
    }
    if ((window as any).musicEmitter) {
      ;(window as any).musicEmitter.emit('addToPlaylistAndPlay', first)
    }
  } catch (error: any) {
    MessagePlugin.error(error?.message || '官方播客播放失败')
  }
}

const loadChannel = async (spec: PodcastCategorySpec, limit = 12, page = 1) => {
  const res = await podcastApi.getHomeChannel({
    officialCategoryNames: spec.officialCategoryNames || [],
    officialSecondNames: spec.officialSecondNames || [],
    keywords: spec.keywords || [spec.name],
    page: Math.max(1, Number(page) || 1),
    limit
  })
  return (res?.radios || []) as RadioCard[]
}

const mergeRadios = (lists: RadioCard[][], limit = 10) => {
  const merged: RadioCard[] = []
  const seen = new Set<string>()
  lists.flat().forEach((radio) => {
    const key = radioKey(radio)
    if (!key || seen.has(key)) return
    seen.add(key)
    merged.push(radio)
  })
  return merged.slice(0, limit)
}

const loadCategories = async () => {
  categories.value = (await podcastApi.getCategories(true)) || []
  selectedCategory.value = categories.value[0] || null
  secondCategories.value = normalizeSeconds(selectedCategory.value)
  if (selectedCategory.value) {
    categoryTotal.value = 0
    await loadCategoryPage(1)
    loadCategoryTotal()
  }
}

const updateCategoryPageSize = () => {
  const el = categoryGridRef.value
  const width = el?.clientWidth || document.querySelector('.podcast-page')?.clientWidth || 960
  const minCard = width < 720 ? 132 : width < 1280 ? 156 : 172
  const gap = width < 720 ? 10 : 14
  const cols = Math.max(3, Math.floor((width + gap) / (minCard + gap)))
  categoryCols.value = cols
  categoryPageSize.value = cols * CATEGORY_ROWS
}

/**
 * 官方分类接口只返回 hasMore，没有总数；单独探一次总量，
 * 让分页条能直接给出「1 2 3 … 最后一页」并支持跳页。主进程按分类缓存结果。
 */
const loadCategoryTotal = async () => {
  const category = selectedCategory.value
  if (!category) return
  const requestKey = `${category.rawId || category.name}:${selectedSecond.value}`
  categoryTotalPending.value = true
  try {
    const res = await podcastApi.getCategoryTotal({
      category: plainCategory(category),
      secondName: selectedSecond.value || undefined
    })
    const currentKey = `${selectedCategory.value?.rawId || selectedCategory.value?.name}:${selectedSecond.value}`
    if (requestKey !== currentKey) return
    categoryTotal.value = Number(res?.total || 0)
  } catch {
    categoryTotal.value = 0
  } finally {
    categoryTotalPending.value = false
  }
}

const loadCategoryPage = async (pageNum = 1) => {
  if (!selectedCategory.value) return
  categoryLoading.value = true
  categoryError.value = ''
  updateCategoryPageSize()
  const targetPage = Math.max(1, Number(pageNum) || 1)
  try {
    const res = await podcastApi.getCategoryPage({
      category: plainCategory(selectedCategory.value),
      secondName: selectedSecond.value || undefined,
      page: targetPage,
      pageSize: categoryPageSize.value
    })
    categoryRadios.value = (res?.radios || []) as RadioCard[]
    if (Number(res?.total || 0) > 0) categoryTotal.value = Number(res.total)
    if (res?.category?.rawId || res?.category?.subCategories?.length) {
      selectedCategory.value = {
        ...selectedCategory.value,
        ...res.category,
        subCategories: res.category.subCategories?.length
          ? res.category.subCategories
          : selectedCategory.value.subCategories
      }
      const index = categories.value.findIndex(
        (item) =>
          item.rawId === selectedCategory.value?.rawId || item.name === selectedCategory.value?.name
      )
      if (index >= 0 && selectedCategory.value) {
        categories.value[index] = selectedCategory.value
      }
    }
    secondCategories.value = normalizeSeconds(selectedCategory.value, res?.secondCategories || [])
    categoryHasMore.value = Boolean(res?.hasMore)
    categoryPage.value = targetPage
    categoryEstimatedPages.value = categoryHasMore.value ? targetPage + 1 : Math.max(1, targetPage)
  } catch (error: any) {
    categoryError.value = error?.message || '官方播客分类加载失败'
    categoryRadios.value = []
    secondCategories.value = normalizeSeconds(selectedCategory.value)
    categoryHasMore.value = false
    categoryEstimatedPages.value = 1
    categoryPage.value = 1
  } finally {
    categoryLoading.value = false
  }
}

const goCategoryPage = async (pageNum: number) => {
  if (categoryLoading.value) return
  const next = Math.max(1, Number(pageNum) || 1)
  if (next === categoryPage.value) return
  await loadCategoryPage(next)
  await nextTick()
  categoryGridRef.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

const selectCategory = (category: Category) => {
  selectedCategory.value = category
  selectedSecond.value = ''
  secondCategories.value = normalizeSeconds(category)
  categoryTotal.value = 0
  loadCategoryPage(1)
  loadCategoryTotal()
}

const selectSecond = (name: string) => {
  const next = String(name || '').trim()
  selectedSecond.value = !next || selectedSecond.value === next ? '' : next
  categoryTotal.value = 0
  loadCategoryPage(1)
  loadCategoryTotal()
}

const openCategoryDirectory = (payload: { category?: string; rawId?: string; second?: string }) => {
  router.push({
    name: 'podcast-categories',
    query: {
      category: payload.category || '',
      rawId: payload.rawId || '',
      second: payload.second || ''
    }
  })
}

const handleNasSyncEvents = (event: Event) => {
  const detail = (event as CustomEvent<{ events?: any[] }>).detail
  if (detail?.events?.some((item) => item?.entityType === 'favorite' && item?.payload?.entityType === 'podcast')) {
    void loadPodcastFavorites()
  }
}
const loadShelf = async () => {
  shelfLoading.value = true
  try {
    const lists = await Promise.all(HOME_SHELF.specs.map((spec) => loadChannel(spec, 6)))
    shelfRadios.value = mergeRadios(lists, 10)
  } catch {
    shelfRadios.value = []
  } finally {
    shelfLoading.value = false
  }
}

const blockState = (title: string): BlockViewState =>
  blockStates.value[title] || { sub: '', page: 1, radios: [], loading: false }

/** 只展示一排：列数跟随分类区，多取一点数据避免窗口变宽时缺卡 */
const visibleBlockRadios = (title: string) => blockState(title).radios.slice(0, categoryCols.value)

const patchBlock = (title: string, patch: Partial<BlockViewState>) => {
  blockStates.value = {
    ...blockStates.value,
    [title]: { ...blockState(title), ...patch }
  }
}

const fetchBlockRadios = async (block: PodcastHomeBlockSpec, sub: string, page: number) => {
  const specs = sub
    ? block.subcategories.filter((item) => item.name === sub)
    : block.subcategories.slice(0, 4)
  const targets = specs.length ? specs : block.subcategories.slice(0, 1)
  const lists = await Promise.all(targets.map((spec) => loadChannel(spec, BLOCK_FETCH_LIMIT, page)))
  return mergeRadios(lists, BLOCK_FETCH_LIMIT)
}

const loadBlock = async (
  block: PodcastHomeBlockSpec,
  options: { sub?: string; page?: number } = {}
) => {
  const current = blockState(block.title)
  const targetSub = options.sub === undefined ? current.sub : options.sub
  const targetPage = Math.max(1, Number(options.page ?? current.page) || 1)
  patchBlock(block.title, { loading: true, sub: targetSub, page: targetPage })
  try {
    let radios = await fetchBlockRadios(block, targetSub, targetPage)
    let finalPage = targetPage
    // 翻到尾巴就回到第一批，保证「换一批」永远有内容
    if (!radios.length && targetPage > 1) {
      finalPage = 1
      radios = await fetchBlockRadios(block, targetSub, 1)
    }
    patchBlock(block.title, { radios, page: finalPage })
  } catch {
    patchBlock(block.title, { radios: [] })
  } finally {
    patchBlock(block.title, { loading: false })
  }
}

const selectBlockSub = (block: PodcastHomeBlockSpec, name: string) => {
  const current = blockState(block.title)
  if (current.loading) return
  const next = current.sub === name ? '' : name
  if (next === current.sub && current.radios.length) return
  loadBlock(block, { sub: next, page: 1 })
}

const shuffleBlock = (block: PodcastHomeBlockSpec) => {
  const current = blockState(block.title)
  if (current.loading) return
  loadBlock(block, { sub: current.sub, page: current.page + 1 })
}

const loadBlocks = async () => {
  await Promise.all(HOME_BLOCKS.map((block) => loadBlock(block, { page: 1 })))
}

const goMore = () => {
  openCategoryDirectory({
    category: selectedCategory.value?.name || '',
    rawId: selectedCategory.value?.rawId || '',
    second: selectedSecond.value || ''
  })
}

const refreshLogin = async () => {
  try {
    const login = await podcastApi.getLoginState()
    loginLoggedIn.value = Boolean(login.loggedIn)
    loginLabel.value = login.loggedIn ? login.nickname || '网易云播客已登录' : '未登录'
  } catch {
    loginLoggedIn.value = false
    loginLabel.value = '未登录'
  }
}

const stopPodcastPoll = () => {
  if (podcastTimer != null) {
    window.clearInterval(podcastTimer)
    podcastTimer = null
  }
}

const startPodcastQr = async () => {
  podcastBusy.value = true
  try {
    stopPodcastPoll()
    const qr = await podcastApi.createQr()
    podcastQrKey.value = qr.key
    podcastQr.value = await QRCode.toDataURL(qr.qrUrl, { width: 280, margin: 1 })
    loginMessage.value = '打开网易云 App 扫码后确认登录'
    podcastTimer = window.setInterval(async () => {
      if (!podcastQrKey.value) return
      try {
        const result = await podcastApi.checkQr(podcastQrKey.value)
        loginMessage.value = result.message || loginMessage.value
        if (result.code === 803) {
          stopPodcastPoll()
          await refreshLogin()
          showLogin.value = false
          podcastQr.value = ''
          MessagePlugin.success(loginLabel.value || '网易云播客登录成功')
          await Promise.all([loadCategoryPage(1), loadShelf(), loadBlocks()])
        } else if (result.code === 800) {
          stopPodcastPoll()
          loginMessage.value = '二维码已过期，请刷新'
        }
      } catch (error: any) {
        loginMessage.value = error?.message || '扫码状态检查失败'
      }
    }, 1800)
  } catch (error: any) {
    loginMessage.value = error?.message || '二维码生成失败'
  } finally {
    podcastBusy.value = false
  }
}

const openLogin = async () => {
  if (loginLoggedIn.value) return
  showLogin.value = true
  await startPodcastQr()
}

const closeLogin = () => {
  showLogin.value = false
  stopPodcastPoll()
}

const doLogoutPodcast = async () => {
  stopPodcastPoll()
  await podcastApi.logout()
  podcastQr.value = ''
  podcastQrKey.value = ''
  await refreshLogin()
  showLogin.value = false
  MessagePlugin.success('已退出网易云播客登录')
}

/** 点昵称 → 下拉里选「退出登录」→ 这里再弹一次确认，避免误触直接掉登录 */
const confirmLogoutPodcast = () => {
  const dialog = DialogPlugin.confirm({
    header: '退出网易云播客登录',
    body: `确定要退出「${loginLabel.value || '当前账号'}」吗？退出后播客官方内容将以未登录状态请求。`,
    confirmBtn: { content: '退出登录', theme: 'danger' },
    cancelBtn: '取消',
    onConfirm: async () => {
      await doLogoutPodcast()
      dialog.destroy()
    }
  })
}

const handleLoginMenu = (data: { value?: string | number | Record<string, any> }) => {
  if (data?.value === 'logout') confirmLogoutPodcast()
}

let categoryResizeObserver: ResizeObserver | null = null
let recommendationTimer: number | null = null

onMounted(async () => {
  window.addEventListener('ceru-nas-sync-events', handleNasSyncEvents)
  await refreshLogin()
  await nextTick()
  updateCategoryPageSize()
  if (typeof ResizeObserver !== 'undefined') {
    categoryResizeObserver = new ResizeObserver(() => {
      const prev = categoryPageSize.value
      updateCategoryPageSize()
      if (prev !== categoryPageSize.value && selectedCategory.value) {
        loadCategoryPage(1)
      }
    })
    const pageEl = document.querySelector('.podcast-page')
    if (pageEl) categoryResizeObserver.observe(pageEl)
  }
  await loadCategories()
  await Promise.all([loadShelf(), loadBlocks(), loadPodcastFavorites()])
  // 推荐区定期换一批，保持首页内容持续更新；不影响用户当前分类页。
  recommendationTimer = window.setInterval(() => {
    void loadShelf()
    void loadBlocks()
  }, 15 * 60 * 1000)
})

onUnmounted(() => {
  window.removeEventListener('ceru-nas-sync-events', handleNasSyncEvents)
  stopPodcastPoll()
  if (recommendationTimer != null) {
    window.clearInterval(recommendationTimer)
    recommendationTimer = null
  }
  categoryResizeObserver?.disconnect()
  categoryResizeObserver = null
})
</script>

<template>
  <div class="podcast-page">
    <header class="page-head">
      <div class="title-wrap">
        <h2>播客分类</h2>
        <p>官方大类 / 细分类 / 真实节目</p>
      </div>
      <div class="head-actions">
        <button class="more-btn" @click="goMore">全部</button>
        <t-dropdown
          v-if="loginLoggedIn"
          trigger="click"
          placement="bottom-right"
          :min-column-width="140"
          @click="handleLoginMenu"
        >
          <button class="login-chip on">{{ loginLabel }}</button>
          <t-dropdown-menu>
            <t-dropdown-item value="logout" theme="error">退出登录</t-dropdown-item>
          </t-dropdown-menu>
        </t-dropdown>
        <button v-else class="login-chip" @click="openLogin()">扫码登录</button>
      </div>
    </header>

    <section class="category-section">
      <div class="chip-scroller">
        <button
          v-for="item in categories"
          :key="item.rawId || item.id"
          class="chip"
          :class="{ active: selectedCategory?.name === item.name }"
          @click="selectCategory(item)"
        >
          {{ item.name }}
        </button>
      </div>

      <div v-if="secondCategories.length" class="chip-scroller sub">
        <button class="chip ghost" :class="{ active: !selectedSecond }" @click="selectSecond('')">
          全部
        </button>
        <button
          v-for="name in secondCategories"
          :key="name"
          class="chip ghost"
          :class="{ active: selectedSecond === name }"
          @click="selectSecond(name)"
        >
          {{ name }}
        </button>
      </div>

      <p v-if="categoryError && !visibleCategoryRadios.length" class="state-text">
        {{ categoryError }}
      </p>
      <p v-else-if="categoryLoading && !visibleCategoryRadios.length" class="state-text">
        正在加载 {{ selectedSecond || selectedCategory?.name }}...
      </p>
      <p v-else-if="!categoryLoading && !visibleCategoryRadios.length" class="state-text">
        {{ selectedSecond || selectedCategory?.name || '当前分类' }} 暂时没有返回内容
      </p>
      <div
        v-else
        ref="categoryGridRef"
        class="radio-grid category-grid"
        :style="{ '--cols': categoryCols }"
      >
        <article
          v-for="radio in visibleCategoryRadios"
          :key="`cat-${radioKey(radio)}`"
          class="cover-card"
          @click="openRadio(radio)"
        >
          <div class="cover">
            <img :src="radio.img || songCover" :alt="radio.name" />
            <button class="cover-play" @click.stop="playRadio(radio)">
              <PlayCircleIcon />
            </button>
          </div>
          <div class="card-copy">
            <h4>{{ radio.name }}</h4>
            <p>{{ radioMeta(radio) }}</p>
          </div>
        </article>
      </div>
      <PagerBar
        :page="categoryPage"
        :total-pages="categoryTotalPages"
        :total-items="categoryTotal"
        :total-pending="categoryTotalPending"
        :loading="categoryLoading"
        @change="goCategoryPage"
      />
    </section>

    <section v-if="podcastFavorites.length || podcastFavoritesLoading" class="shelf-section">
      <div class="section-head">
        <div>
          <h3>我的收藏</h3>
          <p>安卓端和桌面端共享的播客收藏</p>
        </div>
      </div>
      <p v-if="podcastFavoritesLoading && !podcastFavorites.length" class="state-text">正在加载播客收藏...</p>
      <div v-else class="radio-grid">
        <article
          v-for="radio in podcastFavorites"
          :key="`favorite-${podcastFavoriteKey(radio)}`"
          class="cover-card"
          @click="openRadio(radio)"
        >
          <div class="cover">
            <img :src="radio.img || songCover" :alt="radio.name" />
            <button
              class="favorite-pin"
              :class="{ active: pinnedPodcastFavoriteKeys.has(podcastFavoriteKey(radio)) }"
              :aria-label="pinnedPodcastFavoriteKeys.has(podcastFavoriteKey(radio)) ? '取消置顶' : '置顶'"
              @click.stop="togglePodcastPin(radio)"
            >
              <PinFilledIcon v-if="pinnedPodcastFavoriteKeys.has(podcastFavoriteKey(radio))" />
              <PinIcon v-else />
            </button>
            <button class="cover-play" @click.stop="playRadio(radio)">
              <PlayCircleIcon />
            </button>
          </div>
          <div class="card-copy">
            <h4>{{ radio.name }}</h4>
            <p>{{ radioMeta(radio) }}</p>
          </div>
        </article>
      </div>
    </section>

    <section class="shelf-section">
      <div class="section-head">
        <div>
          <h3>{{ HOME_SHELF.title }}</h3>
          <p>{{ HOME_SHELF.subtitle }}</p>
        </div>
      </div>
      <p v-if="shelfLoading && !visibleShelfRadios.length" class="state-text">
        正在加载官方推荐...
      </p>
      <div v-else-if="visibleShelfRadios.length" class="radio-grid">
        <article
          v-for="radio in visibleShelfRadios"
          :key="`shelf-${radioKey(radio)}`"
          class="cover-card"
          @click="openRadio(radio)"
        >
          <div class="cover">
            <img :src="radio.img || songCover" :alt="radio.name" />
            <button class="cover-play" @click.stop="playRadio(radio)">
              <PlayCircleIcon />
            </button>
          </div>
          <div class="card-copy">
            <h4>{{ radio.name }}</h4>
            <p>{{ radioMeta(radio) }}</p>
          </div>
        </article>
      </div>
      <p v-else class="state-text">猜你喜欢暂时没有返回内容</p>
    </section>

    <section v-for="block in HOME_BLOCKS" :key="block.title" class="block-section">
      <div class="section-head">
        <div>
          <h3>{{ block.title }}</h3>
          <p>{{ block.subtitle }}</p>
        </div>
        <div class="head-actions">
          <button
            class="ghost-btn"
            :disabled="blockState(block.title).loading"
            @click="shuffleBlock(block)"
          >
            {{ blockState(block.title).loading ? '加载中' : '换一批' }}
          </button>
          <button
            class="more-btn"
            @click="
              openCategoryDirectory({
                category:
                  block.subcategories.find((item) => item.name === blockState(block.title).sub)
                    ?.officialCategoryNames?.[0] ||
                  block.subcategories[0]?.officialCategoryNames?.[0] ||
                  block.title,
                second: blockState(block.title).sub || ''
              })
            "
          >
            全部
          </button>
        </div>
      </div>
      <div class="chip-scroller sub">
        <button
          class="chip ghost"
          :class="{ active: !blockState(block.title).sub }"
          @click="selectBlockSub(block, '')"
        >
          精选
        </button>
        <button
          v-for="item in block.subcategories"
          :key="`${block.title}-${item.name}`"
          class="chip ghost"
          :class="{ active: blockState(block.title).sub === item.name }"
          @click="selectBlockSub(block, item.name)"
        >
          {{ item.name }}
        </button>
      </div>
      <p
        v-if="blockState(block.title).loading && !visibleBlockRadios(block.title).length"
        class="state-text"
      >
        正在加载 {{ blockState(block.title).sub || block.title }}...
      </p>
      <div
        v-else-if="visibleBlockRadios(block.title).length"
        class="radio-grid block-grid"
        :style="{ '--cols': categoryCols }"
      >
        <article
          v-for="radio in visibleBlockRadios(block.title)"
          :key="`${block.title}-${radioKey(radio)}`"
          class="cover-card"
          @click="openRadio(radio)"
        >
          <div class="cover">
            <img :src="radio.img || songCover" :alt="radio.name" />
            <button class="cover-play" @click.stop="playRadio(radio)">
              <PlayCircleIcon />
            </button>
          </div>
          <div class="card-copy">
            <h4>{{ radio.name }}</h4>
            <p>{{ radioMeta(radio) }}</p>
          </div>
        </article>
      </div>
      <p v-else class="state-text">
        {{ blockState(block.title).sub || block.title }} 暂时没有返回内容
      </p>
    </section>

    <div v-if="showLogin" class="login-mask" @click.self="closeLogin">
      <div class="login-card">
        <h3>网易云播客登录</h3>
        <p>只用于播客官方分类和节目，不影响歌曲插件源</p>
        <img v-if="podcastQr" :src="podcastQr" alt="网易云播客登录二维码" />
        <strong>{{ loginMessage }}</strong>
        <div class="login-actions">
          <button class="more-btn" :disabled="podcastBusy" @click="startPodcastQr">
            {{ podcastQr ? '刷新二维码' : '生成二维码' }}
          </button>
          <button class="ghost-btn" @click="closeLogin">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.podcast-page {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 1rem clamp(16px, 2.4vw, 32px) 3rem;
}

.page-head,
.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  margin-bottom: 14px;
}

.title-wrap,
.section-head > div {
  min-width: 0;
}

.head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

h2,
h3,
h4,
p {
  margin: 0;
  min-width: 0;
}

h2 {
  color: var(--find-text-primary);
  font-size: clamp(22px, 2.4vw, 28px);
  font-weight: 800;
}

h3 {
  color: var(--find-text-primary);
  font-size: clamp(18px, 1.8vw, 20px);
  font-weight: 800;
}

p {
  color: var(--find-text-secondary);
  font-size: 12px;
}

.page-head p,
.section-head p {
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-section,
.shelf-section,
.block-section {
  min-width: 0;
  margin-bottom: 28px;
}

.login-chip,
.more-btn,
.ghost-btn,
.chip,
.cover-play {
  border: 0;
  cursor: pointer;
}

.login-chip,
.more-btn,
.ghost-btn {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 7px 12px;
  background: color-mix(in srgb, var(--find-text-primary) 10%, transparent);
  color: var(--find-text-primary);
}

.login-chip.on {
  background: color-mix(in srgb, var(--td-brand-color) 18%, transparent);
}

.chip-scroller {
  display: flex;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  margin-bottom: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.chip-scroller.sub {
  margin-top: -2px;
}

.chip {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 7px 12px;
  background: color-mix(in srgb, var(--find-text-primary) 8%, transparent);
  color: var(--find-text-primary);
  font-size: 13px;
  white-space: nowrap;
}

.chip.ghost {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--find-text-primary) 16%, transparent);
}

.chip.active {
  background: var(--find-text-primary);
  color: var(--td-bg-color-container);
}

.radio-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 156px), 1fr));
  gap: clamp(10px, 1.2vw, 14px);
  min-width: 0;
  width: 100%;
}

.cover-card {
  min-width: 0;
  overflow: hidden;
  border-radius: 16px;
  background: var(--find-card-bg);
  box-shadow: var(--find-card-shadow);
  cursor: pointer;
}

.cover {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  background: color-mix(in srgb, var(--find-text-primary) 6%, transparent);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.cover-play {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.48);
  color: #fff;
}

.favorite-pin {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.48);
  color: rgba(255, 255, 255, 0.86);
}

.favorite-pin.active {
  color: #ffd166;
}

.card-copy {
  min-width: 0;
  height: 58px;
  padding: 8px 10px 10px;
}

.card-copy h4,
.card-copy p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-copy h4 {
  color: var(--find-text-primary);
  font-size: 14px;
  line-height: 1.35;
}

.card-copy p {
  margin-top: 4px;
  color: var(--find-text-secondary);
  font-size: 12px;
}

.radio-grid.block-grid {
  /* 预览一排：数量跟随窗口列数，多余内容交给「换一批」 */
  align-content: start;
  grid-template-columns: repeat(var(--cols, 5), minmax(0, 1fr));
}

.state-text {
  color: var(--find-text-secondary);
  font-size: 13px;
  padding: 10px 0;
}

.pager-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}

.page-btn {
  min-width: 36px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--find-text-primary) 10%, transparent);
  color: var(--find-text-primary);
  cursor: pointer;
}

.page-btn.active {
  background: var(--find-text-primary);
  color: var(--td-bg-color-container);
}

.page-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.radio-grid.category-grid {
  /* 固定视觉三排：超出由分页承担，不在本区无限增高 */
  align-content: start;
  grid-template-columns: repeat(var(--cols, 6), minmax(0, 1fr));
}

.login-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}

.login-card {
  width: min(360px, 100%);
  padding: 20px;
  border-radius: 20px;
  background: var(--td-bg-color-container);
  box-shadow: var(--find-card-shadow);
  text-align: center;

  h3 {
    margin-bottom: 6px;
  }

  img {
    width: 200px;
    height: 200px;
    margin: 16px auto 12px;
    border-radius: 12px;
    background: #fff;
  }

  strong {
    display: block;
    color: var(--find-text-primary);
    font-size: 13px;
  }
}

.login-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}

@media (max-width: 720px) {
  .radio-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 132px), 1fr));
  }
}

@media (min-width: 1280px) {
  .radio-grid {
    grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  }
}
</style>
