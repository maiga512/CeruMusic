import { useAuthStore } from '@renderer/store'
import songListAPI from '@renderer/api/songList'
import {
  cloudSongListAPI,
  type CloudSongDto,
  type CloudSongList
} from '@renderer/api/cloudSongList'
import {
  canUseNasSync,
  nasCloudSongListAPI,
  nasSyncAPI,
  type NasPlaylistSongOperationResult
} from '@renderer/api/nasSync'
import { mapCloudSongToLocal, mapSongsToCloud } from '@renderer/utils/playlist/cloudList'
import { isBridgedPlaylist } from '@renderer/utils/playlist/bridgedPlaylist'
import { getPersistentMeta } from '@renderer/utils/playlist/meta'
import type { SongList, Songs } from '@common/types/songList'

export const FAVORITES_PLAYLIST_NAME = '我的喜欢'
const SONG_OPERATION_QUEUE_KEY = 'ceru_nas_playlist_song_operations'
const SONG_OPERATION_SEQUENCE_KEY = 'ceru_nas_playlist_song_operation_sequence'
const SONG_OPERATION_DEVICE_KEY = 'ceru_nas_playlist_song_operation_device'

type PendingPlaylistSongOperation = {
  operationId: string
  deviceId: string
  sequence: number
  playlistId: string
  action: 'add' | 'remove'
  trackKey: string
  song?: CloudSongDto
  createdAt: string
}

let flushSongOperationsPromise: Promise<void> | null = null

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'

const canUseCloudLibrary = async () => {
  if (await canUseNasSync()) return true
  try {
    return !!useAuthStore().isAuthenticated
  } catch {
    return false
  }
}

const getSongListSyncAPI = async () => (await canUseNasSync() ? nasCloudSongListAPI : cloudSongListAPI)

const isFavoritesSongList = (playlist: SongList) =>
  playlist.meta?.semantic === 'favorites' || playlist.name === FAVORITES_PLAYLIST_NAME

const canonicalSongSource = (song: { source?: string }) => {
  const raw = String(song.source || '').trim().toLowerCase()
  if (raw === 'wy' || raw.includes('网易') || raw.includes('netease')) return 'wy'
  if (raw === 'tx' || raw.includes('qq')) return 'tx'
  if (raw === 'kw' || raw.includes('酷我')) return 'kw'
  if (raw === 'kg' || raw.includes('酷狗')) return 'kg'
  if (raw === 'mg' || raw.includes('咪咕')) return 'mg'
  return raw || 'wy'
}

const songTrackKey = (song: {
  songmid?: string | number
  id?: string | number
  hash?: string | number
  source?: string
}) => {
  const source = canonicalSongSource(song)
  const id = String(song.songmid || song.id || song.hash || '').trim()
  return id ? `${source}:${id}` : ''
}

const readDeviceId = () => {
  const existing = localStorage.getItem(SONG_OPERATION_DEVICE_KEY)?.trim()
  if (existing) return existing
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`
  localStorage.setItem(SONG_OPERATION_DEVICE_KEY, generated)
  return generated
}

const nextSongOperationSequence = () => {
  const current = Number(localStorage.getItem(SONG_OPERATION_SEQUENCE_KEY) || '0')
  const next = Number.isSafeInteger(current) && current > 0 ? current + 1 : 1
  localStorage.setItem(SONG_OPERATION_SEQUENCE_KEY, String(next))
  return next
}

const readPendingPlaylistSongOperations = (): PendingPlaylistSongOperation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SONG_OPERATION_QUEUE_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            item?.operationId &&
            item?.deviceId &&
            item?.playlistId &&
            (item?.action === 'add' || item?.action === 'remove') &&
            item?.trackKey
        )
      : []
  } catch {
    return []
  }
}

const writePendingPlaylistSongOperations = (items: PendingPlaylistSongOperation[]) => {
  localStorage.setItem(SONG_OPERATION_QUEUE_KEY, JSON.stringify(items))
}

const enqueuePendingPlaylistSongOperation = (operation: PendingPlaylistSongOperation) => {
  writePendingPlaylistSongOperations([...readPendingPlaylistSongOperations(), operation])
}

const removePendingPlaylistSongOperations = (operationIds: Set<string>) => {
  if (operationIds.size === 0) return
  writePendingPlaylistSongOperations(
    readPendingPlaylistSongOperations().filter((item) => !operationIds.has(item.operationId))
  )
}

export const flushPendingFavoriteSongOperations = async () => {
  if (flushSongOperationsPromise) return flushSongOperationsPromise
  flushSongOperationsPromise = (async () => {
    if (!(await canUseNasSync())) return
    while (true) {
      const pending = readPendingPlaylistSongOperations()
      if (pending.length === 0) break
      let acknowledged = false
      let failed = false
      for (const operation of pending) {
        let result: NasPlaylistSongOperationResult
        try {
          result = await nasSyncAPI.applyPlaylistSongOperation(operation)
        } catch (error) {
          console.warn('[nas-sync] 收藏操作待重试:', error)
          failed = true
          break
        }
        if (result.operationId === operation.operationId) {
          removePendingPlaylistSongOperations(new Set([operation.operationId]))
          acknowledged = true
        }
      }
      if (failed || !acknowledged) break
    }
  })().finally(() => {
    flushSongOperationsPromise = null
  })
  return flushSongOperationsPromise
}

const enqueueFavoriteSongOperations = async (
  playlist: SongList,
  action: 'add' | 'remove',
  songs: readonly CloudSongDto[],
  trackKeys?: readonly string[]
) => {
  const cloudId = await ensureCloudPlaylistForLocal(playlist)
  if (!cloudId) return null
  const deviceId = readDeviceId()
  const now = new Date().toISOString()

  for (const [index, song] of songs.entries()) {
    const trackKey = trackKeys?.[index] || songTrackKey(song)
    if (!trackKey) continue
    enqueuePendingPlaylistSongOperation({
      operationId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `song-op-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      deviceId,
      sequence: nextSongOperationSequence(),
      playlistId: cloudId,
      action,
      trackKey,
      song: action === 'add' ? song : undefined,
      createdAt: now
    })
  }

  await flushPendingFavoriteSongOperations()
  return { id: cloudId, updatedAt: new Date().toISOString() }
}

const compactMeta = (meta: Record<string, any>) => {
  const next = { ...meta }
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined || next[key] === '') delete next[key]
  })
  return next
}

const persistPlaylistMeta = async (localId: string, meta: Record<string, any>) => {
  const persistentMeta = compactMeta(getPersistentMeta(meta))
  const res = await songListAPI.edit(localId, { meta: persistentMeta })
  if (!res.success) {
    throw new Error(res.error || '保存歌单同步状态失败')
  }
  return persistentMeta
}

const findCloudMatch = (cloudLists: CloudSongList[], playlist: SongList) => {
  return cloudLists.find(
    (item) =>
      item.localId === playlist.id ||
      item.id === playlist.meta?.cloudId ||
      (playlist.name === FAVORITES_PLAYLIST_NAME && item.name === FAVORITES_PLAYLIST_NAME)
  )
}

const hasCloudPlaylist = (cloudLists: CloudSongList[], cloudId?: string) => {
  if (!cloudId) return false
  return cloudLists.some((item) => item.id === cloudId)
}

const createCloudPlaylist = async (playlist: SongList, songs: readonly Songs[] = []) => {
  const syncAPI = await getSongListSyncAPI()
  const res = await syncAPI.createUserSongList({
    localId: playlist.id,
    name: playlist.name,
    describe: playlist.description || '',
    cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
    songlist: mapSongsToCloud(songs, true)
  })

  return {
    id: res.id,
    updatedAt: res.updatedAt
  }
}

export const markPlaylistCloudSyncFailed = async (
  playlist: Pick<SongList, 'id' | 'meta'>,
  operation: string,
  error: unknown
) => {
  try {
    await persistPlaylistMeta(playlist.id, {
      ...(playlist.meta || {}),
      cloudSyncPending: true,
      cloudSyncOperation: operation,
      cloudSyncError: getErrorMessage(error),
      cloudSyncFailedAt: new Date().toISOString()
    })
  } catch (metaError) {
    console.error('保存云同步失败状态失败:', metaError)
  }
}

export const markPlaylistCloudSyncOk = async (
  playlist: Pick<SongList, 'id' | 'meta'>,
  cloudId: string,
  updatedAt?: string
) => {
  return persistPlaylistMeta(playlist.id, {
    ...(playlist.meta || {}),
    cloudId,
    cloudSyncPending: false,
    cloudSyncOperation: undefined,
    cloudSyncError: undefined,
    cloudSyncFailedAt: undefined,
    localUpdatedAt: updatedAt || new Date().toISOString()
  })
}

export const ensureLocalFavoritesPlaylist = async () => {
  const favApi = (window as any).api?.songList
  const favIdRes = await favApi?.getFavoritesId?.()
  let favoritesId: string | null = (favIdRes && favIdRes.data) || null

  if (favoritesId) {
    const existsRes = await songListAPI.exists(favoritesId)
    if (!existsRes.success || !existsRes.data) favoritesId = null
  }

  if (!favoritesId) {
    const searchRes = await songListAPI.search(FAVORITES_PLAYLIST_NAME, 'local')
    if (searchRes.success && Array.isArray(searchRes.data)) {
      const exact = searchRes.data.find(
        (playlist) => playlist.name === FAVORITES_PLAYLIST_NAME && playlist.source === 'local'
      )
      favoritesId = exact?.id || null
    }
  }

  if (!favoritesId) {
    const createRes = await songListAPI.create(FAVORITES_PLAYLIST_NAME, '', 'local', {
      semantic: 'favorites'
    })
    if (!createRes.success || !createRes.data?.id) {
      throw new Error(createRes.error || '创建“我的喜欢”失败')
    }
    favoritesId = createRes.data.id
  }

  await favApi?.setFavoritesId?.(favoritesId)
  return favoritesId
}

export const ensureCloudPlaylistForLocal = async (playlist: SongList) => {
  if (!(await canUseCloudLibrary())) return null
  if (isBridgedPlaylist(playlist)) return null
  if (playlist.meta?.isCloudOnly) return playlist.meta?.cloudId || playlist.id

  try {
    const syncAPI = await getSongListSyncAPI()
    const [cloudLists, songsRes] = await Promise.all([
      syncAPI.getUserSongLists(),
      songListAPI.getSongs(playlist.id)
    ])
    const songs = songsRes.success ? [...(songsRes.data || [])] : []
    const safeCloudLists = Array.isArray(cloudLists) ? cloudLists : []
    const currentCloudId = playlist.meta?.cloudId ? String(playlist.meta.cloudId) : ''

    if (hasCloudPlaylist(safeCloudLists, currentCloudId)) {
      const existing = safeCloudLists.find((item) => item.id === currentCloudId)
      await markPlaylistCloudSyncOk(playlist, currentCloudId, existing?.updatedAt)
      return currentCloudId
    }

    const match = findCloudMatch(safeCloudLists, playlist)

    if (match) {
      await markPlaylistCloudSyncOk(playlist, match.id, match.updatedAt)
      return match.id
    }

    const created = await createCloudPlaylist(playlist, songs)
    await markPlaylistCloudSyncOk(playlist, created.id, created.updatedAt)
    return created.id
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'bind', error)
    throw error
  }
}

export const ensureFavoritesCloudBinding = async () => {
  const localId = await ensureLocalFavoritesPlaylist()
  const playlistRes = await songListAPI.getById(localId)
  const playlist = playlistRes.data || ({
    id: localId,
    name: FAVORITES_PLAYLIST_NAME,
    description: '',
    coverImgUrl: 'default-cover',
    createTime: '',
    updateTime: '',
    source: 'local',
    meta: { semantic: 'favorites' }
  } as SongList)

  const cloudId = await ensureCloudPlaylistForLocal({
    ...playlist,
    name: FAVORITES_PLAYLIST_NAME,
    meta: {
      ...(playlist.meta || {}),
      semantic: 'favorites'
    }
  })

  return { localId, cloudId, playlist }
}

export const syncAddSongsToCloud = async (playlist: SongList, songs: readonly Songs[]) => {
  if (!(await canUseCloudLibrary())) return null
  const cloudSongs = mapSongsToCloud(songs) as CloudSongDto[]
  if (cloudSongs.length === 0) return null

  try {
    if (await canUseNasSync() && isFavoritesSongList(playlist)) {
      return await enqueueFavoriteSongOperations(playlist, 'add', cloudSongs)
    }
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.addSongsToList(cloudId, cloudSongs)
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'addSongs', error)
    throw error
  }
}

export const syncRemoveSongsFromCloud = async (
  playlist: SongList,
  songmids: readonly (string | number)[]
) => {
  if (!(await canUseCloudLibrary())) return null
  if (songmids.length === 0) return null

  try {
    if (await canUseNasSync() && isFavoritesSongList(playlist)) {
      const localSongsRes = await songListAPI.getSongs(playlist.id)
      const localSongs = localSongsRes.success && Array.isArray(localSongsRes.data) ? localSongsRes.data : []
      const requestedIds = new Set(songmids.map((id) => String(id)))
      const matchedSongs = localSongs.filter((song) => requestedIds.has(String(song.songmid)))
      const trackKeys = songmids.map((songmid) => {
        const matched = matchedSongs.find((song) => String(song.songmid) === String(songmid))
        return matched ? songTrackKey(matched) : ''
      })
      if (trackKeys.every((key) => !key)) {
        await flushPendingFavoriteSongOperations()
        return null
      }
      return await enqueueFavoriteSongOperations(
        playlist,
        'remove',
        songmids.map((songmid) => ({ songmid: String(songmid) }) as CloudSongDto),
        trackKeys
      )
    }
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.removeSongsFromList(
      cloudId,
      songmids.map((id) => String(id))
    )
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'removeSongs', error)
    throw error
  }
}

export const syncPlaylistSongsSnapshotToCloud = async (
  playlist: SongList,
  songs: readonly Songs[]
) => {
  if (!(await canUseCloudLibrary())) return null
  if (isBridgedPlaylist(playlist, songs)) return null

  try {
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.updateUserSongList({
      listId: cloudId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover:
        playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover'
          ? playlist.coverImgUrl
          : undefined,
      songlist: mapSongsToCloud(songs, true)
    })
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'replaceSongs', error)
    throw error
  }
}

export const syncPlaylistInfoToCloud = async (playlist: SongList) => {
  if (!(await canUseCloudLibrary())) return null

  try {
    const cloudId = await ensureCloudPlaylistForLocal(playlist)
    if (!cloudId) return null
    const syncAPI = await getSongListSyncAPI()
    const res = await syncAPI.updateUserSongList({
      listId: cloudId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover:
        playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover'
          ? playlist.coverImgUrl
          : undefined
    })
    await markPlaylistCloudSyncOk(playlist, cloudId, res.updatedAt)
    return res
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'updateInfo', error)
    throw error
  }
}

export const syncDeletePlaylistFromCloud = async (playlist: SongList) => {
  if (!(await canUseCloudLibrary())) return null
  if (isBridgedPlaylist(playlist)) return null
  const cloudId = playlist.meta?.cloudId || (playlist.meta?.isCloudOnly ? playlist.id : '')
  if (!cloudId) return null
  const syncAPI = await getSongListSyncAPI()
  return syncAPI.deleteUserSongList(cloudId)
}

export const pullFavoritesFromCloud = async () => {
  if (!(await canUseCloudLibrary())) return null

  const { localId, cloudId, playlist } = await ensureFavoritesCloudBinding()
  if (!cloudId) return null

  try {
    const syncAPI = await getSongListSyncAPI()
    const detail = await syncAPI.getSongListDetail(cloudId)
    const cloudSongs = Array.isArray(detail.list) ? detail.list : []
    const cloudSongmids = new Set(cloudSongs.map((song) => String(song.songmid)))
    const localSongsRes = await songListAPI.getSongs(localId)
    const localSongs = localSongsRes.success ? [...(localSongsRes.data || [])] : []
    const localSongmids = new Set(localSongs.map((song) => String(song.songmid)))
    const shouldRemove = localSongs
      .filter((song) => !cloudSongmids.has(String(song.songmid)))
      .map((song) => song.songmid)
    const shouldAdd = cloudSongs
      .filter((song) => !localSongmids.has(String(song.songmid)))
      .map((song) => mapCloudSongToLocal(song) as Songs)

    if (shouldRemove.length > 0) await songListAPI.removeSongs(localId, shouldRemove)
    if (shouldAdd.length > 0) await songListAPI.addSongs(localId, shouldAdd)

    await markPlaylistCloudSyncOk(playlist, cloudId, new Date().toISOString())
    window.dispatchEvent(new Event('playlist-updated'))

    return {
      localId,
      cloudId,
      added: shouldAdd.length,
      removed: shouldRemove.length,
      total: cloudSongs.length
    }
  } catch (error) {
    await markPlaylistCloudSyncFailed(playlist, 'pullFavorites', error)
    throw error
  }
}
