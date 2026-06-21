import songListAPI from '@renderer/api/songList'
import { MessagePlugin } from 'tdesign-vue-next'
import {
  canUseNasSync,
  getNasSyncMode,
  getScopedNasSyncLastRevision,
  nasCloudSongListAPI,
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
const OFFLINE_BACKOFF_MS = 300_000
const LOCAL_CHANGE_DEBOUNCE_MS = 5_000
const NAS_SYNC_SERVICE_NAME = 'NAS 多端同步'

let timer: number | null = null
let localBackupTimer: number | null = null
let running = false
let stopped = true
let applyingRemoteEvents = false
let initialSyncRunning = false
let suppressLocalChangeEventsUntil = 0
let syncServerOffline = false
let lastOfflineLogAt = 0

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

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'

const markNasSyncOffline = async (error: unknown) => {
  const now = Date.now()
  if (!syncServerOffline || now - lastOfflineLogAt > OFFLINE_BACKOFF_MS) {
    syncServerOffline = true
    lastOfflineLogAt = now
    await appendNasSyncLog(`[同步服务离线] ${getErrorMessage(error)}，已暂停前台提示，稍后后台重试`, 'warn')
  }
}

const markNasSyncOnline = async () => {
  if (!syncServerOffline) return
  syncServerOffline = false
  await appendNasSyncLog('[同步服务恢复] 连接成功，正在同步变更')
  MessagePlugin.success('同步服务已连接，正在同步', 2500)
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

const mergeLocalPlaylistSongs = async (localId: string, remoteSongs: readonly any[]) => {
  const songs = remoteSongs.map((song) => mapCloudSongToLocal(song) as Songs)
  if (songs.length === 0) return

  const current = await songListAPI.getSongs(localId)
  const currentIds = new Set(
    current.success && Array.isArray(current.data)
      ? current.data.map((song) => String(song.songmid))
      : []
  )
  const shouldAdd = songs.filter((song) => !currentIds.has(String(song.songmid)))
  if (shouldAdd.length > 0) {
    await songListAPI.addSongs(localId, shouldAdd)
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

const getLocalPlaylistByName = async (name: string) => {
  const all = await songListAPI.getAll()
  const playlists = all.success && Array.isArray(all.data) ? all.data : []
  return playlists.find((playlist) => playlist.name === name)
}

const restoreRemotePlaylistToLocal = async (remotePlaylist: any) => {
  const remoteId = String(remotePlaylist.id || remotePlaylist.playlistId || '')
  if (!remoteId) return null

  const detail = await nasPlaylistAPI.getSongs(remoteId).catch(() => null)
  const songs = detail?.songs || detail?.list || []
  const localId = remotePlaylist.localId ? String(remotePlaylist.localId) : undefined
  const name = remotePlaylist.name || remotePlaylist.title || '未命名歌单'
  const existing =
    (await getLocalPlaylistByRemoteId(remoteId, localId)) || (await getLocalPlaylistByName(name))

  if (existing) {
    await songListAPI.edit(existing.id, {
      name,
      description: remotePlaylist.description || remotePlaylist.describe || existing.description || '',
      coverImgUrl:
        remotePlaylist.coverImgUrl || remotePlaylist.coverUrl || remotePlaylist.cover || existing.coverImgUrl,
      source: existing.source,
      meta: {
        ...(existing.meta || {}),
        cloudId: remoteId,
        localUpdatedAt: remotePlaylist.updatedAt || new Date().toISOString(),
        ...(remotePlaylist.semanticType ? { semantic: remotePlaylist.semanticType } : {})
      }
    })
    await mergeLocalPlaylistSongs(existing.id, songs)
    return existing.id
  }

  const created = await createOrUpdateLocalPlaylist(remotePlaylist)
  if (created?.id) {
    await mergeLocalPlaylistSongs(created.id, songs)
  }
  return created?.id || null
}

const backupLocalLibraryToCloud = async (reason: string) => {
  const localRes = await songListAPI.getAll()
  const playlists = localRes.success && Array.isArray(localRes.data) ? localRes.data : []
  let uploaded = 0

  for (const playlist of playlists) {
    await uploadPlaylistSnapshot(playlist)
    uploaded += 1
  }

  const result = await nasSyncAPI.sync(0)
  if (typeof result.revision === 'number') await setScopedNasSyncLastRevision(result.revision)
  await appendNasSyncLog(`[备份到云端] ${reason}，已上传 ${uploaded} 个本地歌单`)
  return { uploaded, revision: result.revision }
}

const restoreCloudLibraryToLocal = async (reason: string) => {
  const remotePlaylists = await nasPlaylistAPI.list()
  let restored = 0

  for (const playlist of Array.isArray(remotePlaylists) ? remotePlaylists : []) {
    await restoreRemotePlaylistToLocal(playlist)
    restored += 1
  }

  const result = await nasSyncAPI.sync(0)
  if (typeof result.revision === 'number') await setScopedNasSyncLastRevision(result.revision)
  await appendNasSyncLog(`[从云端恢复] ${reason}，已合并 ${restored} 个云端歌单`)
  suppressLocalChangeEvents()
  window.dispatchEvent(new Event('playlist-updated'))
  return { restored, revision: result.revision }
}

const runAutoSync = async (reason: string) => {
  const sinceRevision = await getScopedNasSyncLastRevision()
  const remoteSnapshot = await nasSyncAPI.sync(sinceRevision)
  if (Array.isArray(remoteSnapshot.events) && remoteSnapshot.events.length > 0) {
    await appendNasSyncLogs(remoteSnapshot.events)
    await applyRemoteEvents(remoteSnapshot.events)
  }
  if (typeof remoteSnapshot.revision === 'number') {
    await setScopedNasSyncLastRevision(remoteSnapshot.revision)
  }
  await appendNasSyncLog(`[自动同步] ${reason}，已同步服务器事件`)
  return { revision: remoteSnapshot.revision }
}

export const runNasSyncNow = async (reason = 'manual') => {
  if (initialSyncRunning || applyingRemoteEvents || running) return null
  if (!(await canUseNasSync())) return null

  initialSyncRunning = true
  try {
    const mode = await getNasSyncMode()
    if (mode === 'backup-to-cloud') return await backupLocalLibraryToCloud(reason)
    if (mode === 'restore-from-cloud') return await restoreCloudLibraryToLocal(reason)
    const result = await runAutoSync(reason)
    await markNasSyncOnline()
    return result
  } catch (error) {
    await appendNasSyncLog(`[首轮同步失败] ${error instanceof Error ? error.message : String(error)}`, 'error')
    await markNasSyncOffline(error)
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

    const mode = await getNasSyncMode()
    if (mode !== 'auto') {
      scheduleNext()
      return
    }

    const sinceRevision = await getScopedNasSyncLastRevision()
    const result = await nasSyncAPI.sync(sinceRevision)
    await markNasSyncOnline()
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
    await markNasSyncOffline(error)
    scheduleNext(syncServerOffline ? OFFLINE_BACKOFF_MS : ERROR_BACKOFF_MS)
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
    const mode = await getNasSyncMode()
    if (mode === 'restore-from-cloud') return
    await runNasSyncNow('local-change')
  } catch (error) {
    console.warn('[nas-sync] local backup failed:', error)
    await markNasSyncOffline(error)
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
