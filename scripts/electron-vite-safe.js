const { spawn } = require('node:child_process')
const path = require('node:path')
const electronBinary = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const projectRoot = path.resolve(__dirname, '..')
const mode = process.argv[2] || 'preview'
const extraArgs = process.argv.slice(3)

const electronViteBin =
  process.platform === 'win32'
    ? path.resolve(__dirname, '../node_modules/.bin/electron-vite.cmd')
    : path.resolve(__dirname, '../node_modules/.bin/electron-vite')

// 预览模式直接启动 Electron 可执行文件，避免额外的 preview 包装层。
const child =
  mode === 'preview'
    ? spawn(electronBinary, [projectRoot, ...extraArgs], {
        stdio: 'inherit',
        env
      })
    : spawn(electronViteBin, [mode, ...extraArgs], {
        stdio: 'inherit',
        env
      })

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})