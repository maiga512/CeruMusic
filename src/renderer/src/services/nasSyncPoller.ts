import songListAPI from '@renderer/api/songList'
import {
  canUseNasSync,
  getScopedNasSyncLastRevision,
  nasCloudSongListAPI,
  nasFavoriteAPI,
  nasPlaylistAPI,
  nasSyncAPI,
  setScopedNasSyncLastRevision
} from '@renderer/api/nasSync'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'
import { mapCloudSongToLocal, mapSongsToCloud } from '@renderer/utils/playlist/cloudList'
import {
  ensureLocalFavoritesPlaylist,
  markPlaylistCloudSyncOk
} from '@renderer/utils/playlist/cloudLibrarySync'
import type { SongList, Songs } from '@common/types/songList'

const ACTIVE_INTERVAL_MS = 60_000
const BACKGROUND_INTERVAL_MS = 300_000
const ERROR_BACKOFF_MS = 120_000
const LOCAL_CHANGE_DEBOUNCE_MS = 5_000
const NAS_SYNC_SERVICE_NAME = 'NAS 多端同步'

let timer: number | null = null
let localBackupTimer: number | null = null
let running = false
let stopped = true
let applyingRemoteEvents = false
let initialSyncRunning = false
let suppressLocalChangeEventsUntil = 0

type NasSyncEvent = {
  revision?: number
  entityType?: string
  entityId?: string
  action?: string
  payload?: any
  createdAt?: string
  deletedAt?: string | null
}

const clearTimer = () => {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

const clearLocalBackupTimer = () => {
  if (localBackupTimer !== null) {
    window.clearTimeout(localBackupTimer)
    localBackupTimer = null
  }
}

const suppressLocalChangeEvents = () => {
  suppressLocalChangeEventsUntil = Date.now() + LOCAL_CHANGE_DEBOUNCE_MS
}

const getNextInterval = () => {
  const audioStore = ControlAudioStore()
  if (!isAppWindowVisible()) return BACKGROUND_INTERVAL_MS
  if (audioStore.Audio.isPlay) return ACTIVE_INTERVAL_MS
  return ACTIVE_INTERVAL_MS
}

const scheduleNext = (delay = getNextInterval()) => {
  clearTimer()
  if (stopped) return
  timer = window.setTimeout(() => {
    void pollNasSync()
  }, delay)
}

const notifySyncEvents = (events: unknown[], revision: number) => {
  suppressLocalChangeEvents()
  window.dispatchEvent(
    new CustomEvent('ceru-nas-sync-events', {
      detail: { events, revision }
    })
  )
  window.dispatchEvent(new Event('playlist-updated'))
}

const summarizeNasSyncEvent = (event: NasSyncEvent) => {
  const payload = event.payload || {}
  const revisionText = typeof event.revision === 'number' ? `#${event.revision}` : '-'

  if (event.entityType === 'playlist') {
    const playlistName = payload.title || payload.name || event.entityId || '未命名歌单'
    if (event.action === 'delete') {
      return `[同步事件 ${revisionText}] 歌单已删除: ${playlistName}`
    }
    return `[同步事件 ${revisionText}] 歌单已更新: ${playlistName}`
  }

  if (event.entityType === 'playlistSongs') {
    const playlistId = payload.playlistId || event.entityId || '未知歌单'
    if (event.action === 'delete') {
      const removedCount = Array.isArray(payload.songIds) ? payload.songIds.length : 0
      return `[同步事件 ${revisionText}] 歌单歌曲已减少: ${playlistId}，删除 ${removedCount} 首`
    }
    if (event.action === 'upsert') {
      const addedCount = Array.isArray(payload.songs) ? payload.songs.length : 0
      return `[同步事件 ${revisionText}] 歌单歌曲已变更: ${playlistId}，同步 ${addedCount} 首`
    }
  }

  if (event.entityType === 'favorite') {
    if (event.action === 'delete') {
      return `[同步事件 ${revisionText}] 收藏歌单已取消收藏`
    }
    return `[同步事件 ${revisionText}] 收藏歌单已同步`
  }

  return `[同步事件 ${revisionText}] ${event.entityType || 'unknown'}:${event.action || 'unknown'}`
}

const appendNasSyncLogs = async (events: unknown[]) => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return

  const plugin = plugins.find(
    (item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync'
  )
  if (!plugin?.pluginId) return

  for (const rawEvent of events) {
    const event = rawEvent as NasSyncEvent
    const message = summarizeNasSyncEvent(event)
    await window.api.plugins
      .appendPluginLog(plugin.pluginId, 'info', NAS_SYNC_SERVICE_NAME, message)
      .catch(() => {})
  }
}

const appendNasSyncLog = async (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return

  const plugin = plugins.find(
    (item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync'
  )
  if (!plugin?.pluginId) return

  await window.api.plugins
    .appendPluginLog(plugin.pluginId, level, NAS_SYNC_SERVICE_NAME, message)
    .catch(() => {})
}

const getLocalPlaylistByRemoteId = async (remoteId: string, localId?: string) => {
  if (localId) {
    const byLocalId = await songListAPI.getById(localId)
    if (byLocalId.success && byLocalId.data) return byLocalId.data
  }

  const all = await songListAPI.getAll()
  const playlists = all.success && Array.isArray(all.data) ? all.data : []
  return (
    playlists.find((playlist) => playlist.meta?.cloudId === remoteId) ||
    playlists.find((playlist) => playlist.id === localId)
  )
}

const createOrUpdateLocalPlaylist = async (remotePlaylist: any) => {
  const remoteId = String(remotePlaylist.id || remotePlaylist.playlistId || '')
  if (!remoteId) return null

  const localId = remotePlaylist.localId ? String(remotePlaylist.localId) : undefined
  const existing = await getLocalPlaylistByRemoteId(remoteId, localId)
  const name = remotePlaylist.name || remotePlaylist.title || '未命名歌单'
  const description = remotePlaylist.description || remotePlaylist.describe || ''
  const coverImgUrl = remotePlaylist.coverImgUrl || remotePlaylist.coverUrl || remotePlaylist.cover || 'default-cover'
  const source = (remotePlaylist.source || 'local') as SongList['source']
  const semanticType = remotePlaylist.semanticType || remotePlaylist.semantic || remotePlaylist.meta?.semantic
  const meta = {
    ...(existing?.meta || {}),
    cloudId: remoteId,
    localUpdatedAt: remotePlaylist.updatedAt || new Date().toISOString(),
    ...(semanticType ? { semantic: semanticType } : {})
  }

  if (existing) {
    await songListAPI.edit(existing.id, {
      name,
      description,
      coverImgUrl,
      source,
      meta
    })
    return { ...existing, name, description, coverImgUrl, source, meta }
  }

  const created = await songListAPI.create(name, description, source, meta)
  if (!created.success || !created.data?.id) {
    throw new Error(created.error || '创建本地歌单失败')
  }
  if (coverImgUrl && coverImgUrl !== 'default-cover') {
    await songListAPI.updateCover(created.data.id, coverImgUrl).catch(() => null)
  }
  return {
    id: created.data.id,
    name,
    description,
    coverImgUrl,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    source,
    meta
  } as SongList
}

const replaceLocalPlaylistSongs = async (localId: string, remoteSongs: readonly any[]) => {
  const songs = remoteSongs.map((song) => mapCloudSongToLocal(song) as Songs)
  const current = await songListAPI.getSongs(localId)
  const currentIds = current.success && Array.isArray(current.data)
    ? current.data.map((song) => song.songmid)
    : []

  if (currentIds.length > 0) {
    await songListAPI.removeSongs(localId, currentIds)
  }
  if (songs.length > 0) {
    await songListAPI.addSongs(localId, songs)
  }
}

const applyRemoteEvent = async (event: NasSyncEvent) => {
  const payload = event.payload || {}

  if (event.entityType === 'playlist') {
    const remoteId = String(payload.id || event.entityId || '')
    if (!remoteId) return

    const existing = await getLocalPlaylistByRemoteId(remoteId, payload.localId)
    if (event.action === 'delete') {
      if (existing) await songListAPI.delete(existing.id)
      return
    }

    const playlist = await createOrUpdateLocalPlaylist(payload)
    if (!playlist?.id) return
    const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
    const songs = detail?.songs || detail?.list || []
    await replaceLocalPlaylistSongs(playlist.id, songs)
    return
  }

  if (event.entityType === 'playlistSongs') {
    const remoteId = String(payload.playlistId || event.entityId || '')
    if (!remoteId) return
    const existing = await getLocalPlaylistByRemoteId(remoteId)
    if (!existing) return
    const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
    const songs = detail?.songs || detail?.list || payload.songs || []
    await replaceLocalPlaylistSongs(existing.id, songs)
    return
  }

  if (event.entityType === 'favorite' && payload.playlistId) {
    const favoritesId = await ensureLocalFavoritesPlaylist()
    const playlist = await getLocalPlaylistByRemoteId(String(payload.playlistId))
    if (!playlist) return
    const songsRes = await songListAPI.getSongs(playlist.id)
    const songs = songsRes.success && Array.isArray(songsRes.data) ? songsRes.data : []
    if (event.action === 'delete') {
      await songListAPI.removeSongs(favoritesId, songs.map((song) => song.songmid))
    } else if (songs.length > 0) {
      await songListAPI.addSongs(favoritesId, songs as Songs[])
    }
  }
}

const applyRemoteEvents = async (events: unknown[]) => {
  if (!Array.isArray(events) || events.length === 0) return
  applyingRemoteEvents = true
  try {
    for (const rawEvent of events) {
      await applyRemoteEvent(rawEvent as NasSyncEvent)
    }
  } finally {
    applyingRemoteEvents = false
  }
}

const uploadPlaylistSnapshot = async (playlist: SongList) => {
  if (playlist.meta?.isCloudOnly) return null
  const songsRes = await songListAPI.getSongs(playlist.id)
  const songs = songsRes.success && Array.isArray(songsRes.data) ? songsRes.data : []
  const semanticType = playlist.meta?.semantic === 'favorites' ? 'favorites' : playlist.meta?.semantic
  let remoteId = playlist.meta?.cloudId

  if (!remoteId) {
    const remotePlaylists = await nasPlaylistAPI.list().catch(() => [])
    const matched = Array.isArray(remotePlaylists)
      ? remotePlaylists.find(
          (item: any) =>
            item.localId === playlist.id ||
            (semanticType === 'favorites' &&
              (item.semanticType === 'favorites' || item.name === playlist.name))
        )
      : null
    remoteId = matched?.id
  }

  if (remoteId) {
    const result = await nasPlaylistAPI.upsert(remoteId, {
      listId: remoteId,
      localId: playlist.id,
      name: playlist.name,
      describe: playlist.description || '',
      cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
      source: playlist.source,
      semanticType,
      songlist: mapSongsToCloud(songs)
    })
    await markPlaylistCloudSyncOk(playlist, remoteId, result.updatedAt)
    return result
  }

  const result = await nasCloudSongListAPI.createUserSongList({
    localId: playlist.id,
    name: playlist.name,
    describe: playlist.description || '',
    cover: playlist.coverImgUrl && playlist.coverImgUrl !== 'default-cover' ? playlist.coverImgUrl : undefined,
    semanticType,
    songlist: mapSongsToCloud(songs)
  } as any)
  await markPlaylistCloudSyncOk(playlist, result.id, result.updatedAt)
  return result
}

export const runNasSyncNow = async (reason = 'manual') => {
  if (initialSyncRunning || applyingRemoteEvents || running) return null
  if (!(await canUseNasSync())) return null

  initialSyncRunning = true
  try {
    const remoteSnapshot = await nasSyncAPI.sync(await getScopedNasSyncLastRevision())
    if (Array.isArray(remoteSnapshot.events) && remoteSnapshot.events.length > 0) {
      await appendNasSyncLogs(remoteSnapshot.events)
      await applyRemoteEvents(remoteSnapshot.events)
      if (typeof remoteSnapshot.revision === 'number') {
        await setScopedNasSyncLastRevision(remoteSnapshot.revision)
      }
    }

    const localRes = await songListAPI.getAll()
    const playlists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
    let uploaded = 0

    for (const playlist of playlists) {
      await uploadPlaylistSnapshot(playlist)
      uploaded += 1
    }

    const favoritesIdRes = await window.api.songList.getFavoritesId().catch(() => null)
    const favoritesId = favoritesIdRes?.data
    if (favoritesId) {
      const latestPlaylistsRes = await songListAPI.getAll()
      const latestPlaylists =
        latestPlaylistsRes.success && Array.isArray(latestPlaylistsRes.data)
          ? latestPlaylistsRes.data
          : playlists
      const favorites = latestPlaylists.find((playlist) => playlist.id === favoritesId)
      if (favorites?.meta?.cloudId) {
        await nasFavoriteAPI.favoritePlaylist({
          playlistId: favorites.meta.cloudId,
          title: favorites.name,
          description: favorites.description || '',
          coverUrl: favorites.coverImgUrl,
          source: favorites.source
        } as any).catch(() => null)
      }
    }

    const result = await nasSyncAPI.sync(0)
    if (typeof result.revision === 'number') await setScopedNasSyncLastRevision(result.revision)
    await appendNasSyncLog(`[首轮同步] ${reason}，已上传 ${uploaded} 个本地歌单`)
    suppressLocalChangeEvents()
    window.dispatchEvent(new Event('playlist-updated'))
    return { uploaded, revision: result.revision }
  } catch (error) {
    await appendNasSyncLog(`[首轮同步失败] ${error instanceof Error ? error.message : String(error)}`, 'error')
    throw error
  } finally {
    initialSyncRunning = false
  }
}

const pollNasSync = async () => {
  if (stopped || running) return
  running = true
  try {
    if (!(await canUseNasSync())) {
      scheduleNext(BACKGROUND_INTERVAL_MS)
      return
    }

    const sinceRevision = await getScopedNasSyncLastRevision()
    const result = await nasSyncAPI.sync(sinceRevision)
    if (typeof result.revision === 'number') {
      await setScopedNasSyncLastRevision(result.revision)
    }

    if (Array.isArray(result.events) && result.events.length > 0) {
      await appendNasSyncLogs(result.events)
      await applyRemoteEvents(result.events)
      notifySyncEvents(result.events, result.revision)
    }

    scheduleNext()
  } catch (error) {
    console.warn('[nas-sync] poll failed:', error)
    scheduleNext(ERROR_BACKOFF_MS)
  } finally {
    running = false
  }
}

const reschedule = () => {
  if (stopped) return
  scheduleNext()
}

const flushLocalNasSyncBackup = async () => {
  localBackupTimer = null
  if (stopped || initialSyncRunning || applyingRemoteEvents || running) {
    scheduleLocalNasSyncBackup()
    return
  }

  try {
    await runNasSyncNow('local-change')
  } catch (error) {
    console.warn('[nas-sync] local backup failed:', error)
  }
}

const scheduleLocalNasSyncBackup = () => {
  if (stopped) return
  clearLocalBackupTimer()
  localBackupTimer = window.setTimeout(() => {
    void flushLocalNasSyncBackup()
  }, LOCAL_CHANGE_DEBOUNCE_MS)
}

const handleLocalPlaylistChanged = () => {
  if (Date.now() < suppressLocalChangeEventsUntil) return
  if (applyingRemoteEvents || initialSyncRunning) return
  scheduleLocalNasSyncBackup()
}

export const startNasSyncPoller = () => {
  if (!stopped) return
  stopped = false
  window.addEventListener('ceru-window-state-change', reschedule)
  window.addEventListener('playlist-updated', handleLocalPlaylistChanged)
  window.addEventListener('ceru-nas-local-change', handleLocalPlaylistChanged)
  document.addEventListener('visibilitychange', reschedule)
  scheduleNext(5_000)
}

export const stopNasSyncPoller = () => {
  stopped = true
  clearTimer()
  clearLocalBackupTimer()
  window.removeEventListener('ceru-window-state-change', reschedule)
  window.removeEventListener('playlist-updated', handleLocalPlaylistChanged)
  window.removeEventListener('ceru-nas-local-change', handleLocalPlaylistChanged)
  document.removeEventListener('visibilitychange', reschedule)
}
