# hu-agent-management-ui

企业管理工作台（design 7）：React + TypeScript + Vite + Ant Design 5。

## 运行

```bash
npm install                 # 首次
npm run dev                 # http://localhost:5173（/api 代理到 http://127.0.0.1:8080）
npm run check               # 类型检查 + i18n 一致性 + API 类型同步 + 构建
```

登录：使用服务端账号（如 `sysadmin@example.com`）；页面与菜单按角色动态渲染（仅展示控制，服务端仍强制鉴权）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/api/schema.d.ts` | 由 OpenAPI 生成的类型（**不要手改**） |
| `src/api/client.ts` | fetch 封装：Bearer 注入、401 自动刷新一次、统一 `ApiError`（含业务码/traceId） |
| `src/api/endpoints.ts` | 接口轻封装（路径与参数），类型全部取自 schema |
| `src/auth/` | 会话（access 内存 + refresh 存 sessionStorage）、路由守卫 |
| `src/app/ScopeProvider.tsx` | 可见组织/团队 + 当前选择 + 权限判定 |
| `src/pages/` | 概览、审批、Skill 管理、成员与邀请、身份源、个人设置 |
| `src/lib/` | `useAsync`（竞态保护）、格式化、业务码本地化 |

## 接口类型同步（必须）

服务端接口变更后：

```bash
# 1) 重新生成 openapi.json（在 management/ 目录）
uv run python scripts/export_openapi.py
# 2) 重新生成前端类型并记录摘要（在 management-ui/ 目录）
npm run api:gen
```

`npm run check` 会比对 `openapi/openapi.json` 与 `src/api/schema.hash`，不同源直接失败——忘记重生成会被 CI 拦住。

## 国际化

- 词典：`src/i18n/locales/{zh-CN,en-US}.ts`（嵌套键）；语言偏好存 `users.locale`（顶部切换即写入）。
- 检查：`node scripts/i18n-check.mjs`（`npm run check` 已包含）——缺键或中英键集合不一致即失败；
  详情写入指定文件：`node scripts/i18n-check.mjs out.txt`。
- AntD 静态方法（`message`/`notification`/`Modal.confirm`）在 React 19 下不可用，统一使用 `App.useApp()` 上下文 API。

## 阶段范围

- 阶段 A（已交付）：登录、审批、Skill 审核与生命周期、成员与邀请、身份源（SSO）管理、个人设置（design 7.1.2）。
- 阶段 B（待做）：组织/团队 CRUD、统计图表与导出、通知中心、审计日志、系统设置、管理台自身 SSO 登录。
