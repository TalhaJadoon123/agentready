# Security

Reporting a vulnerability: open a private security advisory on the repository,
or email the maintainer. Please do not open a public issue for an
unfixed vulnerability.

## Security posture

This project fetches URLs supplied by callers, so the controls below are
load-bearing rather than decorative.

### SSRF guard

`scanSite` refuses to fetch private infrastructure. Implemented in
`packages/shared/src/ssrf.ts`.

Blocked by default:

- loopback (`127.0.0.0/8`, `::1`) and all loopback hostnames
- RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- link-local (`169.254/16`, `fe80::/10`) — includes cloud metadata
- CGNAT (`100.64/10`), reserved, multicast, TEST-NET, IETF assignments
- IPv6 unique-local (`fc00::/7`) and IPv4-mapped forms (`::ffff:127.0.0.1`)
- non-http(s) schemes (`file:`, `gopher:`, …)

Specific metadata endpoints (`169.254.169.254`, `169.254.170.2`,
`100.100.100.200`, `fd00:ec2::254`) stay blocked **even when private ranges are
allowed**, because they hand out credentials.

DNS is resolved and every returned address is checked, so a public hostname that
resolves into a private range is rejected. Redirects are followed manually so
each hop is re-validated — a public URL cannot 302 into the metadata service.

Opt in only when you intend to scan your own infrastructure:

```bash
AGENTREADY_ALLOW_PRIVATE_FETCH=true
```

### Authentication

- API tokens are HMAC-SHA256 signed and compared in constant time.
- Expired, tampered, or wrongly-signed tokens are rejected.
- A caller who presents credentials that fail verification is **rejected** —
  never silently downgraded to a shared development principal.
- Unauthenticated access is off unless `AGENTREADY_DEV_AUTH=true` is set
  explicitly, and even then resolves to a **free-plan** user so local behaviour
  matches production limits.

Generate a secret with:

```bash
openssl rand -base64 32
```

### Known gaps — not yet implemented

These are stated plainly rather than implied:

- **No rate limiting on the API surface.** The scanner enforces per-host
  politeness, but there is no per-IP request limiter in front of the endpoints.
  Put one at the edge (Cloudflare rate-limiting rules) before exposing publicly.
- **No security response headers** on API responses (HSTS, CSP, X-Frame-Options).
  The web server sets `X-Content-Type-Options`; the API does not.
- **No account lockout or brute-force protection.** Not applicable yet — there is
  no login endpoint.
- **Dependencies are not continuously scanned.** There is no CI, so no
  automated `npm audit` / Dependabot. Run `bun pm ls` and audit manually.
- **CORS** defaults to `WEB_ORIGIN`. Set it explicitly; do not deploy with the
  localhost default.

### Dependency posture

The project has **zero runtime dependencies**. Dev dependencies are limited to
`typescript`, `vitest`, `@vitest/coverage-v8` and `@types/node`. This is the
primary reason the supply-chain surface is small.

### Data handling

- No PII is collected. The store holds URLs, scan results and API keys for
  operators.
- Scans of a site fetch its public pages. Point the scanner only at sites you
  are authorised to scan.
- The Supabase schema ships with row-level security enabled so a leaked anon key
  cannot read another tenant's scans.