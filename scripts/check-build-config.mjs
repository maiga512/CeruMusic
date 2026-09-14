#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'electron-builder.yml')
const config = fs.readFileSync(configPath, 'utf8')

const requiredRules = [
  '!dist/**',
  '!dist-*/**',
  '!test-data/**',
  '!**/._*',
  '!**/*.map',
  '!**/*.tsbuildinfo'
]

const missing = requiredRules.filter((rule) => !config.includes(`- '${rule}'`))

if (missing.length > 0) {
  console.error('electron-builder.yml 缺少关键排除规则：')
  for (const rule of missing) console.error(`  ${rule}`)
  console.error('\n禁止继续打包，请先阅读 BUILDING.md。')
  process.exit(1)
}

console.log('electron-builder 打包范围检查通过')
