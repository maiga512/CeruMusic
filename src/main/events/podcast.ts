import { ipcMain } from 'electron'
import { configManager } from '../services/ConfigManager'
import {
  checkQrLogin,
  clearLogin,
  createQrLogin,
  FALLBACK_CATEGORIES,
  getCategoryPage,
  getCategoryTotal,
  getCategoryTree,
  getLoginState,
  getOfficialPlayUrl,
  getPersistedMeta,
  getProgramLyric,
  getPrograms,
  getRadioDetail,
  loadHomeChannel,
  searchRadios
} from '../utils/musicSdk/wy/podcastOfficial'

export default function initPodcastEvents() {
  ipcMain.handle('podcast:get-login-state', async () => getLoginState())
  ipcMain.handle('podcast:create-qr', async () => createQrLogin())
  ipcMain.handle('podcast:check-qr', async (_event, key: string) => {
    const result = await checkQrLogin(key)
    if (result.code === 803 && result.cookie) {
      const state = getPersistedMeta()
      configManager.set('neteasePodcastLogin', { ...state, ...result })
    }
    return { ...result, login: getLoginState() }
  })
  ipcMain.handle('podcast:logout', async () => {
    clearLogin()
    configManager.set('neteasePodcastLogin', { ...getPersistedMeta(), cookie: '', nickname: '', userId: 0 })
    return getLoginState()
  })
  ipcMain.handle('podcast:get-categories', async (_event, forceRefresh = false) => {
    const categories = await getCategoryTree(Boolean(forceRefresh))
    return categories.length ? categories : FALLBACK_CATEGORIES
  })
  ipcMain.handle('podcast:get-category-page', async (_event, payload) => getCategoryPage(payload || {}))
  ipcMain.handle('podcast:get-category-total', async (_event, payload) => getCategoryTotal(payload || {}))
  ipcMain.handle('podcast:get-home-channel', async (_event, payload) => loadHomeChannel(payload || {}))
  ipcMain.handle('podcast:search', async (_event, payload) => searchRadios(String(payload?.keyword || '').trim(), Number(payload?.page || 1), Number(payload?.limit || 20)))
  ipcMain.handle('podcast:get-programs', async (_event, payload) => getPrograms(payload || {}))
  ipcMain.handle('podcast:get-radio-detail', async (_event, radioId: string) => getRadioDetail(radioId))
  ipcMain.handle('podcast:get-play-url', async (_event, payload) => getOfficialPlayUrl(payload?.song || payload, payload?.quality))
  ipcMain.handle('podcast:get-program-lyric', async (_event, song) => getProgramLyric(song || {}))
}
