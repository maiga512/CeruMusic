import { useSettingsStore } from '@renderer/store/Settings'
import type {
  CloudSongDto,
  CloudSongList,
  CreateUserSongListDto,
  UpdateUserSongListDto
} from '@renderer/api/cloudSongList'
import type {
  CeruFavoriteMutationResult,
  CeruFavoriteSyncPage,
  CeruPodcastFavorite,
  CeruPodcastFavoriteMutationInput,
  CeruPlaylistFavorite,
  CeruPlaylistFavoriteMutationInput
} from '@ceru/shared-contract'

export type NasSyncSession = {
  accessToken: string
  expiresAt: number
  user: {
    id: string
    username: string
    nickname?: string
    email?: string
  }
}

type RequestOptions = {
  method?: string
  token?: string
  body?: unknown
}

type NasSyncConfig = {
  enabled?: boolean
  syncMode?: NasSyncMode
  serverUrl?: string
  host?: string
  port?: number
  useHttps?: boolean
  accessToken?: string
  status?: 'connected' | 'disconnected'
  [key: string]: unknown
}

export type NasSyncMode = 'backup-to-cloud' | 'restore-from-cloud' | 'auto'

let cachedNasPluginId = ''

export type NasSyncServerParts = {
  host: string
  port: number
  useHttps: boolean
  path: string
}

export type NasPlaylistSongOperationResult = {
  operationId: string
  applied: boolean
  changed: boolean
  stale: boolean
  action: 'add' | 'remove'
  trackKey: string
  removedCount: number
  revision: number
  updatedAt: string
}

export const parseNasSyncServerUrl = (serverUrl?: string): NasSyncServerParts | null => {
  const raw = String(serverUrl || '').trim()
  if (!raw) return null
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      useHttps: url.protocol === 'https:',
      path: url.pathname.replace(/\/+$/, '')
    }
  } catch {
    return null
  }
}

export const buildNasSyncServerUrl = (config: NasSyncConfig = {}): string => {
  const rawHost = String(config.host || '').trim()
  if (rawHost) {
    if (/^https?:\/\//i.test(rawHost)) {
      const parsed = parseNasSyncServerUrl(rawHost)
      if (!parsed) return ''
      return `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
    }

    const [authority, ...pathParts] = rawHost.split('/')
    if (!authority) return ''
    const scheme = config.useHttps === true ? 'https' : 'http'
    const port = Number(config.port) > 0 ? Number(config.port) : 31231
    const path = pathParts.length > 0 ? `/${pathParts.join('/').replace(/\/+$/, '')}` : ''
    return `${scheme}://${authority}:${port}${path}`
  }

  // 兼容旧版完整 serverUrl 配置。
  const parsed = parseNasSyncServerUrl(config.serverUrl)
  if (!parsed) return ''
  return `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
}

const findNasSyncPluginId = async () => {
  if (cachedNasPluginId) return cachedNasPluginId
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return ''

  const plugin = plugins.find((item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync')
  if (plugin?.pluginId) {
    cachedNasPluginId = plugin.pluginId
    return cachedNasPluginId
  }
  return ''
}

const getPluginNasConfig = async (): Promise<NasSyncConfig | null> => {
  const pluginId = await findNasSyncPluginId()
  if (!pluginId) return null
  const result = await window.api.plugins.getConfig(pluginId).catch(() => null)
  return result?.data || null
}

const getLegacyNasConfig = (): NasSyncConfig => {
  const settings = useSettingsStore().settings
  return {
    enabled: settings.nasSyncEnabled,
    serverUrl: settings.nasSyncServerUrl,
    accessToken: settings.nasSyncToken,
    status: settings.nasSyncStatus
  }
}

const getNasConfig = async () => {
  const pluginConfig = await getPluginNasConfig()
  return pluginConfig || getLegacyNasConfig()
}

export const getNasSyncMode = async (): Promise<NasSyncMode> => {
  const config = await getNasConfig()
  const mode = String(config.syncMode || 'auto')
  if (mode === 'backup-to-cloud' || mode === 'restore-from-cloud' || mode === 'auto') {
    return mode
  }
  return 'auto'
}

export const getNasSyncScope = async () => {
  const config = await getNasConfig()
  const serverUrl = buildNasSyncServerUrl(config)
  const userKey = String(config.userId || config.username || 'default')
  return `${serverUrl || 'local'}::${userKey}`
}

export const canUseNasSync = async () => {
  const config = await getNasConfig()
  return Boolean(config.enabled && buildNasSyncServerUrl(config) && config.accessToken)
}

export const getNasSyncLastRevision = () => {
  const raw = localStorage.getItem('ceru_nas_sync_last_revision') || '0'
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

export const getScopedNasSyncLastRevision = async () => {
  const scope = await getNasSyncScope()
  const scopedRaw = localStorage.getItem(`ceru_nas_sync_last_revision:${scope}`)
  const fallbackRaw = localStorage.getItem('ceru_nas_sync_last_revision')
  const value = Number(scopedRaw || fallbackRaw || '0')
  return Number.isFinite(value) ? value : 0
}

export const setNasSyncLastRevision = (revision: number) => {
  if (!Number.isFinite(revision)) return
  localStorage.setItem('ceru_nas_sync_last_revision', String(Math.max(0, Math.floor(revision))))
}

export const setScopedNasSyncLastRevision = async (revision: number) => {
  if (!Number.isFinite(revision)) return
  const normalized = String(Math.max(0, Math.floor(revision)))
  const scope = await getNasSyncScope()
  localStorage.setItem(`ceru_nas_sync_last_revision:${scope}`, normalized)
  localStorage.setItem('ceru_nas_sync_last_revision', normalized)
}

const unwrapNasResponse = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || `NAS 同步服务请求失败：${response.status}`)
  }
  if (body?.success === true && 'data' in body) {
    return body.data as T
  }
  return body as T
}

const normalizeNasBaseUrl = (value?: string) => String(value || '').trim().replace(/\/+$/, '')

const nasBaseUrlCandidates = (config: NasSyncConfig) => {
  const urls: string[] = []
  const push = (value?: string) => {
    const raw = normalizeNasBaseUrl(value)
    if (!raw) return
    const parsed = parseNasSyncServerUrl(raw)
    if (!parsed) return
    const url = `${parsed.useHttps ? 'https' : 'http'}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${parsed.path}`
    if (!urls.includes(url)) urls.push(url)
  }
  push(config.serverUrl)
  push(buildNasSyncServerUrl(config))
  urls.sort((left, right) => {
    const score = (url: string) => (/192\.168\.|10\.|127\.0\.0\.1|172\.(1[6-9]|2\d|3[0-1])\./.test(url) ? 1 : 0)
    return score(right) - score(left)
  })
  return urls
}

const requestNas = async <T>(endpoint: string, options: RequestOptions = {}) => {
  const config = await getNasConfig()
  const baseUrls = nasBaseUrlCandidates(config)
  if (!baseUrls.length) throw new Error('请先填写 NAS 同步服务器地址')

  let lastError: unknown = null
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.token || config.accessToken
            ? { Authorization: `Bearer ${options.token || config.accessToken}` }
            : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      })
      return await unwrapNasResponse<T>(response)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'NAS 同步服务请求失败'))
}

const normalizePlaylistFavoritePage = (payload: unknown): CeruFavoriteSyncPage<CeruPlaylistFavorite> => {
  const data = payload as
    | CeruPlaylistFavorite[]
    | {
        items?: CeruPlaylistFavorite[]
        revision?: number
        updatedAt?: string
      }
  const items = Array.isArray(data) ? data : data.items || []
  return {
    items: items.filter((item) => item.playlistId),
    revision: Array.isArray(data) ? undefined : data.revision,
    updatedAt: Array.isArray(data) ? undefined : data.updatedAt
  }
}

const coverToString = (cover: string | File | undefined) => (typeof cover === 'string' ? cover : undefined)

const PODCAST_FAVORITES_STORAGE_KEY = 'ceru_podcast_favorites'
const PODCAST_FAVORITE_PINS_STORAGE_KEY = 'ceru_podcast_favorite_pins'
const PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY = 'ceru_podcast_favorite_mutations'

type PendingPodcastFavoriteMutation =
  | { operation: 'upsert'; key: string; input: CeruPodcastFavoriteMutationInput }
  | { operation: 'delete'; key: string; source?: string; radioId: string }

const readPendingPodcastFavoriteMutations = (): PendingPodcastFavoriteMutation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.key && item?.operation) : []
  } catch {
    return []
  }
}

const writePendingPodcastFavoriteMutations = (items: PendingPodcastFavoriteMutation[]) => {
  localStorage.setItem(PODCAST_FAVORITE_MUTATIONS_STORAGE_KEY, JSON.stringify(items))
}

const enqueuePodcastFavoriteMutation = (mutation: PendingPodcastFavoriteMutation) => {
  const pending = readPendingPodcastFavoriteMutations().filter((item) => item.key !== mutation.key)
  writePendingPodcastFavoriteMutations([...pending, mutation])
}

const removePodcastFavoriteMutation = (key: string) => {
  writePendingPodcastFavoriteMutations(readPendingPodcastFavoriteMutations().filter((item) => item.key !== key))
}

const readLocalPodcastFavorites = (): CeruPodcastFavorite[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITES_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.radioId && item?.title) : []
  } catch {
    return []
  }
}

const writeLocalPodcastFavorites = (items: CeruPodcastFavorite[]) => {
  localStorage.setItem(PODCAST_FAVORITES_STORAGE_KEY, JSON.stringify(items))
  window.dispatchEvent(new Event('ceru-podcast-favorites-updated'))
  window.dispatchEvent(new Event('ceru-nas-local-change'))
}

const podcastFavoriteKey = (source: string | undefined, radioId: string) => `${source || 'wy'}:${radioId}`

const readPodcastFavoritePins = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PODCAST_FAVORITE_PINS_STORAGE_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim()).filter((item, index, items) => item && items.indexOf(item) === index)
      : []
  } catch {
    return []
  }
}

const writePodcastFavoritePins = (items: string[]) => {
  const keys = items.map((item) => String(item || '').trim()).filter((item, index, all) => item && all.indexOf(item) === index)
  localStorage.setItem(PODCAST_FAVORITE_PINS_STORAGE_KEY, JSON.stringify(keys))
}

const orderPodcastFavorites = (
  items: CeruPodcastFavorite[],
  pinKeys = readPodcastFavoritePins()
): CeruPodcastFavorite[] => {
  const pinIndex = new Map(pinKeys.map((key, index) => [key, index]))
  return [...items]
    .map((item, index) => ({
      item: {
        ...item,
        pinned: pinIndex.has(podcastFavoriteKey(item.source, item.radioId))
      },
      index
    }))
    .sort((left, right) => {
      if (left.item.pinned !== right.item.pinned) return left.item.pinned ? -1 : 1
      const leftPinIndex = pinIndex.get(podcastFavoriteKey(left.item.source, left.item.radioId))
      const rightPinIndex = pinIndex.get(podcastFavoriteKey(right.item.source, right.item.radioId))
      if (left.item.pinned && leftPinIndex != null && rightPinIndex != null) {
        return leftPinIndex - rightPinIndex
      }
      return left.index - right.index
    })
    .map(({ item }, index) => ({ ...item, position: index }))
}

const podcastFavoriteToMutation = (
  favorite: CeruPodcastFavorite,
  position: number,
  pinned: boolean
): CeruPodcastFavoriteMutationInput => ({
  radioId: favorite.radioId,
  source: favorite.source,
  title: favorite.title,
  description: favorite.description,
  coverUrl: favorite.coverUrl,
  author: favorite.author,
  total: favorite.total,
  playCount: favorite.playCount,
  position,
  pinned
})

const normalizePodcastFavorite = (payload: any): CeruPodcastFavorite | null => {
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  const radioId = String(payload?.radioId || metadata.radioId || '').trim()
  const title = String(payload?.title || payload?.name || '').trim()
  if (!radioId || !title) return null
  return {
    id: String(payload?.id || podcastFavoriteKey(payload?.source, radioId)),
    radioId,
    source: payload?.source,
    title,
    description: payload?.description || payload?.describe || undefined,
    coverUrl: payload?.coverUrl || payload?.cover || undefined,
    author: payload?.author || metadata.author || undefined,
    total: Number(payload?.total ?? metadata.total) || undefined,
    playCount: String((payload?.playCount ?? metadata.playCount) || '') || undefined,
    pinned: Boolean(payload?.pinned ?? metadata.pinned),
    position: Number.isFinite(Number(payload?.position ?? metadata.position))
      ? Number(payload?.position ?? metadata.position)
      : undefined,
    createdAt: payload?.createdAt,
    updatedAt: payload?.updatedAt,
    deletedAt: payload?.deletedAt ?? null,
    revision: payload?.revision
  }
}

const normalizePodcastFavoritePage = (payload: unknown): CeruFavoriteSyncPage<CeruPodcastFavorite> => {
  const data = payload as { items?: unknown[]; revision?: number; updatedAt?: string } | unknown[]
  const rawItems = Array.isArray(data) ? data : data.items || []
  return {
    items: rawItems.map(normalizePodcastFavorite).filter((item): item is CeruPodcastFavorite => Boolean(item)),
    revision: Array.isArray(data) ? undefined : data.revision,
    updatedAt: Array.isArray(data) ? undefined : data.updatedAt
  }
}



export type NasSyncedPlugin = {
  identityKey: string
  kind: 'music-source' | 'capability'
  name: string
  author: string
  version: string
  enabled: boolean
  disabledSources: string[]
  contentHash?: string
  role?: string
  config?: Record<string, unknown>
  revision: number
  deletedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type NasPluginOperationResult = {
  operationId: string
  applied: boolean
  changed: boolean
  stale: boolean
  action: 'upsert' | 'remove'
  identityKey: string
  plugin?: NasSyncedPlugin
  revision: number
  updatedAt: string
}

export const nasSyncAPI = {
  health: () => requestNas<{ status: string; service: string }>('/health', { token: '' }),
  me: () => requestNas<NasSyncSession['user']>('/me'),
  pair: (pairCode: string) => requestNas<NasSyncSession>('/auth/pair', { method: 'POST', token: '', body: { pairCode } }),
  sync: (sinceRevision: number) => requestNas<{ revision: number; events: unknown[] }>(`/sync?sinceRevision=${sinceRevision}`),
  waitForSync: (sinceRevision: number, timeoutMs = 20_000) =>
    requestNas<{ revision: number; events: unknown[] }>(
      `/sync/wait?sinceRevision=${sinceRevision}&timeout=${Math.max(0, Math.floor(timeoutMs))}`
    ),
  applyPlaylistSongOperation: (input: {
    operationId: string
    deviceId: string
    sequence: number
    occurredAtMs: number
    playlistId: string
    action: 'add' | 'remove'
    trackKey: string
    song?: CloudSongDto
  }) =>
    requestNas<NasPlaylistSongOperationResult>('/playlist-song-ops', {
      method: 'POST',
      body: input
    }),
  listPlugins: async (options: { includeDeleted?: boolean } = {}) => {
    const query = options.includeDeleted ? '?includeDeleted=true' : ''
    const payload = await requestNas<{ items?: NasSyncedPlugin[] } | NasSyncedPlugin[]>(`/plugins${query}`)
    return Array.isArray(payload) ? payload : payload.items || []
  },
  putPluginBlob: (script: string) =>
    requestNas<{ contentHash: string; byteSize: number }>('/plugin-blobs', {
      method: 'POST',
      body: { script }
    }),
  getPluginBlob: (contentHash: string) =>
    requestNas<{ contentHash: string; script: string; byteSize: number }>(
      `/plugin-blobs/${encodeURIComponent(contentHash)}`
    ),
  applyPluginOperation: (input: {
    operationId: string
    deviceId: string
    sequence: number
    occurredAtMs: number
    identityKey?: string
    action: 'upsert' | 'remove'
    kind: 'music-source' | 'capability'
    name?: string
    author?: string
    version?: string
    enabled?: boolean
    disabledSources?: string[]
    contentHash?: string
    role?: string
    config?: Record<string, unknown>
  }) =>
    requestNas<NasPluginOperationResult>('/plugin-ops', {
      method: 'POST',
      body: input
    })
}

export const nasCloudSongListAPI = {
  getUserSongLists: () => requestNas<CloudSongList[]>('/user-songlist'),
  getSongListDetail: (id: string, sort: 'asc' | 'desc' = 'asc', limit?: number, pos?: number) => {
    const params = new URLSearchParams({ id, sort })
    if (typeof limit === 'number') params.set('limit', String(limit))
    if (typeof pos === 'number') params.set('pos', String(pos))
    return requestNas<{ list: CloudSongDto[]; total: number }>(`/user-songlist/list?${params.toString()}`)
  },
  createUserSongList: (data: CreateUserSongListDto) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>('/user-songlist', {
      method: 'POST',
      body: {
        localId: data.localId,
        name: data.name,
        describe: data.describe || '',
        cover: coverToString(data.cover),
        source: 'local',
        semanticType: (data as any).semanticType,
        songlist: data.songlist
      }
    }),
  updateUserSongList: (data: UpdateUserSongListDto) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>('/user-songlist', {
      method: 'PATCH',
      body: {
        listId: data.listId,
        localId: data.localId,
        name: data.name,
        describe: data.describe,
        cover: coverToString(data.cover),
        source: (data as any).source,
        semanticType: (data as any).semanticType,
        orderOnly: (data as any).orderOnly,
        songlist: data.songlist
      }
    }),
  deleteUserSongList: (id: string) =>
    requestNas('/user-songlist', {
      method: 'DELETE',
      body: { listId: id }
    }),
  addSongsToList: (id: string, songs: CloudSongDto[]) =>
    requestNas<{ updatedAt: string; revision?: number }>('/user-songlist/list', {
      method: 'PATCH',
      body: { id, songs }
    }),
  removeSongsFromList: (id: string, songmids: string[]) =>
    requestNas<{ updatedAt: string; revision?: number }>('/user-songlist/list', {
      method: 'DELETE',
      body: { id, songmids }
    })
}

export const nasPlaylistAPI = {
  list: () => requestNas<CloudSongList[]>('/playlists'),
  getSongs: (playlistId: string) =>
    requestNas<{ playlist?: any; list?: CloudSongDto[]; songs?: CloudSongDto[]; total?: number }>(
      `/playlists/${encodeURIComponent(playlistId)}/songs`
    ),
  upsert: (playlistId: string, data: UpdateUserSongListDto & { source?: string; semanticType?: string }) =>
    requestNas<{ id: string; updatedAt: string; revision?: number }>(
      `/playlists/${encodeURIComponent(playlistId)}`,
      {
        method: 'PATCH',
        body: {
          localId: data.localId,
          name: data.name,
          describe: data.describe,
          cover: coverToString(data.cover),
          source: data.source,
          semanticType: data.semanticType,
          songlist: data.songlist
        }
      }
    )
}

export const nasPodcastFavoriteAPI = {
  list: async () => normalizePodcastFavoritePage(await requestNas<unknown>('/favorites?entityType=podcast')),
  favorite: (input: CeruPodcastFavoriteMutationInput) =>
    requestNas<CeruFavoriteMutationResult>('/favorites', {
      method: 'POST',
      body: {
        entityType: 'podcast',
        entityId: podcastFavoriteKey(input.source, input.radioId),
        title: input.title,
        description: input.description,
        coverUrl: input.coverUrl,
        source: input.source,
        position: input.position,
        pinned: input.pinned,
        metadata: {
          radioId: input.radioId,
          author: input.author,
          total: input.total,
          playCount: input.playCount,
          position: input.position,
          pinned: Boolean(input.pinned)
        }
      }
    }),
  unfavorite: (source: string | undefined, radioId: string) =>
    requestNas<CeruFavoriteMutationResult>(
      `/favorites/podcast/${encodeURIComponent(podcastFavoriteKey(source, radioId))}`,
      { method: 'DELETE' }
    )
}

export const flushPendingPodcastFavoriteMutations = async () => {
  if (!(await canUseNasSync())) return
  for (const mutation of readPendingPodcastFavoriteMutations()) {
    if (mutation.operation === 'upsert') {
      await nasPodcastFavoriteAPI.favorite(mutation.input)
    } else {
      await nasPodcastFavoriteAPI.unfavorite(mutation.source, mutation.radioId)
    }
    removePodcastFavoriteMutation(mutation.key)
  }
}

export const backupLocalPodcastFavoritesToCloud = async () => {
  if (!(await canUseNasSync())) return {uploaded: 0}
  const ordered = orderPodcastFavorites(readLocalPodcastFavorites(), readPodcastFavoritePins())

  for (const [index, favorite] of ordered.entries()) {
    const key = podcastFavoriteKey(favorite.source, favorite.radioId)
    const input = podcastFavoriteToMutation(favorite, index, Boolean(favorite.pinned))
    enqueuePodcastFavoriteMutation({operation: 'upsert', key, input})
    await nasPodcastFavoriteAPI.favorite(input)
    removePodcastFavoriteMutation(key)
  }

  return {uploaded: ordered.length}
}

export const listPodcastFavorites = async (): Promise<CeruPodcastFavorite[]> => {
  const localItems = readLocalPodcastFavorites()
  const localPins = readPodcastFavoritePins()
  if (!(await canUseNasSync())) return orderPodcastFavorites(localItems, localPins)

  try {
    const pendingMutations = readPendingPodcastFavoriteMutations()
    const pendingDeleteKeys = new Set(
      pendingMutations.filter((mutation) => mutation.operation === 'delete').map((mutation) => mutation.key)
    )
    const remoteItems = (await nasPodcastFavoriteAPI.list()).items.filter(
      (item) => !pendingDeleteKeys.has(podcastFavoriteKey(item.source, item.radioId))
    )
    const pendingUpsertKeys = new Set(
      pendingMutations.filter((mutation) => mutation.operation === 'upsert').map((mutation) => mutation.key)
    )
    const pendingPinnedByKey = new Map(
      pendingMutations
        .filter((mutation) => mutation.operation === 'upsert')
        .map((mutation) => [mutation.key, Boolean(mutation.input.pinned)])
    )
    const remoteByKey = new Map(remoteItems.map((item) => [podcastFavoriteKey(item.source, item.radioId), item]))
    const pendingItems = localItems.filter((item) =>
      pendingUpsertKeys.has(podcastFavoriteKey(item.source, item.radioId))
    )
    const items = [
      ...pendingItems,
      ...remoteItems,
      ...localItems.filter((item) => {
        const key = podcastFavoriteKey(item.source, item.radioId)
        return !remoteByKey.has(key) && !pendingUpsertKeys.has(key)
      })
    ].filter((item, index, all) => {
      const key = podcastFavoriteKey(item.source, item.radioId)
      return all.findIndex((candidate) => podcastFavoriteKey(candidate.source, candidate.radioId) === key) === index
    })
    const remotePinnedKeys = remoteItems
      .filter((item) => item.pinned)
      .map((item) => podcastFavoriteKey(item.source, item.radioId))
    const mergedPins = [
      ...localPins.filter((key) => pendingPinnedByKey.get(key) === true),
      ...remotePinnedKeys.filter((key) => !pendingUpsertKeys.has(key)),
      ...localPins.filter((key) => {
        const item = localItems.find(
          (favorite) => podcastFavoriteKey(favorite.source, favorite.radioId) === key
        )
        return Boolean(item && !remoteByKey.has(key) && !pendingUpsertKeys.has(key))
      })
    ].filter((key, index, all) => key && all.indexOf(key) === index)
    const ordered = orderPodcastFavorites(items, mergedPins)
    writePodcastFavoritePins(mergedPins)
    localStorage.setItem(PODCAST_FAVORITES_STORAGE_KEY, JSON.stringify(ordered))
    return ordered
  } catch {
    return orderPodcastFavorites(localItems, localPins)
  }
}

export const replaceLocalPodcastFavoritesFromCloud = async (): Promise<CeruPodcastFavorite[]> => {
  if (!(await canUseNasSync())) return readLocalPodcastFavorites()

  const remoteItems = (await nasPodcastFavoriteAPI.list()).items
  const ordered = [...remoteItems].sort((left, right) => {
    const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    if (pinnedDelta !== 0) return pinnedDelta
    const leftPosition = typeof left.position === 'number' ? left.position : Number.MAX_SAFE_INTEGER
    const rightPosition = typeof right.position === 'number' ? right.position : Number.MAX_SAFE_INTEGER
    if (leftPosition !== rightPosition) return leftPosition - rightPosition
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  })
  const pins = ordered
    .filter((item) => item.pinned)
    .map((item) => podcastFavoriteKey(item.source, item.radioId))
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(ordered)
  return ordered
}

export const setPodcastFavoriteFromSyncEvent = (payload: unknown, deleted = false) => {
  const favorite = normalizePodcastFavorite(payload)
  if (!favorite) return
  const key = podcastFavoriteKey(favorite.source, favorite.radioId)
  const pins = readPodcastFavoritePins().filter((item) => item !== key)
  if (!deleted && favorite.pinned) {
    pins.unshift(key)
  }
  writePodcastFavoritePins(pins)
  const existing = readLocalPodcastFavorites().filter(
    (item) => podcastFavoriteKey(item.source, item.radioId) !== key
  )
  const items = deleted
    ? existing
    : [...existing, favorite].sort((left, right) => {
        const leftPosition = typeof left.position === 'number' && Number.isFinite(left.position)
          ? left.position
          : Number.MAX_SAFE_INTEGER
        const rightPosition = typeof right.position === 'number' && Number.isFinite(right.position)
          ? right.position
          : Number.MAX_SAFE_INTEGER
        if (leftPosition !== rightPosition) return leftPosition - rightPosition
        return 0
      })
  writeLocalPodcastFavorites(orderPodcastFavorites(items, pins))
}

export const favoritePodcast = async (input: CeruPodcastFavoriteMutationInput) => {
  const pins = readPodcastFavoritePins()
  const currentItems = readLocalPodcastFavorites()
  const favorite: CeruPodcastFavorite = {
    id: podcastFavoriteKey(input.source, input.radioId),
    ...input,
    pinned: false,
    position: 0,
    updatedAt: new Date().toISOString()
  }
  const key = podcastFavoriteKey(input.source, input.radioId)
  const existing = currentItems.filter(
    (item) => podcastFavoriteKey(item.source, item.radioId) !== key
  )
  const firstUnpinned = existing.findIndex(
    (item) => !pins.includes(podcastFavoriteKey(item.source, item.radioId))
  )
  const insertAt = firstUnpinned >= 0 ? firstUnpinned : existing.length
  const nextItems = orderPodcastFavorites(
    [
      ...existing.slice(0, insertAt),
      favorite,
      ...existing.slice(insertAt)
    ],
    pins
  )
  const mutationInput = podcastFavoriteToMutation(
    nextItems.find((item) => podcastFavoriteKey(item.source, item.radioId) === key) || favorite,
    nextItems.findIndex((item) => podcastFavoriteKey(item.source, item.radioId) === key),
    false
  )
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(nextItems)
  enqueuePodcastFavoriteMutation({ operation: 'upsert', key, input: mutationInput })

  if (!(await canUseNasSync())) return { favorite, syncError: null }
  try {
    await nasPodcastFavoriteAPI.favorite(mutationInput)
    removePodcastFavoriteMutation(key)
    return { favorite, syncError: null }
  } catch (error) {
    return { favorite, syncError: error instanceof Error ? error : new Error('收藏同步失败') }
  }
}

export const unfavoritePodcast = async (source: string | undefined, radioId: string) => {
  const key = podcastFavoriteKey(source, radioId)
  const pins = readPodcastFavoritePins().filter((item) => item !== key)
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(
    orderPodcastFavorites(
      readLocalPodcastFavorites().filter(
        (item) => podcastFavoriteKey(item.source, item.radioId) !== key
      ),
      pins
    )
  )
  enqueuePodcastFavoriteMutation({ operation: 'delete', key, source, radioId })

  if (!(await canUseNasSync())) return { syncError: null }
  try {
    await nasPodcastFavoriteAPI.unfavorite(source, radioId)
    removePodcastFavoriteMutation(key)
    return { syncError: null }
  } catch (error) {
    return { syncError: error instanceof Error ? error : new Error('取消收藏同步失败') }
  }
}

export const togglePodcastFavoritePinned = async (source: string | undefined, radioId: string) => {
  const key = podcastFavoriteKey(source, radioId)
  const items = await listPodcastFavorites()
  const favorite = items.find((item) => podcastFavoriteKey(item.source, item.radioId) === key)
  if (!favorite) return { items, syncError: new Error('未找到播客收藏') }

  const wasPinned = readPodcastFavoritePins().includes(key) || Boolean(favorite.pinned)
  const pins = wasPinned
    ? readPodcastFavoritePins().filter((item) => item !== key)
    : [key, ...readPodcastFavoritePins().filter((item) => item !== key)]
  const remaining = items.filter((item) => podcastFavoriteKey(item.source, item.radioId) !== key)
  let nextItems: CeruPodcastFavorite[]
  if (wasPinned) {
    const firstUnpinned = remaining.findIndex(
      (item) => !pins.includes(podcastFavoriteKey(item.source, item.radioId))
    )
    const insertAt = firstUnpinned >= 0 ? firstUnpinned : remaining.length
    nextItems = [...remaining.slice(0, insertAt), favorite, ...remaining.slice(insertAt)]
  } else {
    nextItems = [favorite, ...remaining]
  }

  const ordered = orderPodcastFavorites(nextItems, pins)
  writePodcastFavoritePins(pins)
  writeLocalPodcastFavorites(ordered)

  let syncError: Error | null = null
  const uploadItems = ordered.map((item, index) => {
    const itemKey = podcastFavoriteKey(item.source, item.radioId)
    const input = podcastFavoriteToMutation(item, index, pins.includes(itemKey))
    enqueuePodcastFavoriteMutation({ operation: 'upsert', key: itemKey, input })
    return { itemKey, input }
  })

  if (await canUseNasSync()) {
    try {
      for (const { itemKey, input } of uploadItems) {
        await nasPodcastFavoriteAPI.favorite(input)
        removePodcastFavoriteMutation(itemKey)
      }
    } catch (error) {
      syncError = error instanceof Error ? error : new Error('播客置顶同步失败')
    }
  }

  return { items: ordered, syncError }
}

export const nasFavoriteAPI = {
  listPodcastFavorites: async () => ({ items: await listPodcastFavorites() }),
  listPlaylistFavorites: async () => normalizePlaylistFavoritePage(await requestNas<unknown>('/playlist-favorites')),
  favoritePlaylist: (input: CeruPlaylistFavoriteMutationInput) =>
    requestNas<CeruFavoriteMutationResult>('/playlist-favorites', { method: 'POST', body: input }),
  unfavoritePlaylist: (playlistId: string) =>
    requestNas<CeruFavoriteMutationResult>('/playlist-favorites', {
      method: 'DELETE',
      body: { playlistId }
    })
}

export const getPreferredSongListAPI = async () => (await canUseNasSync() ? nasCloudSongListAPI : null)
export const getPreferredFavoriteAPI = async () => (await canUseNasSync() ? nasFavoriteAPI : null)
export const getAutoSyncSongListAPI = async () =>
  (await canUseNasSync()) && (await getNasSyncMode()) === 'auto' ? nasCloudSongListAPI : null
export const getAutoSyncFavoriteAPI = async () =>
  (await canUseNasSync()) && (await getNasSyncMode()) === 'auto' ? nasFavoriteAPI : null
