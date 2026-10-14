# Security policy

> 中文版见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## Supported versions

| Version | Support |
| --- | --- |
| `0.1.x` (current) | Vulnerability reports accepted and handled per the timelines below |
| Older or untagged snapshots | Not recommended for production; upgrade first |

Deployment hardening baseline: see [docs/delivery/deployment.md](docs/delivery/deployment.md).
You must provide `HUAGENT_JWT_SECRET` and `HUAGENT_MASTER_KEY` yourself (the server refuses to start
without them outside `local`), terminate TLS, scope object storage to least privilege and keep
`HUAGENT_RATE_LIMIT_STRICT` enabled.

## Reporting a vulnerability privately

Use GitHub Security Advisories (repository → Security → *Report a vulnerability*), or email the
maintainer if advisories are unavailable (address on the repository profile).

Please include:

- affected version/commit and deployment shape (containers or bare metal, SSO enabled or not);
- reproduction steps or a minimal proof of concept (no real user data or production secrets);
- your impact assessment (privilege escalation, data exposure, RCE, denial of service, …) and contact;
- any mitigation you already know of.

## Our timelines (best effort)

| Stage | Target |
| --- | --- |
| Acknowledgement | within 3 business days |
| Initial assessment and severity | within 7 business days |
| Fix or mitigation guidance | within 30 days for severe issues |
| Public disclosure | coordinated with the reporter; credited in CHANGELOG and release notes after the fix (anonymously on request) |

## In scope

**Vulnerabilities**: authentication or authorization bypass, access to another tenant's or user's data,
SSRF or path traversal, injection, token or secret disclosure, archive-parsing issues (zip traversal,
bombs, backslash smuggling), audit bypass, missing rate limiting that enables credential stuffing.

**Not vulnerabilities** (please open a regular issue):

- attacks that require root/administrator access to the host already;
- deployment misconfiguration such as missing TLS, sample secrets left in place, or exposing the service
  directly to the internet;
- local files of a workspace being readable by other users of the same machine (they are user data and
  rely on OS permissions);
- pre-existing CVEs in dependencies — check `scripts/security-scan.sh` and the recorded exemptions in
  [docs/delivery/security-review.md](docs/delivery/security-review.md) first. If the advisory is
  genuinely exploitable in our usage, report it with the attack path.

## Hardening recommendations for operators

1. Never expose the database, Redis or object storage to the internet; only the API should be reachable,
   behind a TLS reverse proxy.
2. Run `bash scripts/security-scan.sh` regularly and watch the `security` job of GitHub Actions.
3. Retain audit records (`audit_logs`) according to your policy; handle data subject requests as
   described in section 4.1 of [docs/delivery/operations.md](docs/delivery/operations.md).
4. In production, enable SSO and disable self-service registration
   (`HUAGENT_AUTH_REGISTRATION_ENABLED=false`).
5. Apply the alert rules from [docs/delivery/monitoring.md](docs/delivery/monitoring.md) to watch login
   failures, 5xx rates and worker job freshness.
