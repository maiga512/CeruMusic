import { net, protocol } from 'electron'
import { randomUUID } from 'node:crypto'

type StreamTarget = {
  url: string
  headers?: Record<string, string>
  expiresAt: number
}

const targets = new Map<string, StreamTarget>()
const TTL_MS = 10 * 60 * 1000

export function registerServiceStreamProtocol() {
  protocol.handle('cerumusic-service', async (request) => {
    const id = new URL(request.url).pathname.replace(/^\/+/, '')
    const target = targets.get(id)
    if (!target || target.expiresAt <= Date.now()) {
      targets.delete(id)
      return new Response('service stream expired', { status: 410 })
    }

    const headers = new Headers(target.headers || {})
    const range = request.headers.get('range')
    if (range) headers.set('Range', range)
    return net.fetch(target.url, {
      method: request.method,
      headers,
      redirect: 'follow'
    })
  })
}

export function createServiceStreamUrl(value: any): string | null {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || !value.url)
    return null
  const id = randomUUID().replace(/-/g, '')
  targets.set(id, {
    url: value.url,
    headers: value.headers || {},
    expiresAt: Date.now() + TTL_MS
  })
  return `cerumusic-service://stream/${id}`
}
