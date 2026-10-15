import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // pi 包是 ESM-only（exports 只声明 import 条件），CJS 主进程 require 会报
        // ERR_PACKAGE_PATH_NOT_EXPORTED；主进程改为 ESM（electron-vite 命名 index.mjs，
        // Electron 28+ 原生支持 ESM 主进程）。preload 保持 CJS：沙箱 preload 不支持 ESM。
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
    server: {
      // 允许通过 HUAGENT_RENDERER_PORT 换端口（默认 5173，与管理台同端口；两者同时跑或端口被占时用）
      port: Number(process.env.HUAGENT_RENDERER_PORT ?? 5173),
    },
  },
})
