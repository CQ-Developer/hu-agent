# Contributing

Thanks for considering a contribution to hu-agent. The project is released under
[Apache-2.0](LICENSE); by contributing you agree that your work is distributed under the same license.

> 中文版见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## Read this first

- [docs/design.md](docs/design.md) — design baseline (architecture, interfaces, data model, security model).
- [docs/plan.md](docs/plan.md) — delivery plan and acceptance criteria. **Appendix F is a hard rule**:
  any change to design or decisions must update `docs/` (design, plan, OpenAPI, DDL, ADRs) in the same
  commit; code that contradicts the docs counts as incomplete.
- [docs/adr/](docs/adr/) — architecture decision records. To change an existing decision, add a new ADR
  instead of editing the conclusion.
- [docs/validation.md](docs/validation.md) — self-validation checklist; run it before opening a PR.

## Development setup

Requirements: Python 3.14, [uv](https://docs.astral.sh/uv/), Node ≥ 20, Docker (for integration tests and
the local dependency stack).

```bash
# Dependency services (PostgreSQL 18 / Redis / MinIO (built from source) / Keycloak / Mailpit)
scripts/dev-deps.sh up

# Server: apply DDL, then run API and worker
cd management && uv sync --frozen
uv run huagent-admin db-migrate
uv run huagent-admin create-admin --email you@example.com    # first administrator (password printed once)
uv run huagent-api        # http://127.0.0.1:8080
uv run huagent-worker     # second terminal
# Background dev processes: write output to the repo-root logs/ (git-ignored), e.g.
#   mkdir -p logs && (cd management && uv run huagent-api > ../logs/huagent-api.log 2>&1 &)

# Desktop client
cd app && npm ci && npm run dev

# Admin console
cd management-ui && npm ci && npm run dev                    # http://localhost:5173
```

Just want to run it (no development): `scripts/quickstart.sh up --email you@example.com`.

## Checks that must pass before you push (same as CI)

```bash
bash scripts/check-all.sh                       # server lint/mypy/pytest + client + console
bash scripts/security-scan.sh                   # dependency and static analysis (pip-audit / bandit / npm audit)
HUAGENT_TESTCONTAINERS=1 uv run --project management pytest -m integration -q   # real PostgreSQL
cd app && CLOUD_E2E=1 MARKET_E2E=1 SYNC_E2E=1 STATS_E2E=1 npx vitest run tests/integration
```

Changed a server interface?

```bash
cd management && uv run python scripts/export_openapi.py    # regenerate openapi/openapi.json
cd ../management-ui && npm run api:gen                      # regenerate console types (npm run check verifies)
```

## File naming

Use **underscores** in file names (`read_file.ts`, `pi_governance.ts`, `run_turn.py`), matching the
Python side of the monorepo. Kebab-case names are legacy in the client and are being renamed as the
files they live in get touched; do not add new kebab-case files.

## Coding guidelines (summary)

- **No unnecessary dependencies.** Prefer the standard library and what is already vendored; a new
  runtime dependency needs a reason and an impact note in the PR.
- **Small, focused units.** One function or module does one thing, composed through clear interfaces.
  Avoid over-engineering.
- **Comments explain intent** — not what the code says, but why it is done this way.
- **Secure defaults.** Validate path, ZIP, token and SQL boundaries explicitly. Never log tokens,
  secrets, prompts or file paths.
- **Internationalization.** All user-visible strings in the client and console go through `t()`
  (the Chinese source string is the message key). Model-facing prompts stay single-language.
- **Tests.** New behaviour comes with tests (unit or integration). Bug fixes start with a test that
  reproduces the issue.

## Real-call verification (local only)

Most tests run without network access. To verify the model layer against a real OpenAI-compatible
endpoint (including the custom-provider path used by enterprise gateways), set:

```bash
export PI_E2E=1
export PI_GATEWAY_BASE_URL=https://your-gateway.example.com/v1
export PI_GATEWAY_API_KEY=...          # from your local secret store, never committed
npx vitest run tests/integration/pi-real.test.ts
```

Rules for this suite:

- **Never** commit endpoints, keys or account-specific model lists; they come from the environment only.
- The suite is pinned to a single, inexpensive model (`deepseek-v4.1-flash`); do not add other models.
- Keys live in the OS keychain / an untracked local config file. If a key ever lands in a commit,
  rotate it first, then clean up the history.

## Pull request process

1. Fork, then branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep commits small; use [Conventional Commits](https://www.conventionalcommits.org/) style
   (`feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`) and explain the motivation in the body.
3. Make sure the checks above pass; update `docs/` in the same commit when design or interfaces change.
4. The PR description should cover: what changed, why, how it was verified (commands and results) and
   the impact (compatibility, migration, security).
5. Reviewers focus on security boundaries, data lifecycle, backward compatibility, i18n and doc sync.

## Release process (maintainers)

1. Update `CHANGELOG.md` (Chinese) and `CHANGELOG.en.md` (English — release notes are generated from it):
   move entries from `Unreleased` into the new version, and update the known limitations in
   `docs/delivery/release-notes.md`.
2. Verify locally: `bash scripts/check-all.sh` + `bash scripts/security-scan.sh`, and walk through
   `docs/validation.md`.
3. Tag and push: `git tag v0.1.0 && git push origin v0.1.0` — this triggers
   `.github/workflows/release.yml`: verify → build Windows/macOS installers (unsigned) + SHA256 →
   **draft** release for review.
4. Review the draft (checksums, assets, notes) and publish. Never rewrite a published tag; roll forward
   with a new version instead.

## Reporting issues

- Bugs and feature requests: GitHub Issues (include version, deployment shape, reproduction steps;
  attach the `X-Trace-Id` for server issues and the diagnostics bundle for client issues).
- Security vulnerabilities: **do not open a public issue** — report privately as described in
  [SECURITY.md](SECURITY.md).

## Code of conduct

Participation in this project means agreeing to the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
