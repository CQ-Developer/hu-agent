# Changelog (English)

This is the English changelog used for GitHub Release notes.
The Chinese changelog lives in [CHANGELOG.md](CHANGELOG.md).

The project follows [Semantic Versioning](https://semver.org/) and the structure of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- One-command observability stack (`docker/compose.yaml` `monitoring` profile +
  `scripts/quickstart.sh` entrypoints): Prometheus (the 12 alert rules and 3 recording rules now ship
  with the repository), Grafana (4 provisioned dashboards: API golden signals, background jobs & data,
  authentication & SSO, logs), Alertmanager (email routing, delivered to the bundled Mailpit inbox by
  default; enterprise SMTP and webhooks documented) and optional Loki + Promtail log aggregation
  (`logs` profile).
- New metric `huagent_job_staleness_budget_seconds{job_id}`: how long a worker job may go without a
  successful run before it is considered stale, derived from its schedule (interval jobs: 3x period,
  minimum 15 minutes; daily cron jobs: 26 hours).
- Worker schedules consolidated into `worker/schedule.py` as the single source of truth for both the
  scheduler and the staleness budgets.

### Fixed

- `HuAgentWorkerJobStale` used a hard-coded 2 hour threshold, so daily cron jobs (partition
  maintenance, snapshot cleanup, PII purge, daily usage pruning) alerted continuously between runs;
  it now compares against each job's own budget.
- `prometheus.yml` was missing `alerting.alertmanagers`, so rules fired without ever sending a
  notification (found by triggering a real alert during verification).

## [0.1.0] - 2026-10-14

First public release: desktop client, server and admin console released together under Apache-2.0.

### Added

**Desktop client (`app/`)**
- Agent loop: multi-protocol model gateway (`openai-chat`, `openai-responses`, `anthropic-messages`),
  reasoning effort, retries, cancellation, context compaction at 70% of the window.
- Tools and sandbox: read / write / edit / shell / search / ask-guide; allow inside the workspace,
  ask when outside, deny sensitive paths; shell process-tree kill; approval cards
  (once / session / always) persisted to the workspace policy; audit trail in `.hu/logs/audit.jsonl`.
- Extensions: Skills (front-matter parsing, versioned directories, progressive disclosure in the
  system prompt) and MCP over stdio (JSON-RPC, lazy connect, idle reaping, crash reconnect,
  secrets stored in the OS keychain).
- Marketplace: browse / install (sha256 verified, safe extraction) / enable / uninstall, plus
  server-side status checks (hard disable and automatic restore).
- Cloud sync: whole-workspace snapshots, manual and scheduled (15m/30m/1h/6h/24h), three conflict
  options, backup before restore, version history.
- Usage statistics with CSV export; rotating file logs (10 MB x 5) and a redacted diagnostics bundle.
- Mandatory sign-in gate (no offline bypass) and full zh-CN / en-US localization.

**Server (`management/`)**
- Accounts and security: argon2id, JWT access tokens (15 min) with rotating refresh tokens
  (family replay detection), device revocation, login rate limiting (per-IP plus progressive
  account lockout), weak-password list.
- Organizations, teams and RBAC (invisible resources return 404), one-time invitations (7 days),
  approval workflows (org/team creation, Skill version publishing).
- Marketplace: upload validation (zip traversal, zip bombs, backslash smuggling, symlinks),
  version approval and publishing, delist, disable with mandatory reason, revoke with replacement,
  delete, trigram search, presigned downloads.
- Cloud sync: snapshot init/complete with streaming sha256, quota intersection, retention and
  pinning, background cleanup.
- Statistics: hourly rollup into daily tables with price snapshots; breakdowns by day, model,
  member, team and organization; activation details.
- SSO: OIDC with PKCE (HS256/RS256/ES256 and cached JWKS), JIT provisioning with email-domain
  allowlists, immediate session revocation when a provider is disabled.
- Data lifecycle: self-service data export, account deletion with a 30-day grace period before PII
  is purged (usage statistics stay anonymous), configurable retention windows.
- Observability: Prometheus metrics endpoint, structured logs with `X-Trace-Id`, worker job records
  with startup compensation.
- Audit trail for sign-in, approvals, resource governance and account operations.

**Admin console (`management-ui/`)**
- Sign-in (local accounts and OIDC PKCE), approvals, Skill review and lifecycle, members and
  invitations, identity provider management.
- Statistics with charts and CSV export, organization and team governance (freeze/dissolve),
  notification center, audit log, system settings and model price table.
- Bilingual UI; API types generated from OpenAPI (`npm run api:gen`) and verified in `npm run check`.

**Engineering and delivery**
- Monorepo, numbered DDL scripts (V0001-V0005 with rollbacks), five CI jobs including end-to-end
  runs against real S3 and a real IdP, dependency and static analysis scans, performance benchmark
  script, packaging and signing documentation, and a self-validation checklist for adopters.

### Known limitations

See section 5 of [docs/delivery/release-notes.md](docs/delivery/release-notes.md) (admin user
management page, installer signing, monitoring integration, staging performance re-test, email
channel, MCP http/sse and MCP marketplace, macOS verification on real hardware).
