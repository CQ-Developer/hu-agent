# scripts/

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| `dev-deps.sh` | 本地依赖（PG18/Redis/MinIO/Keycloak/Mailpit）起停 | `scripts/dev-deps.sh up\|down\|reset\|status` |
| `ddl-apply.sh` | 按编号执行 `db/ddl/V*.sql`（幂等，写入 `schema_versions`） | `scripts/ddl-apply.sh` |
| `check-all.sh` | 三段全量校验（服务端 / 客户端 / 管理台） | `bash scripts/check-all.sh` |
| `stage5-demo.ps1` | 阶段 5 全流程走查（组织→团队→邀请→RBAC→审批→Skill 市场→状态→停用/撤回/下架/删除） | 见下 |
| `stage5-admin.http` | 管理台延后期间的审批/上下架代办请求（VS Code REST Client 或 curl） | 见文件内注释 |

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
- 临时文件写在 `%TEMP%\huagent-skill-demo-<随机数>`。

对象存储：

- 默认 `s3`（MinIO）。若 `docker pull minio/minio` 受网络限制，可先以内存实现跑通全流程：
  `HUAGENT_OBJECT_STORE=memory uv run huagent-api`，此时下载地址为 `memory://…`，脚本只校验摘要、不实际下载；
- 需要真实预签名下载时启动 MinIO：`docker compose -f docker/compose.yaml up -d minio`，服务端用默认 s3 存储启动即可（首次上传会自动创建桶）。

提示：Windows PowerShell 5.1 控制台若显示中文乱码，先执行 `chcp 65001`；脚本文件必须保留 UTF-8 BOM（否则 5.1 会按 ANSI 解析导致语法错误）。
