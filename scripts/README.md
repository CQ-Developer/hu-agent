# scripts/

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| `dev-deps.sh` | 本地依赖（PG18/Redis/MinIO/Keycloak/Mailpit）起停 | `scripts/dev-deps.sh up\|down\|reset\|status` |
| `ddl-apply.sh` | 按编号执行 `db/ddl/V*.sql`（幂等，写入 `schema_versions`） | `scripts/ddl-apply.sh` |
| `check-all.sh` | 三段全量校验（服务端 / 客户端 / 管理台） | `bash scripts/check-all.sh` |
| `stage5-demo.ps1` | 阶段 5 全流程走查（组织→团队→邀请→RBAC→审批→Skill 市场→状态→停用/撤回/下架/删除） | 见下 |
| `stage5-admin.http` | 管理台延后期间的审批/上下架代办请求（VS Code REST Client 或 curl） | 见文件内注释 |
| `sso-live-check.py` | 真实 IdP（Keycloak 等）SSO 全流程联调：配置身份源 → 模拟浏览器登录 → exchange → 校验绑定 → 禁用撤销 | `uv run --project management python scripts/sso-live-check.py --admin-email … --admin-password …` |

| `package.ps1` / `package.sh` | 打包与签名（Windows/macOS，含校验和生成） | 见 `docs/delivery/signing.md` |
| `ci/apply-ddl.py` | CI 用：按编号应用 DDL（不依赖 docker compose） | `uv run --project management python scripts/ci/apply-ddl.py` |
| `ci/seed-e2e.py` | CI 用：账号/组织/团队/已发布 Skill/用量种子数据（幂等） | `uv run --project management python scripts/ci/seed-e2e.py` |
| `ci/keycloak-setup.py` | CI 用：Admin REST 准备 Keycloak realm/client/用户（幂等） | `uv run --project management python scripts/ci/keycloak-setup.py --base http://127.0.0.1:8100` |
## 阶段 5 走查（stage5-demo.ps1）

前置：

```powershell
# 1) 依赖与服务端（MinIO 镜像拉不动时可用内存对象存储，见下方说明）
scripts/dev-deps.sh up                       # 起 PG18 等
uv run --project management python scripts/export_openapi.py   # 可选：刷新契约
cd management; uv run huagent-api            # 默认 127.0.0.1:8080

# 2) 另开一个终端执行走查（脚本会自建 4 个账号与组织/团队）
powershell -ExecutionPolicy Bypass -File scripts/stage5-demo.ps1
```

脚本行为：

- 幂等：账号已存在则登录；组织 slug / 团队名 / Skill 名带随机后缀，可反复执行；
- 需要 Docker 访问 `huagent-postgres` 容器（把 `sysadmin@example.com` 直接标记为系统管理员，本地开发便捷通道）；
- 触发登录限流（10/min/IP）时会自动读取 `Retry-After` 并等待重试；
- 共 17 步，每步打印 `OK …`，最后输出「全部走查通过」；
- 临时文件写在 `%TEMP%\huagent-skill-demo-<随机数>`；
- 加 `-KeepResource` 时跳过最后的软删除，保留已发布资源（供客户端市场联调 / `MARKET_E2E=1` 使用）；
- 造包使用 .NET `ZipArchive`（显式正斜杠条目名）：PowerShell 5.1 的 `Compress-Archive` 会写入反斜杠条目名，属于非标准 zip，客户端安全解压会拒绝。

对象存储：

- 社区版 MinIO 已不以官方镜像分发，本地由 `docker/minio/Dockerfile` 源码构建（首次约 5 分钟，之后走本地镜像缓存；`docker compose up -d minio` 会自动构建）；
- 构建参数：`MINIO_GOPROXY` 可换成 `https://goproxy.cn,direct`；受限网络可再加 `HTTP_PROXY=http://host.docker.internal:7890`；
- 已实测：构建成功后走默认 `s3` 存储，走查第 12 步会真实预签名下载 `.hskill` 并校验 sha256；
- 若暂时无法构建，也以内存实现跑通其余 16 步：`HUAGENT_OBJECT_STORE=memory uv run huagent-api`（此时下载地址为 `memory://…`，只校验摘要）。

提示：Windows PowerShell 5.1 控制台若显示中文乱码，先执行 `chcp 65001`；脚本文件必须保留 UTF-8 BOM（否则 5.1 会按 ANSI 解析导致语法错误）。

## 真实 IdP（Keycloak）SSO 联调

本机 docker compose 已带 Keycloak（`http://127.0.0.1:8081`，admin/admin）。准备测试身份源：

```bash
export MSYS_NO_PATHCONV=1   # Git Bash 下避免容器内绝对路径被转换
KC="docker exec huagent-keycloak /opt/keycloak/bin/kcadm.sh"
$KC config credentials --server http://localhost:8081 --realm master --user admin --password admin
$KC create realms -s realm=huagent -s enabled=true
$KC create clients -r huagent -s clientId=hu-agent -s enabled=true -s publicClient=false   -s secret=hu-agent-secret -s standardFlowEnabled=true   -s 'redirectUris=["http://127.0.0.1:8080/api/v1/auth/sso/callback"]'
$KC create users -r huagent -s username=sso-user -s email=sso-user@example.com   -s emailVerified=true -s enabled=true -s firstName=SSO -s lastName=User
$KC set-password -r huagent --username sso-user --new-password 'Sso-Passphrase-2026'
```

然后执行联调（脚本会登录本地管理员、创建/更新身份源、模拟浏览器完成表单登录与回环回调）：

```bash
uv run --project management python scripts/sso-live-check.py   --admin-email sysadmin@example.com --admin-password 'Str0ng-Passphrase-2026'
```

预期输出：`302 → IdP` → `收到一次性 code` → `exchange OK` → `/me` 与绑定关系 → `禁用身份源 → 刷新令牌 401` → `全部通过`。
脚本会还原身份源为启用状态；测试用户与绑定关系保留在本地库中。
