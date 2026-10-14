# hu-agent

[![CI](https://github.com/CQ-Developer/hu-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/CQ-Developer/hu-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.14-blue.svg)](management/pyproject.toml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](app/package.json)

**Self-hosted enterprise agent platform**: a desktop client, a management server and an admin console —
built for teams that keep code, prompts and credentials inside their own network.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## What it does

- **Agent loop on the desktop** — multi-protocol model gateway (`openai-chat`, `openai-responses`,
  `anthropic-messages`), reasoning effort, retries, cancellation and automatic context compaction.
  Model keys never leave the device; providers are configured per user.
- **Sandboxed tools** — file read/write/edit, shell, search and guided questions. Operations inside the
  workspace run directly, everything outside asks for approval, sensitive paths (`~/.ssh`, `~/.aws`, …)
  are denied. Every decision is written to a local audit log.
- **Skills and MCP** — extend the agent with versioned skills (front matter + progressive disclosure) and
  MCP servers over stdio. Secrets go to the OS keychain, never to config files.
- **Marketplace with governance** — teams publish skill packages, approvals and publishing are audited,
  the server can hard-disable a resource (clients see the reason and stop using it) or revoke a version
  with a replacement.
- **Cloud sync** — whole-workspace snapshots with manual or scheduled sync, explicit conflict handling
  (never silently overwritten) and version restore with automatic backup.
- **Usage and cost insight** — token usage is reported without prompts, replies or file paths, rolled up
  hourly into daily tables and shown as charts with CSV export.
- **Enterprise identity and lifecycle** — OIDC/SSO with PKCE, organizations, teams, RBAC, invitation and
  approval workflows, audit trail, self-service data export and account deletion with a 30-day PII purge
  grace period.
- **Operations ready** — Prometheus metrics with ready-to-use alert rules, structured logs with
  `X-Trace-Id`, background jobs for aggregation, retention and cleanup, and a redacted diagnostics bundle
  that users can attach to an issue.

## Quick start (3 steps, ~5 minutes)

Requirements: Docker with Compose v2. Node is only needed if you also want to run the client and the
admin console locally.

```bash
git clone https://github.com/CQ-Developer/hu-agent.git && cd hu-agent
scripts/quickstart.sh up --email you@example.com   # generates secrets, starts the stack, migrates, creates the first admin
```

```bash
# Optional: admin console
cd management-ui && npm ci && npm run dev          # http://localhost:5173
# Optional: desktop client
cd app && npm ci && npm run dev                    # server URL: http://127.0.0.1:8080
```

`quickstart.sh` writes `.env.quickstart` (random secrets, already gitignored — keep it safe) and prints
the first administrator password **once**. `HUAGENT_JWT_SECRET` and `HUAGENT_MASTER_KEY` are mandatory
for any non-`local` environment; the server refuses to start without them.

Next steps: [docs/validation.md](docs/validation.md) is the self-validation checklist, and
[docs/delivery/](docs/delivery/) covers deployment, operations, monitoring, performance and signing.

## Components

| Path | Component | Stack |
| --- | --- | --- |
| `app/` | Desktop client | Electron + TypeScript + React |
| `management/` | Server (API + worker) | Python 3.14 + FastAPI + SQLAlchemy 2 + PostgreSQL 18 (uv) |
| `management-ui/` | Admin console | Vite + React + Ant Design |

## Documentation

- [docs/design.md](docs/design.md) — design baseline (interfaces, data model, security model)
- [docs/plan.md](docs/plan.md) — delivery plan, acceptance criteria and deferred items
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/delivery/](docs/delivery/) — deployment, operations, monitoring, performance, signing, release notes
- [docs/validation.md](docs/validation.md) — self-validation checklist for adopters
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, checks, PR process
- [SECURITY.md](SECURITY.md) — private vulnerability reporting and supported versions
- [CHANGELOG.en.md](CHANGELOG.en.md) / [CHANGELOG.md](CHANGELOG.md) — English / Chinese changelogs

> Discipline for contributors: any change to design or decisions must update `docs/` in the same commit
> (see appendix F of `docs/plan.md`).

## Status

`v0.1.0` is the first public release: the three components are released together under Apache-2.0.
CI runs lint, type checks, unit tests, PostgreSQL integration tests, dependency and static analysis, and
an end-to-end job against real S3 and a real identity provider (Keycloak) on every push.

Delivered: client (agent loop, tools, skills, MCP, marketplace, sync, usage, i18n), server
(auth/SSO, orgs/teams/RBAC, approvals, marketplace, sync, statistics, audit, data lifecycle,
metrics) and admin console (approvals, skill governance, members, identity providers, statistics,
audit log, system settings).

Known limitations are listed in section 5 of [docs/delivery/release-notes.md](docs/delivery/release-notes.md)
(admin user management page, installer signing, monitoring integration, staging performance re-test,
email channel, MCP http/sse and MCP marketplace, macOS verification on real hardware).

## Contributing and license

Issues and pull requests are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first, and report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

Released under the [Apache-2.0 license](LICENSE). Copyright 2026 CQ-Developer.
