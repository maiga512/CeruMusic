import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'plugins/feiniu-service.js'), 'utf8')
const sandbox = { module: { exports: {} }, exports: {}, console }
vm.runInNewContext(source, sandbox, { filename: 'feiniu-service.js' })
const plugin = sandbox.module.exports

const requiredMethods = [
  'testConnection',
  'getPlaylists',
  'getPlaylistSongs',
  'getLyric',
  'musicUrl'
]
for (const method of requiredMethods) {
  if (typeof plugin[method] !== 'function') throw new Error(`缺少服务方法: ${method}`)
}
if (plugin.pluginType !== 'service' || plugin.serviceRole !== 'feiniu') {
  throw new Error('插件类型或服务角色不正确')
}
for (const field of ['host', 'port', 'username', 'password']) {
  if (!plugin.configSchema.some((item) => item.key === field && item.required)) {
    throw new Error(`缺少必填配置项: ${field}`)
  }
}
if (!plugin.configSchema.some((item) => item.key === 'useHttps' && item.type === 'switch')) {
  throw new Error('缺少安卓版 HTTPS 开关配置')
}
if (!source.includes('code') || !source.includes('password-login')) {
  throw new Error('未找到 fnOS 登录和业务码校验契约')
}
if (!source.includes('music-token') || !source.includes('sha256')) {
  throw new Error('未找到 fnOS Cookie 鉴权或 SHA-256 密码契约')
}
if (!source.includes('trackGUID') || !source.includes('playlist-detail/list')) {
  throw new Error('未找到 GUID 歌词或分页歌单契约')
}
if (!source.includes('/static/cover') || !source.includes('/favorite-track/list')) {
  throw new Error('未找到安卓版封面或收藏接口契约')
}
console.log('飞牛服务插件结构校验通过')
