# Ceru Music 打包规范

这份文档记录正式的打包流程和包体防错规则。发布前先看这里，不要直接修改
`electron-builder.yml` 后凭感觉打包。

## 必须遵守

`electron-builder.yml` 必须保留以下排除规则：

```yaml
files:
  - '!dist/**'
  - '!dist-*/**'
  - '!test-data/**'
  - '!**/._*'
  - '!**/*.map'
  - '!**/*.tsbuildinfo'
```

- `dist/**` 是构建输出，绝不能再次打进 `app.asar`。否则会把旧的 `.app`、
  Electron Framework 和旧版 `app.asar` 递归塞进新包，应用会异常膨胀到 2 GB 以上。
- `.map` 只用于开发调试，运行时不需要，不应进入安装包。
- `.tsbuildinfo` 是 TypeScript 增量构建缓存，不应进入安装包。
- `dist-*`、`test-data` 和 macOS `._*` 元数据同样不应进入安装包。
- `directories.output` 不要改为仓库内会被 `files` 匹配到的目录。

## 标准本地打包

先安装依赖并执行完整构建：

```bash
yarn install --frozen-lockfile
yarn build
yarn test
```

`yarn build` 会先自动运行 `yarn verify:build-config`。只要关键排除规则被误删，
构建会立即停止，不会继续生成错误安装包。

macOS Apple Silicon 本地目录包：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false \
./node_modules/.bin/electron-builder \
  --mac --arm64 --dir --publish never \
  -c.directories.output=/tmp/ceru-music-local \
  -c.mac.notarize=false
```

发布包按平台使用仓库脚本：

```bash
yarn build:win
yarn build:mac:intel
yarn build:mac:arm64
yarn build:linux
```

## 打包后必须检查

检查 `.app`：

```bash
yarn verify:package /tmp/ceru-music-local/mac-arm64/澜音.app
```

检查 `dist` 下所有可发现的 `app.asar`：

```bash
yarn verify:package
```

macOS 还要检查签名和实际体积：

```bash
codesign --verify --deep --strict --verbose=2 /tmp/ceru-music-local/mac-arm64/澜音.app
du -sh /tmp/ceru-music-local/mac-arm64/澜音.app
du -sh /tmp/ceru-music-local/mac-arm64/澜音.app/Contents/Resources/app.asar
```

2026-09-14 的本项目基线：

| 项目                |  正常体积 |
| ------------------- | --------: |
| macOS arm64 `.app`  | 约 610 MB |
| `app.asar`          | 约 304 MB |
| `app.asar.unpacked` |  约 43 MB |

应用仍包含 TensorFlow.js、NSFW 模型、TDesign 组件和原生 SQLite 等运行时依赖，
因此不会只有几十 MB。但 `app.asar` 超过 550 MB 时，`verify:package` 会直接失败。

## 出现 2 GB 包时怎么查

运行：

```bash
yarn verify:package /Applications/澜音.app
```

如果报错中出现 `dist`，说明又是旧的 `dist` 构建目录被递归打包。不要通过忽略脚本来
绕过问题，应先确认 `electron-builder.yml` 的 `!dist/**` 规则仍然存在，再重新构建。

不要删除 `out/` 后直接打包，也不要把上一次的 `.app` 或 `app.asar` 复制进
`resources/`、`assets/` 等会被打包的目录。
