# `ibid-service` — Implementation Plan

**Status:** ready for a separate-context agent when triggered (roadmap 6.12 is deferred on a divergence-bug / new-consumer / OSS-decision signal).
**Spec:** `ibid-service-SPEC.md` (this directory, v0.1, 2026-04-19).
**Authorship rules:** `ibid-service-AUTHORSHIP.md` (append-only).

This plan is mechanical. The implementing agent follows steps in order. MUST NOT consult any prior-work source (aside from what's explicitly shared out-of-band for deployment-shape reference).

---

## Phase 0 — Repo bootstrap

**Estimate:** 8K tok_out, 15 calls, ≤ 45m.

1. `mkdir -p ~/Projects/ibid-service && cd ~/Projects/ibid-service`
2. `git init`. Default branch `main`. Remote `git@github.com:bwthomas/ibid-service.git` (public, MIT, matching `@bwthomas/ibid`).
3. Move the three spec files from `~/Documents/Claude/Specs/` into the repo root:
   - `ibid-service-SPEC.md` → `SPEC.md`
   - `ibid-service-AUTHORSHIP.md` → `AUTHORSHIP.md`
   - `ibid-service-IMPLEMENTATION-PLAN.md` → `IMPLEMENTATION-PLAN.md`
4. Append an entry to `AUTHORSHIP.md` documenting the move.
5. Create `.gitignore`: `node_modules`, `dist`, `*.log`, `.DS_Store`.
6. Create `package.json`:
   - `name: "ibid-service"` (unscoped — not published to npm; consumers pull the Docker image or git clone).
   - `private: true` (not published to npm).
   - `type: "module"`.
   - `engines: { node: ">=18" }`.
   - `dependencies`: `fastify`, `@bwthomas/ibid@^0.1.0`, `pino`, `pino-pretty` (dev-only via opts), `lru-cache`.
   - `devDependencies`: `typescript`, `tsup`, `vitest`, `@types/node`, `@fastify/type-provider-typebox` OR `zod` (body schemas).
   - Scripts: `build`, `test`, `typecheck`, `ci`, `dev` (`node --watch dist/server.js` after a watch-build), `start` (`node dist/server.js`).
7. Add `tsconfig.json` — strict, ES2022, moduleResolution `bundler`, no emit.
8. Add `tsup.config.ts` — entries `src/server.ts`. Format ESM only (Fastify + Node 18 ESM target).
9. First commit: `chore: init toolchain`. Message includes spec attribution.

---

## Phase 1 — Route scaffolding

**Estimate:** 10K tok_out, 20 calls, ≤ 1h.

### 1.1 `src/server.ts`
- Construct Fastify instance with pino logger (stdout JSON).
- Register body-parser with 2MB limit.
- Register auth hook: checks `X-Ibid-Auth` header against `IBID_SERVICE_AUTH` env var (constant-time compare). `/health` excluded.
- Register request-id hook: generates short uuid per request; attaches to logger child.
- Register metric hook: counts requests by endpoint + status; records duration histogram.
- Wire all 9 routes (§4 of SPEC). Each route imports its handler from `src/routes/`.
- Start listening on `PORT || 3000`.
- Graceful shutdown: SIGTERM → close server with 10s grace.

### 1.2 `src/routes/extract.ts` — `POST /extract`
- Validate body shape by `kind` discriminator (use zod or typebox).
- Call `ibid.extract(body)`.
- Return the result as-is. Log one `requestCompleted` line with strategyName, confidence, durationMs.

### 1.3 `src/routes/normalize.ts` — `POST /normalize`
- Validate `{ csl: object }`.
- Call `ibid.merge({ csl: {}, ...empty }, { csl: body.csl, ...})` then post-process → actually a simpler call: create a trivial helper `normalizeCsl(csl, ibid)` that runs `filterFieldsByType`, then post-process rules.

### 1.4 `src/routes/parse-ris.ts`, `parse-easybib.ts`, `upgrade-bib.ts`, `parse-authors.ts`, `parse-date.ts`
- Each validates its body and calls the package's corresponding function.
- Returns `{ ... , warnings: [] }`.

### 1.5 `src/routes/health.ts` — `GET /health`
- No auth.
- Returns `{ ok: true, version, ibidVersion, uptimeSeconds }`.

### 1.6 `src/routes/metrics.ts` — `GET /metrics`
- Auth required.
- Renders accumulated prom-style counters + histograms.
- Use `prom-client` library (small, well-known).

Commit: one per route (or bundle all in one "route scaffolding" commit).

---

## Phase 2 — Cache and budget

**Estimate:** 10K tok_out, 20 calls, ≤ 1h.

### 2.1 `src/cache.ts`
- Wrap `lru-cache` with a `CacheAdapter` interface matching the package SPEC §10.
- Key format: `ibid:v1:{doi||canonical_url||isbn}`.
- Passed to `createIbid({ cache })` during server startup.
- TTL: 24h per entry.

### 2.2 `src/upstream-budget.ts`
- Token-bucket per upstream (CrossRef, Citoid, OpenLibrary).
- Buckets: crossref 50/s, citoid 30/s, openlibrary 20/s (per §6).
- Exposed as Fastify hook that intercepts `/extract` and returns 429 early if all relevant buckets are empty (heuristic: DOI input → requires CrossRef bucket; URL input → requires Citoid).

### 2.3 `src/metrics.ts`
- prom-client registry with counters per §4.9.
- Incremented by hooks + strategy-outcome subscribers (the package emits events via logger; parse those).

Commit: 3 files, 1-2 commits.

---

## Phase 3 — LLM adapter wiring (optional path)

**Estimate:** 5K tok_out, 10 calls, ≤ 30m.

If `IBID_LLM_ANTHROPIC_API_KEY` is set at startup, construct the Anthropic LLM adapter via `@bwthomas/ibid/llm-anthropic` and pass it to `createIbid({ llm, ... })`. Otherwise omit.

Model default: `claude-haiku-4-5-20251001` (cheap + fast). Override via `IBID_LLM_ANTHROPIC_MODEL`.

Commit: 1 small commit.

---

## Phase 4 — Tests

**Estimate:** 15K tok_out, 30 calls, ≤ 1h 30m.

### 4.1 Unit tests (route-level)
- Each route's happy path.
- Each route's 401 on missing auth (except /health).
- Each route's 400 on malformed body (one case per validation branch).
- /extract's 429 on budget exhaustion.

### 4.2 Integration tests (service + real package, no network)
- Mock the package's HTTP clients (crossref/citoid/openlibrary) via `fetchFn` override.
- `/extract` with `{kind: 'html', ...}` → full pipeline executes against stub DOM adapter + mocked fetch.
- Cache: two identical requests → second is instant (detectable via `X-Ibid-Cache: hit` test header).

### 4.3 End-to-end (opt-in)
- `IBID_E2E=1 npm run test:e2e` — hits real CrossRef and Citoid.
- Skip in CI; run manually during load testing.

Commit: one per test file (or bundle).

---

## Phase 5 — Dockerfile + docker-compose + HAProxy route

**Estimate:** 6K tok_out, 10 calls, ≤ 30m.

### 5.1 `Dockerfile`
- Use the Dockerfile in SPEC §10.1 verbatim.
- Build with `npm ci --omit=dev`.
- Run as non-root `node` user.
- Healthcheck via wget on `/health`.

### 5.2 `docker-compose.yml` (repo-local dev stack)
- Single service `ibid`.
- Binds `.` into `/app` for development.
- Env var `IBID_SERVICE_AUTH: dev-secret-32chars-at-least-please...`.
- Exposes 3000.

### 5.3 Downstream-consumer integration checklist
- Provide an `INTEGRATION.md` at the repo root enumerating what a downstream consumer needs to wire: a docker-compose service entry, a reverse-proxy route (`/api/ibid/*` typical), a dev auth secret, and the `X-Ibid-Auth` header on outbound calls.
- Keep consumer-specific config (service hostname, secret management, auth integration) out of this repo — the integration doc is a checklist, not a set of committed overrides.

Commit: 2-3 commits (Dockerfile, compose, INTEGRATION.md).

---

## Phase 6 — Rails + Java client migration (deferred to 6.12.b)

**Estimate:** per roadmap, ~40K tok_out, ~2h.

Out of scope for the initial service build. When triggered:

### 6.1 Ruby client
- New Ruby class `Citation::IbidServiceClient` — thin HTTParty wrapper.
- Method parity: `extract_from_url`, `extract_from_doi`, `parse_ris`, `upgrade_bib`, `normalize`, `parse_authors`, `parse_date`.
- Mirror-mode flag in config — when on, Ruby calls both its old path and `IbidServiceClient` and logs divergence.

### 6.2 Java client
- New Java class `com.host-app.citation.IbidServiceClient` — wraps `HttpClient`.
- Methods: `extractFromDoi`, `extractFromUrl`, `normalize`.

### 6.3 Divergence logger
- A small service (or a Rails rake task) consuming the mirror logs, counting divergences by field, and alerting when a specific field diverges on >1% of records over 1h.

---

## Totals (phases 0–5; 6 is deferred)

| Phase | Tokens out | Calls | ≤ Wall |
|---|---:|---:|---:|
| 0 — Tooling | 8K | 15 | 45m |
| 1 — Routes | 10K | 20 | 1h |
| 2 — Cache + budget | 10K | 20 | 1h |
| 3 — LLM adapter | 5K | 10 | 30m |
| 4 — Tests | 15K | 30 | 1h 30m |
| 5 — Docker/HAProxy | 6K | 10 | 30m |
| **Subtotal (service only)** | **54K** | **105** | **~5h 15m** |
| 6 — Rails+Java migration | 40K | ~100 | 2h |
| **Total w/ migration (6.12 roadmap)** | **~94K** | **~205** | **~7h 15m** |

Realistic actual (speedup pattern): **1–3h** wall clock.

Roadmap 6.12 estimate was 77K / ≤6h 25m. This plan runs 54K for the service alone + 40K for migration, for 94K / ≤7h 15m. Close enough; bigger divergence is that the deepening analysis included Rails+Java client migration in the 77K number.

---

## Agent briefing (copy into the implementation-agent prompt)

> You are implementing `ibid-service@0.1.0`. Spec at `SPEC.md`. Plan at `IMPLEMENTATION-PLAN.md`. You depend on `@bwthomas/ibid@^0.2.0` as an npm dependency and may read its published types. Deployment follows a standard thin-HTTP-wrapper pattern (Fastify on Node 18, Docker, reverse-proxy, container orchestrator). Do not read any prior-work source beyond what is explicitly shared with you.
>
> First commit message: `Spec: SPEC.md v0.1 — see AUTHORSHIP.md for attribution.`
>
> Commit after every coherent unit (one per route file, one per test file, one for the Dockerfile). Push to `git@github.com:bwthomas/ibid-service.git`. Append `AUTHORSHIP.md` when complete with implementer, date, and commit range only. Full provenance detail is maintained privately.

---

## Deferred decisions

1. **gRPC vs HTTP JSON:** JSON in v0.1. Revisit if Java callers report overhead.
2. **Multi-instance cache coordination:** none in v0.1 (per-instance LRU). Revisit if cache-miss rate on the load test exceeds 40%.
3. **Per-caller rate limiting:** none in v0.1. Add if a misbehaving caller appears.
4. **Mirror-mode divergence ingestion:** see Phase 6. Don't build in v0.1.
