import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // antd 分包单文件约 1MB（内网部署可接受）：显式设定阈值避免 CI 噪声
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 管理台内网部署：把体积大的依赖单独分包，便于缓存
        // 注意：vite 8（rolldown）只接受函数式 manualChunks
        manualChunks(id: string) {
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) return 'antd'
          if (/node_modules\/(react|react-dom|react-router)/.test(id)) return 'react'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    // 本地开发代理到服务端（design 6.9）；生产由同域反向代理承担
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
