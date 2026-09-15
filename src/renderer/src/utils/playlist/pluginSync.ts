import { nasSyncAPI, type NasSyncedPlugin } from '@renderer/api/nasSync'
import {
  capabilityIdentityKey,
  canonicalizeCapabilityConfig,
  musicSourceIdentityKey,
  pluginFingerprint
} from '@renderer/utils/playlist/pluginIdentity'

const DISABLED_MUSIC_SOURCES_KEY = 'ceru_sync_disabled_music_sources'
const PLUGIN_SYNC_INITIALIZED_KEY = 'ceru_sync_plugins_initialized'
const DEVICE_ID_KEY = 'ceru_sync_device_id'
const SEQUENCE_KEY = 'ceru_sync_plugin_sequence'
const MAX_PLUGIN_SCRIPT_BYTES = 2 * 1024 * 1024
const PENDING_PLUGIN_UPSERTS_KEY = 'ceru_sync_pending_plugin_upserts'

export type LocalSyncedPlugin = {
  identityKey: string
  kind: 'music-source' | 'capability'
  name: string
  author: string
  version: string
  enabled: boolean
  disabledSources: string[]
  contentHash?: string
  script?: string
  role?: string
  config?: Record<string, unknown>
  localPluginId?: string
}

let applyingRemotePlugins = false
let lastAppliedFingerprint = ''

const createId = () =>
  `plgop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

const getDeviceId = () => {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const created = `desktop_${crypto.randomUUID?.() || createId()}`
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

const nextSequence = () => {
  const current = Number(localStorage.getItem(SEQUENCE_KEY) || '0')
  const next = Number.isFinite(current) ? current + 1 : 1
  localStorage.setItem(SEQUENCE_KEY, String(next))
  return next
}

const parsePluginTimestampMs = (value?: string | null) => {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const readDisabledMusicSources = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISABLED_MUSIC_SOURCES_KEY) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.map((item) => String(item)) : [])
  } catch {
    return new Set<string>()
  }
}

const writeDisabledMusicSources = (values: Set<string>) => {
  localStorage.setItem(DISABLED_MUSIC_SOURCES_KEY, JSON.stringify([...values]))
}

export const isApplyingRemotePlugins = () => applyingRemotePlugins

export const isPluginSyncInitialized = (scope: string) =>
  localStorage.getItem(`${PLUGIN_SYNC_INITIALIZED_KEY}:${scope}`) === '1'

export const markPluginSyncInitialized = (scope: string) => {
  localStorage.setItem(`${PLUGIN_SYNC_INITIALIZED_KEY}:${scope}`, '1')
}

const loadPluginList = async () => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  return Array.isArray(plugins) ? plugins : []
}

const notifyPluginsUpdated = () => {
  window.dispatchEvent(new Event('plugin-updated'))
}

const logPluginSync = async (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
  const plugins = await window.api.plugins.loadAllPlugins().catch(() => [])
  if (!Array.isArray(plugins)) return
  const plugin = plugins.find(
    (item: any) => item?.pluginType === 'service' && item?.serviceRole === 'nas-sync'
  )
  if (!plugin?.pluginId) return
  await window.api.plugins
    .appendPluginLog(plugin.pluginId, level, '多端同步', message)
    .catch(() => null)
}

const readPluginScript = async (pluginId: string, pluginName = '') => {
  try {
    const result = await window.api.plugins.getPluginCode(pluginId)
    if (result && 'code' in result && result.code) return String(result.code)
    const error = result && 'error' in result ? result.error : '无法读取插件源码'
    throw new Error(error)
  } catch (error: any) {
    await logPluginSync(
      `读取插件源码失败: ${pluginName || pluginId} ${error?.message || error}`,
      'warn'
    )
    return ''
  }
}

const sha256Hex = async (script: string) => {
  const bytes = new TextEncoder().encode(script)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export const collectLocalPlugins = async (): Promise<LocalSyncedPlugin[]> => {
  const plugins = await loadPluginList()
  const disabled = readDisabledMusicSources()
  const items: LocalSyncedPlugin[] = []

  for (const plugin of plugins) {
    const pluginType = plugin.pluginType || 'music-source'
    const serviceRole = String(plugin.serviceRole || '')
    if (pluginType === 'service' && serviceRole) {
      const configResult = await window.api.plugins.getConfig(plugin.pluginId).catch(() => null)
      const config = (configResult?.data || {}) as Record<string, unknown>
      const role = serviceRole === 'feiniu' || serviceRole === 'navidrome' || serviceRole === 'nas-sync'
        ? serviceRole
        : ''
      if (!role) continue
      items.push({
        identityKey: capabilityIdentityKey(role),
        kind: 'capability',
        name: plugin.pluginInfo?.name || role,
        author: plugin.pluginInfo?.author || '',
        version: plugin.pluginInfo?.version || '',
        enabled: true,
        disabledSources: [],
        role,
        config: canonicalizeCapabilityConfig(role, config),
        localPluginId: plugin.pluginId
      })
      continue
    }

    if (pluginType !== 'music-source') continue
    const name = plugin.pluginInfo?.name || plugin.pluginName || ''
    const author = plugin.pluginInfo?.author || ''
    if (!name) continue
    const identityKey = musicSourceIdentityKey(name, author)
    const script = await readPluginScript(plugin.pluginId, name)
    if (!script) {
      await logPluginSync(`跳过上传音源插件（源码为空）: ${name}`, 'warn')
      continue
    }
    if (new TextEncoder().encode(script).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
      await logPluginSync(`跳过上传音源插件（超过2MB）: ${name}`, 'warn')
      continue
    }
    items.push({
      identityKey,
      kind: 'music-source',
      name,
      author,
      version: plugin.pluginInfo?.version || '',
      enabled: !disabled.has(identityKey),
      disabledSources: [],
      script,
      contentHash: await sha256Hex(script),
      localPluginId: plugin.pluginId
    })
  }

  return items
}

const uploadLocalPlugin = async (
  item: LocalSyncedPlugin,
  occurredAtMs = Date.now(),
  prune = false
) => {
  if (item.kind === 'music-source') {
    if (!item.script) return null
    const uploaded = await nasSyncAPI.putPluginBlob(item.script)
    return nasSyncAPI.applyPluginOperation({
      operationId: createId(),
      deviceId: getDeviceId(),
      sequence: nextSequence(),
      occurredAtMs,
      identityKey: item.identityKey,
      action: 'upsert',
      kind: 'music-source',
      name: item.name,
      author: item.author,
      version: item.version,
      enabled: item.enabled,
      disabledSources: item.disabledSources,
      contentHash: uploaded.contentHash
    })
  }
  return nasSyncAPI.applyPluginOperation({
    operationId: createId(),
    deviceId: getDeviceId(),
    sequence: nextSequence(),
    occurredAtMs,
    identityKey: item.identityKey,
    action: prune && !item.config ? 'remove' : 'upsert',
    kind: 'capability',
    name: item.name,
    author: item.author,
    version: item.version,
    enabled: true,
    role: item.role,
    config: item.config
  })
}

const KNOWN_PLUGIN_KEYS = 'ceru_sync_known_plugin_keys'

const readKnownPluginKeys = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_PLUGIN_KEYS) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.map((item) => String(item)) : [])
  } catch {
    return new Set<string>()
  }
}

const writeKnownPluginKeys = (keys: Set<string>) => {
  localStorage.setItem(KNOWN_PLUGIN_KEYS, JSON.stringify([...keys]))
}

export const backupLocalPluginsToCloud = async (pruneCloudExtras = false) => {
  if (applyingRemotePlugins) return {uploaded: 0, removed: 0}
  let localItems = await collectLocalPlugins()
  const remoteItems = await nasSyncAPI.listPlugins({includeDeleted: true})
  const activeRemoteItems = remoteItems.filter((item) => !item.deletedAt)
  const remoteByKey = new Map(remoteItems.map((item) => [item.identityKey, item]))
  const activeRemoteByKey = new Map(activeRemoteItems.map((item) => [item.identityKey, item]))
  const knownKeys = readKnownPluginKeys()
  const pendingUpserts = readPendingPluginUpserts()
  let removed = 0

  // 云端墓碑优先于本机旧快照：曾经同步过的插件从云端消失后，不能再次上传。
  for (const local of [...localItems]) {
    if (local.kind !== 'music-source') continue
    const remote = remoteByKey.get(local.identityKey)
    const pendingAt = pendingUpserts.get(local.identityKey)
    const deletedAt = parsePluginTimestampMs(remote?.deletedAt || remote?.updatedAt)
    if (pendingAt != null && deletedAt > 0 && pendingAt > deletedAt) continue
    const remotelyDeleted = Boolean(remote?.deletedAt) || (!remote && knownKeys.has(local.identityKey))
    if (!remotelyDeleted) continue
    if (local.localPluginId) {
      await window.api.plugins.uninstallPlugin(local.localPluginId).catch(() => null)
      notifyPluginsUpdated()
    }
    clearLocalPluginUpsert(local.identityKey)
    localItems = localItems.filter((item) => item.identityKey !== local.identityKey)
    removed += 1
  }

  const localKeys = new Set(localItems.map((item) => item.identityKey))
  let uploaded = 0
  for (const item of localItems) {
    const remote = activeRemoteByKey.get(item.identityKey)
    const pendingAt = pendingUpserts.get(item.identityKey)
    const pendingUpsert = pendingAt != null
    const fingerprint = pluginFingerprint({
      ...item,
      contentHash: item.kind === 'music-source' ? await sha256Hex(item.script || '') : undefined
    })
    const remoteFingerprint = remote ? pluginFingerprint(remote) : ''
    if (!pendingUpsert && fingerprint === remoteFingerprint) continue
    if (!pendingUpsert && !remote && knownKeys.has(item.identityKey)) continue
    await uploadLocalPlugin(item, pendingAt ?? Date.now())
    clearLocalPluginUpsert(item.identityKey)
    uploaded += 1
  }
  for (const remote of activeRemoteItems) {
    if (localKeys.has(remote.identityKey)) continue
    if (remote.kind !== 'music-source') continue
    const shouldRemove = pruneCloudExtras || knownKeys.has(remote.identityKey)
    if (!shouldRemove) continue
    await nasSyncAPI.applyPluginOperation({
      operationId: createId(),
      deviceId: getDeviceId(),
      sequence: nextSequence(),
      occurredAtMs: Date.now(),
      identityKey: remote.identityKey,
      action: 'remove',
      kind: remote.kind,
      role: remote.role
    })
    removed += 1
  }
  const latestLocal = await collectLocalPlugins()
  const latestKeys = new Set(latestLocal.map((item) => item.identityKey))
  writeKnownPluginKeys(latestKeys)
  writePendingPluginUpserts(
    new Map([...readPendingPluginUpserts()].filter(([key]) => latestKeys.has(key)))
  )
  return {uploaded, removed}
}

const APPLIED_PLUGIN_HASHES_KEY = 'ceru_sync_applied_plugin_hashes'

const readPendingPluginUpserts = (): Map<string, number> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_PLUGIN_UPSERTS_KEY) || '{}')
    const pending = new Map<string, number>()
    if (Array.isArray(parsed)) {
      // 旧版本只保存了插件键，没有时间；按 0 处理，确保后来的云端删除优先。
      for (const value of parsed) {
        const key = String(value || '').trim()
        if (key) pending.set(key, 0)
      }
      return pending
    }
    if (parsed && typeof parsed === 'object') {
      for (const [rawKey, rawTime] of Object.entries(parsed)) {
        const key = String(rawKey || '').trim()
        const time = Number(rawTime)
        if (key) pending.set(key, Number.isFinite(time) && time > 0 ? time : 0)
      }
    }
    return pending
  } catch {
    return new Map<string, number>()
  }
}

const writePendingPluginUpserts = (pending: Map<string, number>) => {
  localStorage.setItem(PENDING_PLUGIN_UPSERTS_KEY, JSON.stringify(Object.fromEntries(pending)))
}

export const markLocalPluginUpsert = (identityKey: string, occurredAtMs = Date.now()) => {
  const key = String(identityKey || '').trim()
  if (!key) return
  const pending = readPendingPluginUpserts()
  pending.set(key, Number.isFinite(occurredAtMs) && occurredAtMs > 0 ? occurredAtMs : Date.now())
  writePendingPluginUpserts(pending)
}

export const clearLocalPluginUpsert = (identityKey: string) => {
  const key = String(identityKey || '').trim()
  if (!key) return
  const pending = readPendingPluginUpserts()
  if (!pending.delete(key)) return
  writePendingPluginUpserts(pending)
}

const readAppliedPluginHashes = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPLIED_PLUGIN_HASHES_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const rememberAppliedPluginHash = (identityKey: string, contentHash?: string) => {
  if (!identityKey || !contentHash) return
  const current = readAppliedPluginHashes()
  current[identityKey] = contentHash
  localStorage.setItem(APPLIED_PLUGIN_HASHES_KEY, JSON.stringify(current))
}

const forgetAppliedPluginHash = (identityKey: string) => {
  const current = readAppliedPluginHashes()
  if (!current[identityKey]) return
  delete current[identityKey]
  localStorage.setItem(APPLIED_PLUGIN_HASHES_KEY, JSON.stringify(current))
}

const applyMusicSourceFlags = (remote: NasSyncedPlugin) => {
  const disabled = readDisabledMusicSources()
  if (remote.enabled === false) disabled.add(remote.identityKey)
  else disabled.delete(remote.identityKey)
  writeDisabledMusicSources(disabled)
}

const applyMusicSourcePlugin = async (remote: NasSyncedPlugin, localItems: LocalSyncedPlugin[]) => {
  if (remote.deletedAt) {
    const existing = localItems.find((item) => item.identityKey === remote.identityKey)
    if (existing?.localPluginId) {
      await window.api.plugins.uninstallPlugin(existing.localPluginId).catch(() => null)
      notifyPluginsUpdated()
    }
    const disabled = readDisabledMusicSources()
    disabled.delete(remote.identityKey)
    writeDisabledMusicSources(disabled)
    forgetAppliedPluginHash(remote.identityKey)
    clearLocalPluginUpsert(remote.identityKey)
    return
  }

  const existing = localItems.find((item) => item.identityKey === remote.identityKey)
  const localContentHash = existing?.contentHash || (existing?.script ? await sha256Hex(existing.script) : '')
  const localFingerprint = existing
    ? pluginFingerprint({
        ...existing,
        contentHash: localContentHash
      })
    : ''
  const remoteFingerprint = pluginFingerprint(remote)
  const appliedHash = readAppliedPluginHashes()[remote.identityKey] || ''
  const sameScript = Boolean(
    remote.contentHash &&
      (localContentHash === remote.contentHash || appliedHash === remote.contentHash)
  )
  if (existing && (localFingerprint === remoteFingerprint || sameScript)) {
    applyMusicSourceFlags(remote)
    rememberAppliedPluginHash(remote.identityKey, remote.contentHash)
    clearLocalPluginUpsert(remote.identityKey)
    return
  }

  let script = ''
  if (remote.contentHash) {
    const blob = await nasSyncAPI.getPluginBlob(remote.contentHash)
    script = blob.script || ''
  }
  if (!script || new TextEncoder().encode(script).byteLength > MAX_PLUGIN_SCRIPT_BYTES) {
    await logPluginSync(`跳过应用音源插件（源码无效）: ${remote.name || remote.identityKey}`, 'warn')
    return
  }
  const result = await window.api.plugins.addPlugin(
    script,
    `${remote.name || 'plugin'}.js`,
    existing?.localPluginId,
    {
      name: remote.name,
      version: remote.version,
      author: remote.author,
      forceReplace: true
    }
  )
  if (result && typeof result === 'object' && 'error' in result) {
    await logPluginSync(
      `应用音源插件失败: ${remote.name || remote.identityKey} ${result.error}`,
      'error'
    )
    return
  }
  applyMusicSourceFlags(remote)
  rememberAppliedPluginHash(remote.identityKey, remote.contentHash)
  clearLocalPluginUpsert(remote.identityKey)
  notifyPluginsUpdated()
}

const applyCapabilityPlugin = async (remote: NasSyncedPlugin, localItems: LocalSyncedPlugin[]) => {
  const role = String(remote.role || remote.identityKey.replace(/^capability:/, ''))
  if (role !== 'feiniu' && role !== 'navidrome' && role !== 'nas-sync') return
  const existing = localItems.find((item) => item.identityKey === remote.identityKey)
  if (!existing?.localPluginId) return
  if (!remote.deletedAt && pluginFingerprint(existing) === pluginFingerprint(remote)) return
  const current = await window.api.plugins.getConfig(existing.localPluginId).catch(() => null)
  const currentConfig = (current?.data || {}) as Record<string, unknown>
  if (remote.deletedAt) {
    if (role === 'feiniu' || role === 'navidrome') {
      const next = {...currentConfig}
      delete next.host
      delete next.port
      delete next.username
      delete next.password
      delete next.accessCode
      delete next.serverUrl
      await window.api.plugins.saveConfig(existing.localPluginId, next)
    }
    return
  }
  const canonical = canonicalizeCapabilityConfig(role, {
    ...currentConfig,
    ...(remote.config || {})
  })
  if (role === 'nas-sync' && (currentConfig.accessToken || currentConfig.serverUrl)) {
    const next = {...currentConfig}
    if (canonical.pairCode) next.pairCode = canonical.pairCode
    await window.api.plugins.saveConfig(existing.localPluginId, next)
    return
  }
  const merged = {
    ...currentConfig,
    ...canonical
  }
  await window.api.plugins.saveConfig(existing.localPluginId, merged)
  if (role === 'feiniu') {
    await window.api.plugins.testConnection(existing.localPluginId).catch(() => null)
  }
}

export const applyRemotePluginEvent = async (payload: NasSyncedPlugin, deleted = false) => {
  if (payload.kind === 'music-source') {
    const pendingAt = readPendingPluginUpserts().get(payload.identityKey)
    if (pendingAt != null) {
      const deletedAt = parsePluginTimestampMs(payload.deletedAt || payload.updatedAt)
      if (!deleted || (deletedAt > 0 && pendingAt > deletedAt)) return
    }
  }
  applyingRemotePlugins = true
  try {
    const localItems = await collectLocalPlugins()
    const remote = {...payload, deletedAt: deleted ? payload.deletedAt || new Date().toISOString() : payload.deletedAt}
    lastAppliedFingerprint = pluginFingerprint(remote)
    if (remote.kind === 'music-source') await applyMusicSourcePlugin(remote, localItems)
    else await applyCapabilityPlugin(remote, localItems)
  } finally {
    applyingRemotePlugins = false
  }
}

export const restorePluginsFromCloud = async (fullMirror = false) => {
  applyingRemotePlugins = true
  try {
    const remoteItems = await nasSyncAPI.listPlugins()
    const localItems = await collectLocalPlugins()
    for (const remote of remoteItems) {
      lastAppliedFingerprint = pluginFingerprint(remote)
      if (remote.kind === 'music-source') await applyMusicSourcePlugin(remote, localItems)
      else await applyCapabilityPlugin(remote, localItems)
    }
    if (fullMirror) {
      const remoteKeys = new Set(remoteItems.map((item) => item.identityKey))
      for (const local of localItems) {
        if (remoteKeys.has(local.identityKey) || local.kind !== 'music-source' || !local.localPluginId) continue
        await window.api.plugins.uninstallPlugin(local.localPluginId).catch(() => null)
        clearLocalPluginUpsert(local.identityKey)
        notifyPluginsUpdated()
      }
    }
    const latestLocal = await collectLocalPlugins()
    writeKnownPluginKeys(new Set(latestLocal.map((item) => item.identityKey)))
  } finally {
    applyingRemotePlugins = false
  }
}

export const unionPluginsWithCloud = async () => {
  await backupLocalPluginsToCloud(false)
  await restorePluginsFromCloud(false)
  const latestLocal = await collectLocalPlugins()
  writeKnownPluginKeys(new Set(latestLocal.map((item) => item.identityKey)))
}

export const shouldSkipLocalPluginUpload = (item: LocalSyncedPlugin) =>
  lastAppliedFingerprint === pluginFingerprint(item)
