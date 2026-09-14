#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { readArchiveHeaderSync } = require('@electron/asar/lib/disk')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ASAR_SIZE = 550 * 1024 * 1024
const inputs = process.argv.slice(2)

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function collectAsarFiles(target, output = []) {
  if (!fs.existsSync(target)) return output

  const stat = fs.statSync(target)
  if (stat.isFile()) {
    if (target.endsWith('.asar')) output.push(target)
    return output
  }

  if (target.endsWith('.app')) {
    const asarPath = path.join(target, 'Contents', 'Resources', 'app.asar')
    if (fs.existsSync(asarPath)) output.push(asarPath)
    return output
  }

  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.endsWith('.asar.unpacked')) continue

    const child = path.join(target, entry.name)
    if (entry.isDirectory()) {
      collectAsarFiles(child, output)
    } else if (entry.isFile() && entry.name === 'app.asar') {
      output.push(child)
    }
  }

  return output
}

function getDefaultTargets() {
  const targets = [path.join(root, 'dist')]
  if (process.platform === 'darwin') {
    targets.push('/Applications/澜音.app', path.join(os.homedir(), 'Applications', '澜音.app'))
  }
  return targets
}

function inspectArchive(archivePath) {
  const { header } = readArchiveHeaderSync(archivePath)
  const topRoots = new Map()
  const errors = []
  const forbiddenMaps = []
  let totalSize = 0
  let mapSize = 0
  let tsbuildinfoSize = 0

  function walk(node, current = []) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const next = [...current, name]

      if (child.files) {
        walk(child, next)
        continue
      }

      const size = Number(child.size || 0)
      const filePath = next.join('/')
      const topRoot = next[0] || '.'
      totalSize += size
      topRoots.set(topRoot, (topRoots.get(topRoot) || 0) + size)

      if (filePath.endsWith('.map')) {
        mapSize += size
        if (forbiddenMaps.length < 10) forbiddenMaps.push(filePath)
      }

      if (filePath.endsWith('.tsbuildinfo')) {
        tsbuildinfoSize += size
      }
    }
  }

  walk(header)

  const distSize = [...topRoots.entries()]
    .filter(([name]) => /^dist(?:[-_].*)?$/.test(name))
    .reduce((sum, [, size]) => sum + size, 0)

  if (distSize > 0) {
    errors.push(`发现打包输出目录被再次打入 app.asar：${formatSize(distSize)}`)
  }

  if (mapSize > 0) {
    errors.push(
      `发现 ${forbiddenMaps.length >= 10 ? '至少 10 个' : `${forbiddenMaps.length} 个`} source map，共 ${formatSize(mapSize)}`
    )
  }

  if (tsbuildinfoSize > 0) {
    errors.push(`发现 TypeScript build info，共 ${formatSize(tsbuildinfoSize)}`)
  }

  if (totalSize > MAX_ASAR_SIZE) {
    errors.push(
      `app.asar 体积异常：${formatSize(totalSize)}，硬上限为 ${formatSize(MAX_ASAR_SIZE)}`
    )
  }

  return {
    archivePath,
    errors,
    forbiddenMaps,
    topRoots: [...topRoots.entries()].sort((a, b) => b[1] - a[1]),
    totalSize
  }
}

const explicitTargets = inputs.map((item) => path.resolve(item))
const targets = explicitTargets.length > 0 ? explicitTargets : getDefaultTargets()
const archiveFiles = [...new Set(targets.flatMap((target) => collectAsarFiles(target)))]

if (archiveFiles.length === 0) {
  console.error('未找到可检查的 app.asar。请传入 .app、打包目录或 app.asar 路径。')
  process.exit(1)
}

let failed = false

for (const archivePath of archiveFiles) {
  const result = inspectArchive(archivePath)

  console.log(`\n检查: ${archivePath}`)
  console.log(`app.asar: ${formatSize(result.totalSize)}`)
  console.log('占用最大的顶层目录:')
  for (const [name, size] of result.topRoots.slice(0, 8)) {
    console.log(`  ${formatSize(size).padStart(10)}  ${name}`)
  }

  if (result.errors.length > 0) {
    failed = true
    for (const error of result.errors) console.error(`  ERROR: ${error}`)
    for (const file of result.forbiddenMaps) console.error(`  map: ${file}`)
  } else {
    console.log('  包体检查通过')
  }
}

if (failed) process.exit(1)
