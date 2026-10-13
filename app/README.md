# hu-agent-app（桌面客户端）

Electron + React + TypeScript 骨架（electron-vite 构建，electron-builder 打包）。

## 常用命令

```bash
npm install        # 首次安装依赖（生成 package-lock.json，请提交）
npm run dev        # 开发模式：开窗 + HMR
npm run typecheck  # 主进程/预加载 + 渲染进程类型检查
npm run build      # 构建到 out/
npm run dist       # 打 Windows 安装包（需要签名时配置证书，见 docs/design.md 9.5）
npm run dist:mac   # 打 macOS dmg（需 Developer ID 与公证配置）
```

> 若 `npm install` 卡在 Electron 二进制下载（GitHub 超时），使用镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 目录结构

```
src/main/       # 主进程（窗口、IPC、后续的 Agent Core）
src/preload/    # 预加载脚本（contextBridge 暴露 window.huAgent）
src/renderer/   # 渲染进程（React 界面）
```

## 安全基线（design 5.1）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
- 渲染进程启用 CSP（见 `src/renderer/index.html`）；
- 外链一律经系统浏览器打开，禁止应用内导航到外部页面；
- 渲染进程只能通过 `window.huAgent` 的白名单方法访问主进程能力。

## 当前状态（阶段 0-05）

- [x] 三进程结构与类型化 IPC（`app:get-version` 示例）
- [x] electron-builder 打包配置（NSIS / dmg）
- [x] `npm install`、`npm run typecheck`、`npm run build` 验证通过
