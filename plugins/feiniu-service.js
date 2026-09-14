/**
 * CeruMusic 飞牛音乐服务插件
 *
 * @name 飞牛音乐服务
 * @author CeruMusic
 * @version 1.2.1
 * @description 按 fnOS Music API 对齐安卓版读取歌单、歌词和歌曲流
 */

const API_PREFIX = '/music/api/v1'
const PAGE_SIZE = 200
const MAX_PAGES = 20
const PLAYLIST_REQUEST_TIMEOUT = 30000
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

const pluginInfo = {
  name: '飞牛音乐服务',
  version: '1.2.1',
  author: 'CeruMusic',
  description: '按 fnOS Music API 对齐安卓版读取歌单、歌词和歌曲流'
}

const configSchema = [
  {
    key: 'host',
    label: '服务器主机（只填域名）',
    type: 'text',
    required: true,
    placeholder: 'Fn.example.com（不要填 http://、https:// 或路径）'
  },
  { key: 'port', label: '服务器端口', type: 'number', default: 5666, required: true },
  { key: 'username', label: '用户名', type: 'text', required: true },
  { key: 'password', label: '密码', type: 'password', required: true },
  { key: 'useHttps', label: 'HTTPS 安全访问', type: 'switch', default: false },
  { key: 'accessCode', label: '访问安全码（未开启就留空）', type: 'password' }
]

let sessionToken = ''
let sessionDeviceId = ''

function baseUrl(config) {
  let value = String(config.host || '').trim()
  if (!value) throw new Error('请填写飞牛服务器地址')

  // 完整 URL（例如反代地址 https://Fn.example:11443）中的协议、端口和路径全部保留。
  const hasProtocol = /^https?:\/\//i.test(value)
  if (hasProtocol) {
    const parsed = new URL(value)
    parsed.pathname = parsed.pathname.replace(new RegExp(`${API_PREFIX.replaceAll('/', '\\/')}$`, 'i'), '')
    parsed.pathname = parsed.pathname.replace(/\/music$/i, '').replace(/\/+$/, '')
    return parsed.toString().replace(/\/$/, '')
  }

  value = value.replace(/\/+$/, '')
  const protocol = config.useHttps === true ? 'https' : 'http'
  const port = Number(config.port) > 0 ? Number(config.port) : protocol === 'https' ? 5667 : 5666
  return `${protocol}://${value}:${port}`
}

function authHeaders(config, token) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Cookie = `music-token=${token}`
  if (config.accessCode) {
    headers['x-access-code'] = cerumusic.utils.buffer
      .from(String(config.accessCode), 'utf8')
      .toString('base64')
    headers['x-access-source'] = 'app'
  }
  return headers
}

function isAuthFailure(error) {
  return [401, 403, 100003].includes(Number(error?.code))
}

async function request(config, path, options = {}) {
  const token = options.token === undefined ? sessionToken || config.token : options.token
  const response = await cerumusic.request(`${baseUrl(config)}${API_PREFIX}${path}`, {
    method: options.method || 'GET',
    timeout: options.timeout || 15000,
    redirect: options.redirect,
    headers: {
      ...authHeaders(config, token),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })

  const status = Number(response?.statusCode || 0)
  if (status < 200 || status >= 300) {
    const detail = response.body?.msg || response.body?.message || response.body?.error || ''
    const error = new Error(
      `飞牛服务请求失败：${status || '无响应'}${detail ? `（${detail}）` : ''}`
    )
    error.code = status
    throw error
  }
  if (response.body?.code !== undefined && Number(response.body.code) !== 0) {
    const error = new Error(
      response.body.message || response.body.msg || `飞牛服务错误：${response.body.code}`
    )
    error.code = Number(response.body.code)
    throw error
  }

  return {
    data: response.body?.data === undefined ? response.body : response.body.data,
    url: response.url || '',
    headers: response.headers || {}
  }
}

async function requestWithRetry(config, path, options = {}, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(config, path, options)
    } catch (error) {
      lastError = error
      if (!RETRYABLE_STATUS_CODES.has(Number(error?.code)) || attempt === attempts - 1) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError
}

function randomDeviceId() {
  const bytes = cerumusic.utils.crypto.randomBytes(16)
  return cerumusic.utils.buffer.bufToString(bytes, 'hex')
}

async function login(config) {
  const deviceId = String(config.deviceId || sessionDeviceId || randomDeviceId())
  const result = await request(config, '/user/password-login', {
    method: 'POST',
    token: '',
    body: {
      username: String(config.username || '').trim(),
      password: cerumusic.utils.crypto.sha256(String(config.password || '')).toLowerCase(),
      deviceId
    }
  })
  const token = value(result.data, 'userToken', 'token', 'accessToken')
  if (!token) throw new Error('飞牛服务未返回登录令牌')
  sessionToken = String(token)
  sessionDeviceId = deviceId
  return { token: sessionToken, deviceId }
}

async function withSession(config, operation) {
  try {
    return await operation()
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    await login(config)
    return await operation()
  }
}

const array = (value) => (Array.isArray(value) ? value : value ? [value] : [])
const value = (item, ...keys) =>
  keys.map((key) => item?.[key]).find((item) => item !== undefined && item !== null && item !== '')
const cover = (config, id) =>
  id && /^https?:/i.test(String(id))
    ? String(id)
    : id
      ? `${baseUrl(config)}${API_PREFIX}/static/cover?coverId=${encodeURIComponent(id)}&size=320`
      : ''
const stream = (config, id) =>
  `${baseUrl(config)}${API_PREFIX}/track/stream?guid=${encodeURIComponent(id)}`
const duration = (input) => {
  const seconds =
    Number(input || 0) > 10000 ? Math.floor(Number(input) / 1000) : Math.floor(Number(input || 0))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function trackGuid(track) {
  const id = value(track, 'trackGUID', 'guid', 'trackGuid')
  if (!id) throw new Error('飞牛歌曲缺少 track GUID')
  return String(id)
}

function mapTrack(config, track) {
  const id = trackGuid(track)
  const artists = array(value(track, 'artists', 'artistList', 'artist'))
    .map((artist) =>
      typeof artist === 'string' ? artist : value(artist, 'name', 'artistName', 'title')
    )
    .filter(Boolean)
  const coverId =
    value(track, 'coverGUID', 'coverGuid', 'coverId', 'coverURL', 'cover') ||
    value(track.album, 'coverId')
  const url = stream(config, id)
  return {
    name: value(track, 'trackName', 'title', 'name') || '未知歌曲',
    singer: artists.join('、') || value(track, 'artistName') || '未知艺术家',
    albumName: value(track, 'albumName') || value(track.album, 'name', 'title') || '',
    albumId: String(value(track, 'albumGUID', 'albumGuid', 'albumId') || ''),
    interval: duration(value(track, 'durationMs', 'duration', 'length')),
    img: cover(config, coverId),
    source: 'feiniu',
    songmid: `feiniu_${id}`,
    url,
    types: [{ type: '128k' }],
    _types: { '128k': {} },
    typeUrl: { '128k': url },
    lrc: null
  }
}

async function testConnection(config) {
  try {
    const session = await login(config)
    await request({ ...config, ...session }, '/user/me')
    return { success: true, message: '飞牛音乐服务连接成功', config: session }
  } catch (error) {
    const detail = String(error?.message || '飞牛音乐服务连接失败')
    return {
      success: false,
      message: /EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND/i.test(detail)
        ? `飞牛服务器网络不可达：${detail}`
        : detail
    }
  }
}

async function getPlaylists(config) {
  return withSession(config, async () => {
    const result = []
    let page = 1
    let total = 0
    while (page <= MAX_PAGES) {
      const response = await requestWithRetry(config, `/playlist/list?page=${page}&size=100`, {
        timeout: PLAYLIST_REQUEST_TIMEOUT
      })
      const data = response.data || {}
      const items = array(data.list || data.items || data.playlists || data)
      result.push(...items)
      total = Number(data.total || result.length)
      if (!items.length || result.length >= total) break
      page += 1
    }

    const playlists = result
      .map((item) => ({
        id: String(value(item, 'playlistGUID', 'guid', 'id') || ''),
        name: value(item, 'playlistName', 'name', 'title') || '未命名歌单',
        songCount: Number(value(item, 'trackCount', 'trackNum', 'total') || 0),
        coverImg: cover(config, value(item, 'coverGUID', 'coverGuid', 'coverId', 'cover')),
        description: value(item, 'description', 'desc') || ''
      }))
      .filter((item) => item.id)
      .filter((item, index, array) => array.findIndex((entry) => entry.id === item.id) === index)

    // 安卓版还暴露“我的收藏”和“全部歌曲”两个入口。
    for (const virtual of [
      { id: 'favorite-track', name: '飞牛我的收藏', path: '/favorite-track/list' },
      { id: 'all-tracks', name: '飞牛全部歌曲', path: '/track/list' }
    ]) {
      const response = await requestWithRetry(config, `${virtual.path}?page=1&size=1`, {
        timeout: PLAYLIST_REQUEST_TIMEOUT
      })
      const count = Number(response.data?.total || 0)
      if (count > 0) playlists.push({ id: virtual.id, name: virtual.name, songCount: count })
    }
    return playlists
  })
}

async function getPlaylistSongs(config, playlistId) {
  if (!playlistId) throw new Error('飞牛歌单缺少 GUID')
  return withSession(config, async () => {
    const endpoint =
      playlistId === 'favorite-track'
        ? '/favorite-track/list'
        : playlistId === 'all-tracks'
          ? '/track/list'
          : '/track/playlist-detail/list'
    const query = (page) =>
      endpoint === '/track/playlist-detail/list'
        ? `playlistGUID=${encodeURIComponent(playlistId)}&page=${page}&size=${PAGE_SIZE}`
        : `page=${page}&size=${PAGE_SIZE}`

    const firstResponse = await requestWithRetry(config, `${endpoint}?${query(1)}`, {
      timeout: PLAYLIST_REQUEST_TIMEOUT
    })
    const firstData = firstResponse.data || {}
    const tracks = array(firstData.list || firstData.items || firstData.tracks || firstData)
    const total = Number(firstData.total || tracks.length)
    const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)))

    if (pageCount > 1) {
      const responses = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, index) =>
          requestWithRetry(config, `${endpoint}?${query(index + 2)}`, {
            timeout: PLAYLIST_REQUEST_TIMEOUT
          })
        )
      )
      for (const response of responses) {
        const data = response.data || {}
        tracks.push(...array(data.list || data.items || data.tracks || data))
      }
    }

    return { songs: tracks.map((track) => mapTrack(config, track)), total: total || tracks.length }
  })
}

async function getLyric(config, songInfo) {
  const id = String(songInfo.songmid || '').replace(/^feiniu_/, '')
  if (!id) return { lyric: '' }
  return withSession(config, async () => {
    const response = await request(config, `/lyric/list?trackGUID=${encodeURIComponent(id)}`)
    const data = response.data || {}
    const entries = array(data.list).filter((item) => item && String(item.content || '').trim())
    if (!entries.length) return { lyric: '' }
    const preferred = String(data.preferred || '')
    const selected =
      entries.find((item) => preferred && String(item.guid || '') === preferred) ||
      entries.find((item) => item.isLRC === true) ||
      entries[0]
    return { lyric: String(selected.content || '') }
  })
}

/**
 * 服务插件取流契约：必须由插件发起带 Cookie 的请求。
 * fnOS 通常会返回重定向后的短期地址；主进程优先使用该地址，避免浏览器丢失 Cookie。
 */
async function musicUrl(_source, songInfo) {
  const id = String(songInfo?.songmid || songInfo?.id || '').replace(/^feiniu_/, '')
  if (!id) throw new Error('飞牛歌曲缺少 track GUID')
  const config = songInfo?._serviceConfig || {}
  if (!config.host) throw new Error('请先配置飞牛音乐服务')
  return withSession(config, async () => {
    const response = await request(config, `/track/stream?guid=${encodeURIComponent(id)}`)
    return {
      url: response.url || stream(config, id),
      headers: authHeaders(config, sessionToken)
    }
  })
}

module.exports = {
  pluginInfo,
  pluginType: 'service',
  serviceRole: 'feiniu',
  sources: [],
  configSchema,
  testConnection,
  getPlaylists,
  getPlaylistSongs,
  getLyric,
  musicUrl
  ,baseUrl
}
