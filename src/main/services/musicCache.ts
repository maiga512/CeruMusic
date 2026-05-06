import { app } from 'electron'
import * as fs from 'node:fs/promises'
import path from 'node:path'

interface CacheConfig {
  maxSizeBytes: number
  lruCleanupThreshold: number
  autoCleanupIntervalMs: number
  enableAutoCleanup: boolean
}

interface CacheEntry<T = string> {
  data: T
  size: number
  lastAccessedAt: number
  createdAt: number
  isManuallyDownloaded: boolean
}

interface PersistedCacheData {
  version: number
  musicUrls: Record<string, { data: string; createdAt: number; lastAccessedAt: number }>
  lyrics: Record<string, { data: string; createdAt: number; lastAccessedAt: number }>
  manuallyDownloadedKeys: string[]
  config: CacheConfig
}

const CACHE_FILENAME = 'music-cache-data.json'
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024 // 5GB

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

class MusicCacheService {
  private musicUrlCache = new Map<string, CacheEntry<string>>()
  private lyricCache = new Map<string, CacheEntry<string>>()
  private manuallyDownloadedKeys = new Set<string>()
  private config: CacheConfig = {
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    lruCleanupThreshold: 0.9,
    autoCleanupIntervalMs: 60 * 60 * 1000, // 1小时
    enableAutoCleanup: true
  }

  private initialized = false
  private cacheFilePath = ''
  private autoCleanupTimer: NodeJS.Timeout | null = null
  private persistChain: Promise<void> = Promise.resolve()
  private currentCacheSize = 0

  async initialize(): Promise<void> {
    if (this.initialized) return

    this.cacheFilePath = path.join(app.getPath('userData'), CACHE_FILENAME)
    await this.loadFromDisk()
    this.startAutoCleanup()
    this.initialized = true
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cacheFilePath, 'utf8')
      const data: PersistedCacheData = JSON.parse(raw)

      // 加载配置
      if (data.config) {
        this.config = { ...this.config, ...data.config }
      }

      // 加载音乐URL缓存
      if (data.musicUrls) {
        for (const [key, entry] of Object.entries(data.musicUrls)) {
          const size = this.estimateSize(entry.data)
          this.musicUrlCache.set(key, {
            data: entry.data,
            size,
            createdAt: entry.createdAt,
            lastAccessedAt: entry.lastAccessedAt,
            isManuallyDownloaded: false
          })
          this.currentCacheSize += size
        }
      }

      // 加载歌词缓存
      if (data.lyrics) {
        for (const [key, entry] of Object.entries(data.lyrics)) {
          const size = this.estimateSize(entry.data)
          this.lyricCache.set(key, {
            data: entry.data,
            size,
            createdAt: entry.createdAt,
            lastAccessedAt: entry.lastAccessedAt,
            isManuallyDownloaded: false
          })
          this.currentCacheSize += size
        }
      }

      // 加载手动下载标记
      if (data.manuallyDownloadedKeys) {
        data.manuallyDownloadedKeys.forEach((key) => this.manuallyDownloadedKeys.add(key))
      }

      console.log(
        `[musicCache] Loaded ${this.musicUrlCache.size} music URLs, ${this.lyricCache.size} lyrics, total ${formatBytes(this.currentCacheSize)}`
      )
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.warn('[musicCache] Load cache failed:', error)
      }
    }
  }

  private schedulePersist(): void {
    if (!this.cacheFilePath) return

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistToDisk())
      .catch((error) => {
        console.warn('[musicCache] Persist failed:', error)
      })
  }

  private async persistToDisk(): Promise<void> {
    const musicUrls: Record<string, { data: string; createdAt: number; lastAccessedAt: number }> = {}
    const lyrics: Record<string, { data: string; createdAt: number; lastAccessedAt: number }> = {}

    for (const [key, entry] of this.musicUrlCache.entries()) {
      musicUrls[key] = {
        data: entry.data,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt
      }
    }

    for (const [key, entry] of this.lyricCache.entries()) {
      lyrics[key] = {
        data: entry.data,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt
      }
    }

    const data: PersistedCacheData = {
      version: 1,
      musicUrls,
      lyrics,
      manuallyDownloadedKeys: Array.from(this.manuallyDownloadedKeys),
      config: this.config
    }

    await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true })
    await fs.writeFile(this.cacheFilePath, JSON.stringify(data, null, 2), 'utf8')
  }

  private estimateSize(data: string): number {
    return new Blob([data]).size
  }

  // ==================== Public API ====================

  async getCachedMusicUrl(songId: string): Promise<string | null> {
    const entry = this.musicUrlCache.get(songId)
    if (!entry) return null

    // 更新访问时间
    entry.lastAccessedAt = Date.now()
    return entry.data
  }

  async cacheMusic(songId: string, url: string): Promise<void> {
    // 检查是否已存在
    const existing = this.musicUrlCache.get(songId)
    if (existing) {
      this.currentCacheSize -= existing.size
      existing.data = url
      existing.size = this.estimateSize(url)
      existing.lastAccessedAt = Date.now()
      this.currentCacheSize += existing.size
    } else {
      const size = this.estimateSize(url)
      this.musicUrlCache.set(songId, {
        data: url,
        size,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        isManuallyDownloaded: this.manuallyDownloadedKeys.has(songId)
      })
      this.currentCacheSize += size
    }

    this.schedulePersist()
    await this.checkAndCleanup()
  }

  async getCachedLyric(cacheKey: string): Promise<string | null> {
    const entry = this.lyricCache.get(cacheKey)
    if (!entry) return null

    entry.lastAccessedAt = Date.now()
    return entry.data
  }

  async cacheLyric(cacheKey: string, lyric: string): Promise<void> {
    const existing = this.lyricCache.get(cacheKey)
    if (existing) {
      this.currentCacheSize -= existing.size
      existing.data = lyric
      existing.size = this.estimateSize(lyric)
      existing.lastAccessedAt = Date.now()
      this.currentCacheSize += existing.size
    } else {
      const size = this.estimateSize(lyric)
      this.lyricCache.set(cacheKey, {
        data: lyric,
        size,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        isManuallyDownloaded: false
      })
      this.currentCacheSize += size
    }

    this.schedulePersist()
    await this.checkAndCleanup()
  }

  async getCacheInfo(): Promise<{
    count: number
    size: number
    sizeFormatted: string
    maxSize: number
    maxSizeFormatted: string
    usagePercent: number
    breakdown: {
      musicUrls: number
      musicUrlsFormatted: string
      lyrics: number
      lyricsFormatted: string
    }
    oldestEntry: string | null
    newestEntry: string | null
    autoCleanupEnabled: boolean
  }> {
    let oldestTime = Infinity
    let newestTime = 0
    let oldestKey: string | null = null
    let newestKey: string | null = null

    for (const [key, entry] of this.musicUrlCache.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt
        oldestKey = key
      }
      if (entry.lastAccessedAt > newestTime) {
        newestTime = entry.lastAccessedAt
        newestKey = key
      }
    }

    for (const [key, entry] of this.lyricCache.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt
        oldestKey = key
      }
      if (entry.lastAccessedAt > newestTime) {
        newestTime = entry.lastAccessedAt
        newestKey = key
      }
    }

    const musicUrlsSize = Array.from(this.musicUrlCache.values()).reduce((sum, e) => sum + e.size, 0)
    const lyricsSize = Array.from(this.lyricCache.values()).reduce((sum, e) => sum + e.size, 0)

    return {
      count: this.musicUrlCache.size + this.lyricCache.size,
      size: this.currentCacheSize,
      sizeFormatted: formatBytes(this.currentCacheSize),
      maxSize: this.config.maxSizeBytes,
      maxSizeFormatted: formatBytes(this.config.maxSizeBytes),
      usagePercent: Math.round((this.currentCacheSize / this.config.maxSizeBytes) * 100),
      breakdown: {
        musicUrls: musicUrlsSize,
        musicUrlsFormatted: formatBytes(musicUrlsSize),
        lyrics: lyricsSize,
        lyricsFormatted: formatBytes(lyricsSize)
      },
      oldestEntry: oldestKey,
      newestEntry: newestKey,
      autoCleanupEnabled: this.config.enableAutoCleanup
    }
  }

  async clearCache(): Promise<void> {
    this.musicUrlCache.clear()
    this.lyricCache.clear()
    this.manuallyDownloadedKeys.clear()
    this.currentCacheSize = 0
    this.schedulePersist()
  }

  async clearAutoCleanupCache(): Promise<{ cleared: number; freedBytes: number }> {
    // 只清理自动缓存，保留手动下载的
    let cleared = 0
    let freedBytes = 0

    // 清理音乐URL缓存（保留手动下载的）
    for (const [key, entry] of this.musicUrlCache.entries()) {
      if (!entry.isManuallyDownloaded && !this.manuallyDownloadedKeys.has(key)) {
        freedBytes += entry.size
        cleared++
        this.musicUrlCache.delete(key)
      }
    }

    // 清理歌词缓存（歌词没有手动下载标记，全部清理）
    for (const [key, entry] of this.lyricCache.entries()) {
      freedBytes += entry.size
      cleared++
      this.lyricCache.delete(key)
    }

    this.currentCacheSize = Math.max(0, this.currentCacheSize - freedBytes)
    this.schedulePersist()

    return { cleared, freedBytes }
  }

  // ==================== LRU & Max Size Management ====================

  async setMaxCacheSize(bytes: number): Promise<void> {
    this.config.maxSizeBytes = Math.max(100 * 1024 * 1024, bytes) // 最小100MB
    this.schedulePersist()
    await this.checkAndCleanup()
  }

  async setCleanupThreshold(threshold: number): Promise<void> {
    this.config.lruCleanupThreshold = Math.max(0.5, Math.min(1, threshold))
    this.schedulePersist()
  }

  async setAutoCleanupEnabled(enabled: boolean): Promise<void> {
    this.config.enableAutoCleanup = enabled
    if (enabled) {
      this.startAutoCleanup()
    } else {
      this.stopAutoCleanup()
    }
    this.schedulePersist()
  }

  markAsManuallyDownloaded(songKey: string): void {
    this.manuallyDownloadedKeys.add(songKey)
    const entry = this.musicUrlCache.get(songKey)
    if (entry) {
      entry.isManuallyDownloaded = true
    }
    this.schedulePersist()
  }

  unmarkAsManuallyDownloaded(songKey: string): void {
    this.manuallyDownloadedKeys.delete(songKey)
    const entry = this.musicUrlCache.get(songKey)
    if (entry) {
      entry.isManuallyDownloaded = false
    }
    this.schedulePersist()
  }

  private async checkAndCleanup(): Promise<void> {
    if (this.currentCacheSize <= this.config.maxSizeBytes * this.config.lruCleanupThreshold) {
      return
    }

    console.log(`[musicCache] Cache size ${formatBytes(this.currentCacheSize)} exceeds ${this.config.lruCleanupThreshold * 100}% threshold, starting LRU cleanup...`)
    await this.evictByLRU()
  }

  private async evictByLRU(): Promise<void> {
    // 计算目标大小（清理到50%）
    const targetSize = this.config.maxSizeBytes * 0.5
    let neededFree = this.currentCacheSize - targetSize

    if (neededFree <= 0) return

    // 收集所有可清理的缓存项（按访问时间排序）
    interface EvictCandidate {
      key: string
      cache: 'music' | 'lyric'
      entry: CacheEntry
    }

    const candidates: EvictCandidate[] = []

    for (const [key, entry] of this.musicUrlCache.entries()) {
      // 跳过手动下载的
      if (entry.isManuallyDownloaded || this.manuallyDownloadedKeys.has(key)) {
        continue
      }
      candidates.push({ key, cache: 'music', entry })
    }

    for (const [key, entry] of this.lyricCache.entries()) {
      candidates.push({ key, cache: 'lyric', entry })
    }

    // 按最后访问时间升序排序（最老的在前）
    candidates.sort((a, b) => a.entry.lastAccessedAt - b.entry.lastAccessedAt)

    // 删除最老的缓存直到达到目标
    let freedBytes = 0
    for (const candidate of candidates) {
      if (freedBytes >= neededFree) break

      if (candidate.cache === 'music') {
        this.musicUrlCache.delete(candidate.key)
      } else {
        this.lyricCache.delete(candidate.key)
      }

      freedBytes += candidate.entry.size
    }

    this.currentCacheSize -= freedBytes
    console.log(`[musicCache] LRU cleanup freed ${formatBytes(freedBytes)}, current size: ${formatBytes(this.currentCacheSize)}`)
    this.schedulePersist()
  }

  private startAutoCleanup(): void {
    if (this.autoCleanupTimer) return
    if (!this.config.enableAutoCleanup) return

    this.autoCleanupTimer = setInterval(async () => {
      if (!this.config.enableAutoCleanup) {
        this.stopAutoCleanup()
        return
      }
      await this.checkAndCleanup()
    }, this.config.autoCleanupIntervalMs)

    console.log('[musicCache] Auto cleanup started')
  }

  private stopAutoCleanup(): void {
    if (this.autoCleanupTimer) {
      clearInterval(this.autoCleanupTimer)
      this.autoCleanupTimer = null
      console.log('[musicCache] Auto cleanup stopped')
    }
  }

  // 90% 阈值提前清理（当缓存达到90%时主动清理）
  async preemptiveCleanup(): Promise<void> {
    if (this.currentCacheSize >= this.config.maxSizeBytes * 0.9) {
      console.log('[musicCache] Cache reached 90% threshold, preemptive cleanup...')
      await this.evictByLRU()
    }
  }
}

const musicCacheService = new MusicCacheService()

export { musicCacheService, formatBytes }