import { ipcMain } from 'electron'
import { musicCacheService } from '../services/musicCache'

// 获取缓存信息
ipcMain.handle('music-cache:get-info', async () => {
  try {
    return await musicCacheService.getCacheInfo()
  } catch (error) {
    console.error('获取缓存信息失败:', error)
    return {
      count: 0,
      size: 0,
      sizeFormatted: '0 B',
      maxSize: 0,
      maxSizeFormatted: '0 B',
      usagePercent: 0,
      breakdown: { musicUrls: 0, musicUrlsFormatted: '0 B', lyrics: 0, lyricsFormatted: '0 B' },
      oldestEntry: null,
      newestEntry: null,
      autoCleanupEnabled: true
    }
  }
})

// 清空缓存
ipcMain.handle('music-cache:clear', async () => {
  try {
    console.log('收到清空缓存请求')
    await musicCacheService.clearCache()
    console.log('缓存清空完成')
    return { success: true, message: '缓存已清空' }
  } catch (error: any) {
    console.error('清空缓存失败:', error)
    return { success: false, message: `清空缓存失败: ${error.message}` }
  }
})

// 获取缓存大小
ipcMain.handle('music-cache:get-size', async () => {
  try {
    const info = await musicCacheService.getCacheInfo()
    return info.size
  } catch (error) {
    console.error('获取缓存大小失败:', error)
    return 0
  }
})

// 设置最大缓存限额
ipcMain.handle('music-cache:set-max-size', async (_, bytes: number) => {
  try {
    await musicCacheService.setMaxCacheSize(bytes)
    return { success: true }
  } catch (error: any) {
    console.error('设置最大缓存限额失败:', error)
    return { success: false, message: error.message }
  }
})

// 获取详细缓存信息
ipcMain.handle('music-cache:get-detailed-info', async () => {
  try {
    return await musicCacheService.getCacheInfo()
  } catch (error) {
    console.error('获取详细缓存信息失败:', error)
    return null
  }
})

// 设置自动清理开关
ipcMain.handle('music-cache:set-auto-cleanup', async (_, enabled: boolean) => {
  try {
    await musicCacheService.setAutoCleanupEnabled(enabled)
    return { success: true }
  } catch (error: any) {
    console.error('设置自动清理失败:', error)
    return { success: false, message: error.message }
  }
})

// 设置清理阈值
ipcMain.handle('music-cache:set-cleanup-threshold', async (_, threshold: number) => {
  try {
    await musicCacheService.setCleanupThreshold(threshold)
    return { success: true }
  } catch (error: any) {
    console.error('设置清理阈值失败:', error)
    return { success: false, message: error.message }
  }
})

// 标记已下载歌曲（不参与自动清理）
ipcMain.handle('music-cache:mark-downloaded', async (_, songKey: string) => {
  try {
    musicCacheService.markAsManuallyDownloaded(songKey)
    return { success: true }
  } catch (error: any) {
    console.error('标记已下载失败:', error)
    return { success: false, message: error.message }
  }
})

// 取消标记已下载歌曲
ipcMain.handle('music-cache:unmark-downloaded', async (_, songKey: string) => {
  try {
    musicCacheService.unmarkAsManuallyDownloaded(songKey)
    return { success: true }
  } catch (error: any) {
    console.error('取消标记失败:', error)
    return { success: false, message: error.message }
  }
})

// 手动触发清理（只清理自动缓存，保留手动下载的）
ipcMain.handle('music-cache:cleanup-auto', async () => {
  try {
    const result = await musicCacheService.clearAutoCleanupCache()
    return { success: true, ...result }
  } catch (error: any) {
    console.error('清理自动缓存失败:', error)
    return { success: false, message: error.message }
  }
})
