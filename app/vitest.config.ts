/**
 * vitest 配置（P3）：为渲染层源码测试提供与 electron-vite 相同的 `@shared` 别名。
 *
 * 只加别名，其余保持 vitest 默认（node 环境）——主进程与共享层的既有测试不受影响，
 * 渲染层的纯函数模块（如 state/agent_stream.ts）也能直接单测，无需新增依赖。
 */

import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
