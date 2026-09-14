import { ipcMain } from 'electron'
import pluginService from '../services/plugin'
import ManageSongList from '../services/songList/ManageSongList'
import { pluginLog } from '../logger'

let isPluginsInitialized = false
const FEINIU_AUTO_IMPORT_VERSION = 2

async function importServicePlaylistToLocal(
  pluginId: string,
  playlistId: string,
  playlistName?: string,
  description = '从服务插件导入'
): Promise<any> {
  const result = await pluginService.getPlaylistSongs(pluginId, playlistId)
  if (!result || !Array.isArray(result.songs) || result.songs.length === 0) {
    return { error: '歌单为空或获取失败' }
  }

  const remotePlaylistId = String(playlistId)
  const existing = ManageSongList.Read().find(
    (item) =>
      item.meta?.importedFrom === pluginId &&
      String(item.meta?.remotePlaylistId || '') === remotePlaylistId
  )

  let songListId = existing?.id || ''
  let created = false
  if (existing) {
    ManageSongList.editById(existing.id, {
      name: playlistName || existing.name,
      description: existing.description || description,
      source: 'local',
      meta: {
        ...existing.meta,
        importedFrom: pluginId,
        remotePlaylistId
      }
    })
  } else {
    const createResult = ManageSongList.createPlaylist(
      playlistName || '导入的歌单',
      description,
      'local',
      { importedFrom: pluginId, remotePlaylistId }
    )
    songListId = createResult.id
    created = true
  }

  // 注入 _servicePluginId，播放歌曲时主进程会用对应插件换取真实播放地址。
  const songs = result.songs.map((song: any) => ({
    ...song,
    _servicePluginId: pluginId
  }))
  const added = new ManageSongList(songListId).addSongs(songs as any)

  return {
    success: true,
    data: {
      songListId,
      added,
      total: result.songs.length,
      created
    }
  }
}

async function autoImportConfiguredFeiniuPlaylists(pluginId: string): Promise<any> {
  const playlists = await pluginService.getPlaylists(pluginId)
  const importable = (Array.isArray(playlists) ? playlists : []).filter(
    (item) =>
      item?.id &&
      (item.id !== 'favorite-track' || Number(item.songCount || 0) > 0)
  )
  const imported: any[] = []
  const skipped: any[] = []
  const errors: string[] = []

  for (const playlist of importable) {
    try {
      const result = await importServicePlaylistToLocal(
        pluginId,
        String(playlist.id),
        String(playlist.name || '导入的歌单')
      )
      if (result?.error === '歌单为空或获取失败') {
        skipped.push({ playlistId: String(playlist.id), name: String(playlist.name || '') })
      } else if (result?.error) {
        errors.push(`${playlist.name || playlist.id}：${result.error}`)
      } else {
        imported.push({
          playlistId: String(playlist.id),
          name: String(playlist.name || '导入的歌单'),
          ...result.data
        })
      }
    } catch (error: any) {
      errors.push(`${playlist.name || playlist.id}：${error.message || '导入失败'}`)
    }
  }

  return { playlistCount: importable.length, imported, skipped, errors }
}

async function autoImportFeiniuAfterLogin(pluginId: string, result: any): Promise<any> {
  if (!result?.success || pluginService.getServiceRole(pluginId) !== 'feiniu') return result

  try {
    const autoImport = await autoImportConfiguredFeiniuPlaylists(pluginId)
    const config = pluginService.getConfig(pluginId)
    if (autoImport.errors.length === 0) {
      pluginService.saveConfig(pluginId, {
        ...config,
        autoImportVersion: FEINIU_AUTO_IMPORT_VERSION,
        autoImportedAt: new Date().toISOString()
      })
    }
    return { ...result, autoImport }
  } catch (error: any) {
    pluginLog.warn('飞牛歌单自动导入失败:', error)
    return { ...result, autoImport: { errors: [error.message || '歌单自动导入失败'] } }
  }
}

async function runConfiguredFeiniuStartupSync(): Promise<any> {
  const plugins = await pluginService.getPluginsList()
  const feiniu = (Array.isArray(plugins) ? plugins : []).find(
    (plugin: any) => plugin?.serviceRole === 'feiniu'
  )
  if (!feiniu?.pluginId) return null

  const config = pluginService.getConfig(feiniu.pluginId)
  if (
    !config?.host ||
    !config?.username ||
    !config?.password
  ) {
    return null
  }

  // 飞牛令牌只存在当前会话。即使歌单已迁移完成，也刷新一次令牌给封面等资源使用。
  const loginResult = await pluginService.testConnection(feiniu.pluginId)
  if (!loginResult?.success) {
    return { errors: [loginResult?.message || '飞牛登录失败'] }
  }

  if (config?.autoImportVersion === FEINIU_AUTO_IMPORT_VERSION) {
    return { playlistCount: 0, imported: [], skipped: [], errors: [] }
  }

  const latestConfig = pluginService.getConfig(feiniu.pluginId)

  const autoImport = await autoImportConfiguredFeiniuPlaylists(feiniu.pluginId)
  if (autoImport.errors.length === 0) {
    pluginService.saveConfig(feiniu.pluginId, {
      ...latestConfig,
      autoImportVersion: FEINIU_AUTO_IMPORT_VERSION,
      autoImportedAt: new Date().toISOString()
    })
  }
  return autoImport
}

let feiniuStartupSyncPromise: Promise<any> | null = null

export function markPluginSystemInitialized(): void {
  isPluginsInitialized = true
}

export function syncConfiguredFeiniuOnStartup(): Promise<any> {
  if (!feiniuStartupSyncPromise) {
    feiniuStartupSyncPromise = runConfiguredFeiniuStartupSync().catch((error) => {
      feiniuStartupSyncPromise = null
      throw error
    })
  }
  return feiniuStartupSyncPromise
}

export default function InitPluginService() {
  ipcMain.handle('service-plugin-selectAndAddPlugin', async (_, type): Promise<any> => {
    try {
      return await pluginService.selectAndAddPlugin(type)
    } catch (error: any) {
      console.error('Error selecting and adding plugin:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle(
    'service-plugin-downloadAndAddPlugin',
    async (_, url, type, targetPluginId): Promise<any> => {
      try {
        return await pluginService.downloadAndAddPlugin(url, type, targetPluginId)
      } catch (error: any) {
        console.error('Error downloading and adding plugin:', error)
        return { error: error.message }
      }
    }
  )

  ipcMain.handle(
    'service-plugin-addPlugin',
    async (_, pluginCode, pluginName, targetPluginId): Promise<any> => {
      try {
        return await pluginService.addPlugin(pluginCode, pluginName, targetPluginId)
      } catch (error: any) {
        console.error('Error adding plugin:', error)
        return { error: error.message }
      }
    }
  )

  ipcMain.handle('service-plugin-getPluginById', async (_, id): Promise<any> => {
    try {
      return pluginService.getPluginById(id)
    } catch (error: any) {
      console.error('Error getting plugin by id:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-loadAllPlugins', async (): Promise<any> => {
    try {
      // 使用新的 getPluginsList 方法，但保持 API 兼容性
      return await pluginService.getPluginsList()
    } catch (error: any) {
      console.error('Error loading all plugins:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-reloadAllPlugins', async (): Promise<any> => {
    try {
      return await pluginService.reloadAllPlugins()
    } catch (error: any) {
      console.error('Error reloading all plugins:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-getPluginLog', async (_, pluginId): Promise<any> => {
    try {
      return await pluginService.getPluginLog(pluginId)
    } catch (error: any) {
      console.error('Error getting plugin log:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-appendPluginLog', async (_, pluginId, level, ...args): Promise<any> => {
    try {
      pluginService.appendPluginLog(pluginId, level, ...args)
      return { success: true }
    } catch (error: any) {
      console.error('Error appending plugin log:', error)
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-uninstallPlugin', async (_, pluginId): Promise<any> => {
    try {
      return await pluginService.uninstallPlugin(pluginId)
    } catch (error: any) {
      console.error('Error uninstalling plugin:', error)
      return { error: error.message }
    }
  })

  // ==================== 服务插件 IPC ====================

  ipcMain.handle('service-plugin-getPluginType', async (_, pluginId): Promise<any> => {
    try {
      return { data: pluginService.getPluginType(pluginId) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-getServiceRole', async (_, pluginId): Promise<any> => {
    try {
      return { data: pluginService.getServiceRole(pluginId) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-getConfigSchema', async (_, pluginId): Promise<any> => {
    try {
      return { data: pluginService.getConfigSchema(pluginId) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-getConfig', async (_, pluginId): Promise<any> => {
    try {
      return { data: pluginService.getConfig(pluginId) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-saveConfig', async (_, pluginId, config): Promise<any> => {
    try {
      pluginService.saveConfig(pluginId, config)
      return { success: true }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle('service-plugin-testConnection', async (_, pluginId): Promise<any> => {
    try {
      const result = await pluginService.testConnection(pluginId)
      return await autoImportFeiniuAfterLogin(pluginId, result)
    } catch (error: any) {
      return { success: false, message: error.message }
    }
  })

  ipcMain.handle('service-plugin-getPlaylists', async (_, pluginId): Promise<any> => {
    try {
      return { data: await pluginService.getPlaylists(pluginId) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  ipcMain.handle(
    'service-plugin-getPlaylistSongs',
    async (_, pluginId, playlistId): Promise<any> => {
      try {
        return { data: await pluginService.getPlaylistSongs(pluginId, playlistId) }
      } catch (error: any) {
        return { error: error.message }
      }
    }
  )

  ipcMain.handle(
    'service-plugin-importToLocal',
    async (_, pluginId, playlistId, playlistName): Promise<any> => {
      try {
        return await importServicePlaylistToLocal(pluginId, playlistId, playlistName)
      } catch (error: any) {
        return { error: error.message }
      }
    }
  )

  ipcMain.handle('service-plugin-getServiceLyric', async (_, pluginId, songInfo): Promise<any> => {
    try {
      return { data: await pluginService.getServiceLyric(pluginId, songInfo) }
    } catch (error: any) {
      return { error: error.message }
    }
  })

  // 保持初始化兼容性
  ipcMain.handle('service-plugin-initialize-system', async () => {
    if (isPluginsInitialized) return true
    try {
      await pluginService.initializePlugins()
      markPluginSystemInitialized()
      pluginLog.info('插件系统初始化完成')
      await syncConfiguredFeiniuOnStartup().catch((error) => {
        pluginLog.warn('启动时同步飞牛歌单失败:', error)
      })
      return true
    } catch (error) {
      pluginLog.error('插件系统初始化失败:', error)
      throw error
    }
  })
}
