<template>
  <div class="music-cache">
    <!-- 缓存可视化展示 -->
    <t-card hover-shadow :loading="!cacheInfo" title="缓存占用">
      <template #actions>
        <span class="usage-badge" :class="usageClass">
          {{ cacheInfo?.usagePercent || 0 }}%
        </span>
      </template>
      <div class="cache-usage-section">
        <!-- 进度条 -->
        <div class="progress-container">
          <div class="progress-bar">
            <div
              class="progress-fill"
              :style="{ width: `${cacheInfo?.usagePercent || 0}%` }"
              :class="usageClass"
            ></div>
          </div>
          <div class="progress-info">
            <span class="current-size">{{ cacheInfo?.sizeFormatted || '0 B' }}</span>
            <span class="separator">/</span>
            <span class="max-size">{{ cacheInfo?.maxSizeFormatted || formatBytes((settings.settings.maxCacheSizeGB ?? 5) * 1024 * 1024 * 1024) }}</span>
          </div>
        </div>

        <!-- 缓存分布 -->
        <div class="cache-breakdown">
          <div class="breakdown-item">
            <span class="breakdown-label">歌曲URL缓存</span>
            <span class="breakdown-value">{{ cacheInfo?.breakdown?.musicUrlsFormatted || '0 B' }}</span>
          </div>
          <div class="breakdown-item">
            <span class="breakdown-label">歌词缓存</span>
            <span class="breakdown-value">{{ cacheInfo?.breakdown?.lyricsFormatted || '0 B' }}</span>
          </div>
        </div>
      </div>
    </t-card>

    <!-- 缓存限额设置 -->
    <t-card hover-shadow :loading="!cacheInfo" title="缓存限额设置" class="cache-settings-card">
      <div class="cache-settings">
        <div class="setting-row">
          <div class="setting-label">最大缓存大小</div>
          <div class="setting-control">
            <t-input
              v-model="maxCacheSizeInput"
              type="number"
              placeholder="输入大小"
              style="width: 120px"
              :min="1"
            />
            <span class="unit-label">GB</span>
            <t-button theme="primary" size="small" @click="handleConfirmMaxSize">确定</t-button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">自动清理</div>
          <div class="setting-control">
            <t-switch v-model="autoCleanupEnabled" @change="handleAutoCleanupChange" />
            <span class="switch-hint">启用后，当缓存达到限额时会自动清理</span>
          </div>
        </div>

        <div class="setting-row" v-if="autoCleanupEnabled">
          <div class="setting-label">清理阈值</div>
          <div class="setting-control">
            <t-slider
              v-model="cleanupThreshold"
              :min="50"
              :max="95"
              :step="5"
              :marks="thresholdMarks"
              style="width: 200px"
              @change="handleThresholdChange"
            />
            <span class="threshold-value">{{ cleanupThreshold }}%</span>
          </div>
        </div>
      </div>
    </t-card>

    <!-- 手动清理 -->
    <t-card hover-shadow :loading="!cacheInfo" title="清理操作">
      <template #actions>
        <span class="cache-count">
          共 {{ cacheInfo?.count || 0 }} 个缓存项
        </span>
      </template>
      <div class="clear-actions">
        <t-button
          theme="danger"
          size="large"
          :loading="isClearing"
          :disabled="!cacheInfo?.count || cacheInfo?.count === 0"
          @click="clearAutoCache"
        >
          {{ isClearing ? '正在清理...' : '清理自动缓存' }}
        </t-button>
        <t-button
          theme="danger" variant="outline"
          size="large"
          :loading="isClearingAll"
          :disabled="!cacheInfo?.count || cacheInfo?.count === 0"
          @click="clearAllCache"
        >
          {{ isClearingAll ? '正在清除...' : '清空全部缓存' }}
        </t-button>
      </div>
      <div v-if="!cacheInfo?.count || cacheInfo?.count === 0" class="no-cache-tip">
        暂无缓存文件
      </div>
    </t-card>
  </div>
</template>

<script lang="ts" setup>
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@renderer/store/Settings'

const settings = useSettingsStore()

// 定义事件
const emit = defineEmits<{
  'cache-cleared': []
}>()

interface CacheInfo {
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
}

const cacheInfo = ref<CacheInfo | null>(null)
const isClearing = ref(false)
const isClearingAll = ref(false)

// 缓存大小设置
const maxCacheSizeInput = ref(settings.settings.maxCacheSizeGB || 5)
const autoCleanupEnabled = ref(settings.settings.autoCleanupEnabled ?? true)
const cleanupThreshold = ref(Math.round((settings.settings.cacheCleanupThreshold ?? 0.9) * 100))

const thresholdMarks = {
  50: '50%',
  70: '70%',
  90: '90%'
}

// 计算使用率样式
const usageClass = computed(() => {
  const percent = cacheInfo.value?.usagePercent || 0
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warning'
  return 'normal'
})

// 格式化字节
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 加载缓存信息
const loadCacheInfo = async (forceRefresh = false) => {
  try {
    console.log('正在获取缓存信息...', forceRefresh ? '(强制刷新)' : '')
    const res = await (window.api as any).musicCache.getDetailedInfo()
    console.log('获取到缓存信息:', res)
    if (res) {
      cacheInfo.value = res
    }
  } catch (error) {
    console.error('获取缓存信息失败:', error)
  }
}

// 确认最大缓存大小
const handleConfirmMaxSize = async () => {
  const gbValue = Number(maxCacheSizeInput.value)
  if (!gbValue || gbValue <= 0) {
    MessagePlugin.warning('请输入有效的缓存大小（GB）')
    return
  }
  try {
    const bytes = gbValue * 1024 * 1024 * 1024
    await (window.api as any).musicCache.setMaxSize(bytes)
    settings.updateSettings({ maxCacheSizeGB: gbValue })
    MessagePlugin.success(`已设置最大缓存为 ${gbValue} GB`)
    await loadCacheInfo(true)
  } catch (error) {
    console.error('设置最大缓存失败:', error)
    MessagePlugin.error('设置失败')
  }
}

// 处理自动清理开关变化
const handleAutoCleanupChange = async (value: any) => {
  try {
    const boolValue = Boolean(value)
    await (window.api as any).musicCache.setAutoCleanup(boolValue)
    settings.updateSettings({ autoCleanupEnabled: boolValue })
    MessagePlugin.success(boolValue ? '已启用自动清理' : '已禁用自动清理')
  } catch (error) {
    console.error('设置自动清理失败:', error)
    MessagePlugin.error('设置失败')
  }
}

// 处理清理阈值变化
const handleThresholdChange = async (value: any) => {
  try {
    const threshold = Number(value) / 100
    await (window.api as any).musicCache.setCleanupThreshold(threshold)
    settings.updateSettings({ cacheCleanupThreshold: threshold })
  } catch (error) {
    console.error('设置清理阈值失败:', error)
  }
}

// 清理自动缓存（LRU清理）
const clearAutoCache = () => {
  const confirm = DialogPlugin.confirm({
    header: '确认清理自动缓存吗',
    body: '这将清理长期未播放的歌曲缓存，保留近期常听缓存和手动下载的歌曲。',
    confirmBtn: '确定清理',
    cancelBtn: '取消',
    placement: 'center',
    onClose: () => confirm.hide(),
    onConfirm: async () => {
      confirm.hide()
      isClearing.value = true
      try {
        const result = await (window.api as any).musicCache.cleanupAuto()
        if (result.success) {
          const freedMB = (result.freedBytes / 1024 / 1024).toFixed(2)
          MessagePlugin.success(`已清理 ${result.cleared} 个缓存，释放 ${freedMB} MB`)
          emit('cache-cleared')
          await loadCacheInfo(true)
        } else {
          MessagePlugin.error(result.message || '清理失败')
        }
      } catch (error) {
        console.error('清理缓存失败:', error)
        MessagePlugin.error('清理失败，请重试')
      } finally {
        isClearing.value = false
      }
    }
  })
}

// 清空全部缓存
const clearAllCache = () => {
  const confirm = DialogPlugin.confirm({
    header: '确认清空全部缓存吗',
    body: '这将清除所有歌曲缓存，包括手动下载的歌曲缓存。清除后歌曲加载可能会变慢。',
    confirmBtn: '确定清除',
    cancelBtn: '取消',
    placement: 'center',
    theme: 'danger',
    onClose: () => confirm.hide(),
    onConfirm: async () => {
      confirm.hide()
      isClearingAll.value = true
      try {
        const result = await (window.api as any).musicCache.clear()
        if (result.success) {
          MessagePlugin.success('全部缓存已清空')
          emit('cache-cleared')
          await loadCacheInfo(true)
        } else {
          MessagePlugin.error(result.message || '清除失败')
        }
      } catch (error) {
        console.error('清除缓存失败:', error)
        MessagePlugin.error('清除失败，请重试')
      } finally {
        isClearingAll.value = false
      }
    }
  })
}

// 刷新缓存信息（供父组件调用）
const refreshCacheInfo = async () => {
  console.log('刷新缓存信息')
  await loadCacheInfo(true)
}

// 同步设置到本地状态
watch(
  () => settings.settings,
  (newSettings) => {
    if (newSettings.maxCacheSizeGB) {
      maxCacheSizeInput.value = newSettings.maxCacheSizeGB
    }
    if (newSettings.autoCleanupEnabled !== undefined) {
      autoCleanupEnabled.value = newSettings.autoCleanupEnabled
    }
    if (newSettings.cacheCleanupThreshold) {
      cleanupThreshold.value = Math.round(newSettings.cacheCleanupThreshold * 100)
    }
  },
  { deep: true }
)

onMounted(() => {
  loadCacheInfo()
})

// 暴露方法给父组件
defineExpose({
  refreshCacheInfo
})
</script>

<style lang="scss" scoped>
.music-cache {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;

  // 使用率徽章
  .usage-badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;

    &.normal {
      background: rgba(45, 200, 88, 0.1);
      color: #2dc858;
    }

    &.warning {
      background: rgba(255, 153, 0, 0.1);
      color: #ff9900;
    }

    &.danger {
      background: rgba(235, 77, 60, 0.1);
      color: #eb4d3c;
    }
  }

  // 缓存使用部分
  .cache-usage-section {
    padding: 0 20px;

    .progress-container {
      margin-bottom: 16px;

      .progress-bar {
        height: 24px;
        background: var(--td-bg-color-container);
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 8px;

        .progress-fill {
          height: 100%;
          border-radius: 12px;
          transition: width 0.3s ease;

          &.normal {
            background: linear-gradient(90deg, #2dc858, #3dd68c);
          }

          &.warning {
            background: linear-gradient(90deg, #ff9900, #ffb340);
          }

          &.danger {
            background: linear-gradient(90deg, #eb4d3c, #ff6f5f);
          }
        }
      }

      .progress-info {
        display: flex;
        justify-content: center;
        align-items: baseline;
        gap: 4px;
        font-size: 14px;

        .current-size {
          font-weight: 600;
          color: var(--td-text-color-primary);
        }

        .separator {
          color: var(--td-text-color-placeholder);
        }

        .max-size {
          color: var(--td-text-color-secondary);
        }
      }
    }

    .cache-breakdown {
      display: flex;
      gap: 24px;

      .breakdown-item {
        display: flex;
        align-items: center;
        gap: 8px;

        .breakdown-label {
          color: var(--td-text-color-secondary);
          font-size: 13px;
        }

        .breakdown-value {
          color: var(--td-text-color-primary);
          font-weight: 500;
          font-size: 13px;
        }
      }
    }
  }

  // 设置卡片
  .cache-settings-card {
    .cache-settings {
      padding: 0 20px;

      .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 0;
        border-bottom: 1px solid var(--td-border-level-1-color);

        &:last-child {
          border-bottom: none;
        }

        .setting-label {
          font-size: 14px;
          color: var(--td-text-color-primary);
        }

        .setting-control {
          display: flex;
          align-items: center;
          gap: 8px;

          .switch-hint {
            font-size: 12px;
            color: var(--td-text-color-secondary);
            margin-left: 8px;
          }

          .unit-label {
            font-size: 14px;
            color: var(--td-text-color-secondary);
          }

          .threshold-value {
            margin-left: 12px;
            font-size: 14px;
            font-weight: 500;
            color: var(--td-brand-color);
          }
        }
      }
    }
  }

  // 清理操作
  .cache-count {
    font-size: 13px;
    color: var(--td-text-color-secondary);
  }

  .clear-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    padding: 8px 20px 0;
  }

  .no-cache-tip {
    text-align: center;
    color: var(--td-text-color-placeholder);
    font-size: 14px;
    padding: 16px 0;
  }
}
</style>
