# management-ui（管理台）

Vite + React + Ant Design 骨架（阶段 0-08），含路由、i18n（zh-CN / en-US）、
调用服务端 `/api/v1/system/health` 的示例页。

## 常用命令

```bash
npm install        # 首次安装依赖（生成 package-lock.json，请提交）
npm run dev        # 开发模式（http://localhost:5173，/api 代理到 127.0.0.1:8080）
npm run typecheck  # 类型检查
npm run build      # 类型检查 + 构建
```

## 目录结构

```
src/
  api/       # API 客户端（阶段 4/5 换为 OpenAPI 生成物）
  i18n/      # 中英文资源与初始化
  layout/    # AdminLayout（侧边导航 + 语言切换）
  pages/     # 页面
```

## 当前状态

- [x] 布局、路由、AntD 主题与中英文切换
- [x] 服务端健康检查示例（真实接口联调）
- [x] `npm install`、`npm run typecheck`、`npm run build` 验证通过；dev 代理联调 `/api/v1/system/health` 返回 200
- [ ] 权限菜单、登录页、审批/市场/统计页面（后续阶段）
