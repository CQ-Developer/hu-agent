# 部署手册（服务端）

> 适用：v1 单机/小规模部署（Docker Compose）。更大规模请按 design 3.3 迁移到 K8s，
> 应用本身无状态，数据库与对象存储是唯一状态源。

## 1. 组件与端口

| 组件 | 镜像/来源 | 端口 | 说明 |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:18-alpine` | 5432 | 唯一数据库；`db/ddl/V*.sql` 初始化 |
| Redis | `redis:7-alpine` | 6379 | 登录限流、后续缓存 |
| MinIO | **本地源码构建**（`docker/minio/Dockerfile`） | 9000/9001 | 对象存储（Skill 包、快照）；社区版无官方镜像 |
| Keycloak | `quay.io/keycloak/keycloak:26.3` | 8081 | 可选，企业 SSO |
| API | `uv run huagent-api` | 8080 | FastAPI（uvicorn） |
| Worker | `uv run huagent-worker` | — | 用量聚合、分区维护、快照清理、邀请/审批 |

## 2. 环境变量（`HUAGENT_` 前缀）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgresql+psycopg://user:pass@host:5432/db` |
| `JWT_SECRET` | ✅ | 生产必须替换（≥32 字节随机串） |
| `MASTER_KEY` | ✅（启用 SSO 时） | 32 字节 Base64/hex；加密 IdP `client_secret` 与 PKCE verifier |
| `REDIS_URL` | 建议 | 缺省时登录限流降级为进程内存（多实例不安全） |
| `RATE_LIMIT_STRICT` | 建议 `true` | Redis 不可用时直接拒绝登录（而不是降级） |
| `PUBLIC_BASE_URL` | ✅（SSO） | 服务对外地址，用于拼接 IdP 回调 `…/api/v1/auth/sso/callback` |
| `S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET_SKILLS/BUCKET_SNAPSHOTS` | ✅ | MinIO/S3；首次写入自动建桶 |
| `AUTH_REGISTRATION_ENABLED` | — | `false` 关闭自助注册（企业只走 SSO/邀请） |
| `SCHEMA_EXPECTED_VERSION` | ✅ | 期望的 DDL 版本（当前 `V0004`）；不匹配会拒绝启动 |
| `WEAK_PASSWORD_FILE` | 建议 | 挂载 top-10k 弱口令名单文件路径 |
| `METRICS_ENABLED` | — | 默认 `true`；置 `false` 关闭 `/api/v1/system/metrics` |
| `METRICS_TOKEN` | 建议 | 非空时指标端点要求 `Authorization: Bearer <token>`（生产必须设置） |
| `CORS_ORIGINS` | 管理台 | 管理台/SSO 回跳来源白名单（JSON 数组） |
| `LOGIN_IP_LIMIT` / `LOGIN_FAIL_THRESHOLD` | — | 默认 10/min/IP、5 次失败递增锁 1/5/15 分钟 |

生成主密钥：`uv run python -c "import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode())"`

## 3. 首次部署

```bash
# 1) 依赖（PG/Redis/MinIO/Keycloak/Mailpit）
scripts/dev-deps.sh up            # 生产请用受管的 PG/Redis/S3 与自建 Keycloak

# 2) 初始化/升级数据库（只升不降；脚本幂等）
HUAGENT_DATABASE_URL=postgresql://user:pass@host:5432/huagent \
  uv run --project management python scripts/ci/apply-ddl.py

# 3) 启动 API 与 worker（建议 systemd/supervisor 或容器编排）
cd management && uv run huagent-api &
cd management && uv run huagent-worker &

# 4) 健康检查
curl -fsS http://<host>:8080/api/v1/system/health      # 存活
curl -fsS http://<host>:8080/api/v1/system/ready       # 依赖就绪（PG/Redis）
```

**DDL 纪律**：应用启动**不执行 DDL**，只校验 `schema_versions`；升级时先跑 DDL 脚本再滚动重启。

## 4. SSO（可选，推荐）

1. 在 IdP（如 Keycloak）创建 confidential client：
   - Redirect URI：`<PUBLIC_BASE_URL>/api/v1/auth/sso/callback`
   - 需要 `openid profile email` scope；
2. 系统管理员在客户端/脚本里配置身份源（`POST /api/v1/admin/identity-providers`，`scripts/sso-live-check.py` 可作为冒烟）；
3. 生产建议：`AUTH_REGISTRATION_ENABLED=false`，只保留 SSO + 邀请加入；
4. 禁用身份源会**立即撤销**该身份源关联用户的全部会话。

## 5. 反向代理（TLS 终止示例，nginx）

```nginx
server {
  listen 443 ssl;
  server_name hu-agent.example.com;
  ssl_certificate     /etc/ssl/hu-agent.crt;
  ssl_certificate_key /etc/ssl/hu-agent.key;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

- 客户端只填 `https://hu-agent.example.com`；`PUBLIC_BASE_URL` 与之一致（SSO 回调）；
- 预签名上传/下载直连对象存储：生产建议 MinIO/S3 也暴露 HTTPS 域名（或走内网），否则浏览器/客户端会拒绝 `http` 之外的混合内容。

## 6. 备份与恢复

| 对象 | 策略 | 目标 |
| --- | --- | --- |
| PostgreSQL | PITR/WAL 归档 + 每日全量 | RPO ≤ 1h、RTO ≤ 4h（可调） |
| MinIO/S3 | 桶版本化 + 跨机房复制（可选） | 快照/Skill 包可回滚 |
| 密钥 | `HUAGENT_MASTER_KEY` 与 `JWT_SECRET` 进入企业密钥库 | 丢失将导致 IdP 密钥不可解密 |

恢复顺序：PG 恢复 → 对象存储恢复 → 启动 API/worker（worker 启动会补偿聚合停机期间的用量）。
