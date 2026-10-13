# ADR 0005：SSO / OIDC 实现方式与 cryptography 依赖

- 状态：已接受
- 日期：2026-10-14（阶段 7 实现 D10「v1 支持 SSO」）

## 背景

设计 6.12 要求客户端与管理台支持企业 OIDC 登录（Authorization Code + PKCE），本地密码登录保留为兜底。
需要落地：多身份源、域名白名单、JIT 建号、自动加入组织、`client_secret` 加密存储、ID Token 验签、一次性 code。

## 决策

1. **协议流程**：三方 PKCE。
   - 客户端生成 `state` 与服务端回调之间的 PKCE（S256），浏览器访问 `GET /auth/sso/{id}/authorize`；
   - 服务端生成自己的 `state`/`nonce`/verifier（加密存储）并 302 到 IdP；
   - 回调校验服务端 state → 换 token → 验签 ID Token（或回退 userinfo）→ JIT → 302 携带**一次性 code**；
   - 客户端 `POST /auth/sso/exchange`（code + 自己的 verifier）换本地 access/refresh。
   这条链路让 `client_secret` 只存在服务端，桌面端无需回调解析 token。
2. **一次性凭证存 PostgreSQL**（`sso_login_requests` / `sso_login_codes`，V0004），不依赖 Redis：
   登录请求 10 分钟、一次性 code 60 秒、单次使用（`used_at` 乐观标记）；PG 已是必选依赖，测试与部署更简单。
3. **密钥加密**：AES-GCM，主密钥来自 `HUAGENT_MASTER_KEY`（32 字节 Base64/hex）；未配置时退化为从
   `jwt_secret` 派生并告警（仅本地开发）。测试通过依赖注入使用可逆内存替身（不触碰真实密钥）。
4. **ID Token 验签**：HS256 用 `client_secret` 作密钥（PyJWT 内置，无需额外依赖，集成测试走这条真实路径）；
   RS256/ES256 用 JWKS（PyJWT `PyJWKClient`，缓存 1h）——需要 `cryptography`。
5. **HTTP 传输**：默认用标准库 `urllib`（在线程池执行），避免为 OIDC 引入运行时 HTTP 客户端依赖；
   测试通过 `get_oidc_http` 依赖注入假 IdP。

## 后果与待办

- **需要在交付前执行 `cd management && uv add cryptography`**：它同时是 AES-GCM（`client_secret`/PKCE verifier）
  与 RS256/ES256 验签的依赖。当前代码在缺少它时给出明确错误提示，集成测试用注入替身与 HS256 路径覆盖协议逻辑，
  因此 CI 不依赖该包；但对接真实企业 IdP（几乎都是 RS256）必须安装。
- 部署必须设置 `HUAGENT_MASTER_KEY`（否则退化为从 `jwt_secret` 派生，仅限本地开发）。
- v1 不做 IdP 组到角色的映射、SCIM、SAML（与设计 6.12.1 边界一致）。

## 验证情况（2026-10-14）

- 服务端集成测试 4 个：身份源 CRUD 与 RBAC、完整 authorize→callback→exchange（JIT 建号、绑定、自动入组织、
  PKCE 错误拒绝、一次性 code 重放拒绝、审计落库、SSO-only 用户解绑保护）、策略拒绝（域名白名单、
  邮箱未验证、禁止自动绑定）、禁用身份源即时撤销会话与 authorize 失效。
- 客户端单测 8 个：PKCE 计算、authorize URL、回环服务、完整登录并持久化、错误回调、state 不匹配忽略、
  超时、未配置浏览器。
