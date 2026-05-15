---
name: citare-service
version_spec_applies_to: 0.1.0
spec_status: draft
spec_date: 2026-04-19
inspired_by: a standard thin-HTTP-wrapper pattern (Fastify on Node 18, Docker, HAProxy, ECS) common to internal npm-package-backing services.
depends_on_spec: SPEC.md (v0.1) for the `citare` package
---

# citare-service — HTTP wrapper specification

**Service:** `citare-service`
**Target version:** `0.1.0`
**Language:** TypeScript, Node 18+.
**Framework:** Fastify.
**Deployment:** Docker container, HAProxy route, ECS task. Mirrors the `y-websocket` deployment shape exactly (zero-incremental ops for the on-call team).
**Depends on:** `citare@^0.1.0` as a first-party npm dependency.

This document specifies **behavior only**. It is the authoritative contract. The implementation agent should read this document + the `citare` package SPEC.md and produce a working service without consulting any prior work.

---

## 1. Purpose

Expose the `citare` package's pure-function API over HTTP so non-TypeScript consumers (Ruby, Java, toolbars in browser runtimes without the npm dependency, etc.) can call a single source of truth for citation extraction. Eliminates cross-runtime duplication of extraction logic.

---

## 2. Non-goals (explicit exclusions from v0.1)

- **Citation rendering.** Same boundary as the package.
- **User authentication beyond a shared-secret header.** This is an internal-network service; no JWT, no OAuth, no per-user scoping.
- **Persistent cache.** The service holds in-memory LRU only; persistent cache remains in the calling Rails/Java layer.
- **LLM access.** v0.1 ships without an LLM adapter configured. Enable by env var in a follow-up.
- **Multi-tenant isolation.** Single-tenant; all callers share the same cache and logger.
- **Websocket/streaming.** HTTP POST only. No long-lived connections.

---

## 3. Architecture

```
Rails / Java / toolbar2 (browser via HAProxy)
          │ HTTPS POST, JSON
          ▼
     HAProxy (port 443)
          │ route: /ws/citare/*  OR /api/citare/*
          ▼
   citare-service (Fastify, Node 18)
     ├── in-memory LRU cache (bounded)
     ├── citare client
     └── structured logger (pino) → STDOUT → CloudWatch
          │ outbound
          ▼
   CrossRef · Citoid · OpenLibrary (external)
```

The service is stateless across restarts. The in-memory cache is best-effort; on restart it starts empty.

---

## 4. Endpoints

All endpoints require the header `X-Citare-Auth: <shared_secret>`. Secret is a 32+ char random string from the service's environment (`CITARE_SERVICE_AUTH`). Missing/bad header → `401`.

All endpoints accept `Content-Type: application/json` unless otherwise specified. Responses are `application/json`.

### 4.1 `POST /extract`

**Body:** matches `ExtractInput` from the package SPEC §5.1.

```json
{"kind": "url", "url": "https://example.com/paper"}
{"kind": "html", "html": "<html>...</html>", "url": "https://example.com/paper"}
{"kind": "doi", "doi": "10.1056/NEJMoa2034577"}
{"kind": "isbn", "isbn": "9780140449136"}
{"kind": "ris", "text": "TY  - JOUR\nAU  - ...\nER  -"}
{"kind": "easybib", "payload": {...}}
{"kind": "text", "text": "...", "hints": {...}}
```

**Response:** `ExtractionResult` from the package SPEC §5.2.

```json
{
  "csl": { "type": "article-journal", "title": "...", ... },
  "confidence": 78,
  "strategyName": "CrossRefDoi+Highwire",
  "fieldConfidence": { "title": 85, ... },
  "provenance": { ... },
  "warnings": []
}
```

**Status codes:**
- 200 on success (even if confidence is 0 — no-metadata is not a server error).
- 400 on malformed body (JSON parse fail, unknown `kind`, missing required field for the kind).
- 401 on missing/bad auth header.
- 429 if the service's upstream-budget guard trips (§6).
- 500 on unexpected internal error (bug in service or package).

### 4.2 `POST /normalize`

Normalize an already-CSL item: apply post-processing rules (SPEC §6.14), `filterFieldsByType`, and `canonicalizeUrl` on any URL field. Useful for Rails to clean up Ruby-authored CSL before storage.

**Body:**
```json
{"csl": {"type": "article-journal", "title": "  foo  ", "URL": "HTTPS://X.COM/?utm_source=y"}}
```

**Response:**
```json
{"csl": {"type": "article-journal", "title": "foo", "URL": "https://x.com/"}, "warnings": []}
```

### 4.3 `POST /parse-ris`

Thin wrapper over `client.parseRis(text)`. Used by Rails's `/api/citations/ris_to_csl` replacement path.

**Body:**
```json
{"text": "TY  - JOUR\nAU  - Smith, J.\nER  -"}
```

**Response:**
```json
{"csl": {"type": "article-journal", "author": [{"family": "Smith", "given": "J."}]}, "warnings": []}
```

### 4.4 `POST /parse-easybib`

Thin wrapper over `client.parseEasyBib(payload)`.

**Body:**
```json
{"payload": {...any EasyBib shape...}}
```

**Response:**
```json
{"csl": {...}, "warnings": []}
```

### 4.5 `POST /upgrade-bib`

Thin wrapper over `client.upgradeLegacyBib(legacy)` for consumers migrating from pre-CSL legacy bibliography formats.

**Body:** a `LegacyBibHash` object (see package SPEC §6.10 for the shape).

**Response:**
```json
{"csl": {...csl-1.0.2...}, "warnings": []}
```

### 4.6 `POST /parse-authors`

**Body:**
```json
{"raw": "Smith, J. and Doe, J."}
```

**Response:**
```json
{"authors": [{"family":"Smith","given":"J."},{"family":"Doe","given":"J."}], "warnings": []}
```

### 4.7 `POST /parse-date`

**Body:**
```json
{"raw": "Summer 2020"}
```

**Response:**
```json
{"date": {"date-parts":[[2020]], "season": 2}, "warnings": []}
```

### 4.8 `GET /health`

**Response:**
```json
{"ok": true, "version": "0.1.0", "citareVersion": "0.1.0", "uptimeSeconds": 12345}
```

No auth required on `/health` (HAProxy healthchecks).

### 4.9 `GET /metrics`

Prometheus text format. Exposes:
- `citare_requests_total{endpoint, status}` — counter
- `citare_request_duration_ms_bucket{endpoint, le}` — histogram
- `citare_strategy_runs_total{strategy, outcome}` — counter (from package provenance)
- `citare_upstream_calls_total{upstream, status}` — counter (crossref, citoid, openlibrary)
- `citare_cache_hits_total` / `citare_cache_misses_total`

Auth required (same `X-Citare-Auth` header) to prevent internet-facing metrics leakage if the reverse-proxy misconfigures. The scrape job configures the secret.

---

## 5. Request / response conventions

- **All request bodies are JSON.** No form-urlencoded, no multipart.
- **Max body size:** 2 MB (HTML inputs can be large; cap protects memory).
- **Idempotency:** All POST endpoints are idempotent. Safe to retry with same body.
- **Timeout:** Server-side per-request timeout = 10s. If a strategy inside the package takes longer, the service returns 200 with `confidence: 0` and a warning `"upstream timeout"` rather than 504 — the caller always gets a structured response.
- **No cookies.** The service does not emit or accept cookies.

---

## 6. Rate limiting and upstream budget

The service has a per-upstream budget to protect CrossRef / Citoid from runaway callers:

| Upstream | Policy |
|---|---|
| CrossRef | 30 req/s burst, 50 req/s sustained (polite pool) |
| Citoid | 20 req/s burst, 30 req/s sustained |
| OpenLibrary | 10 req/s burst, 20 req/s sustained |

When a budget is exhausted, `/extract` returns 429 with `Retry-After: <seconds>`. Internal strategies that cannot reach their upstream because of budget exhaustion return `confidence: 0` with warning `"upstream budget exhausted"`.

Budget enforcement is per-service-instance (no Redis coordination in v0.1). With 2 ECS tasks behind HAProxy, total outbound rate = 2× per-instance. Caller-side caching reduces pressure much more than budget tuning.

No per-caller rate limit in v0.1. Internal callers are trusted; budget is upstream-protective only.

---

## 7. Configuration

All configuration via environment variables. No config file.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port inside container |
| `HOST` | `0.0.0.0` | Bind address |
| `CITARE_SERVICE_AUTH` | **required** | 32+ char shared secret |
| `CITARE_USER_AGENT` | `citare-service/0.1.0 (+https://github.com/bwthomas/citare-service)` | Passed to package `userAgent` |
| `CITARE_TIMEOUT_MS` | `5000` | Per-strategy timeout |
| `CITARE_CACHE_MAX` | `10000` | LRU cache max entries |
| `CITARE_LOG_LEVEL` | `info` | `trace|debug|info|warn|error|fatal` |
| `CITARE_CITOID_ENDPOINT` | `https://en.wikipedia.org/api/rest_v1/data/citation` | Override Citoid |
| `CITARE_CROSSREF_ENDPOINT` | `https://api.crossref.org` | Override CrossRef |
| `CITARE_LLM_ANTHROPIC_API_KEY` | unset | If set (and no AWS creds), register the Anthropic-direct `Llm` adapter |
| `CITARE_LLM_ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Anthropic-direct default model |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | If both set, register the AWS Bedrock `Llm` adapter (takes precedence over Anthropic when both are configured) |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` (fallback) | Bedrock region |
| `CITARE_LLM_BEDROCK_REGION` | unset | Override the AWS region for Bedrock only (leaves other AWS calls alone) |
| `CITARE_LLM_BEDROCK_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model ID (cross-region profile) |
| `AWS_SESSION_TOKEN` | unset | Optional STS session token; passed through to the Bedrock adapter |
| `CITARE_LLM_FREETEXT_MIN_SCORE` / `_MIN_OVERLAP` / `_MAX_CANDIDATES` / `_MAX_TOKENS` / `_TEMPERATURE` | unset | Tune the `CrossRefFreetext` LLM rescue thresholds (see citare SPEC §8.1.2) |

Missing required env var → fail-fast at startup with a clear error (not a generic `undefined`).

---

## 8. Logging

- Structured JSON via `pino`. One log line per request (`requestCompleted`) at INFO level, including: endpoint, status, durationMs, bytesIn, bytesOut, strategyName (for /extract), confidence (for /extract), upstreamCalls count.
- Strategy-level warnings from the package surface as INFO logs with `category: 'citare-strategy'`.
- Errors (programmer errors from the package, upstream 5xx, JSON parse fail) log at WARN or ERROR with stack trace if available.
- Secrets (`CITARE_SERVICE_AUTH`, `CITARE_LLM_*_API_KEY`) never appear in logs. The pino serializer strips them.

---

## 9. Cache

In-memory LRU, bounded by `CITARE_CACHE_MAX` entries (default 10K). Keys match the package's cache-key format (`citare:v1:{doi|canonical_url|isbn}`).

- TTL: 24 hours. After TTL, entry is evicted and next request re-computes.
- `pipelineVersion` invalidation: if the package is upgraded (new `pipelineVersion`), cache entries from the old version are ignored on read and overwritten on write.
- No user-corrections path in the service cache; corrections are stored by Rails in its persistent `citation_cache` collection (roadmap item 6.16), not here.

The service's cache is a hot-path accelerator only. On container restart, cache starts empty; service still functions (just slower on first few requests per URL).

---

## 10. Deployment shape

### 10.1 Dockerfile

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O - http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

### 10.2 docker-compose (dev + prod pattern)

```yaml
services:
  citare:
    build: .
    image: bwthomas/citare-service:${CITARE_VERSION:-latest}
    environment:
      CITARE_SERVICE_AUTH: ${CITARE_SERVICE_AUTH}
      CITARE_USER_AGENT: "citare-service/0.1.0 (+https://github.com/bwthomas/citare-service)"
      # ...other env per §7
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/health"]
```

### 10.3 HAProxy route

Route `https://<host>/api/citare/*` to the citare backend. Strip `/api/citare` prefix; forward `/extract`, `/normalize`, etc. to the service. Preserve `X-Citare-Auth` header.

### 10.4 ECS task definition

Single container, 512 MB memory limit, 0.25 vCPU reserve. 2 tasks behind a reverse proxy / load balancer. Deploys follow the standard thin-Node-service pipeline (Docker build → image registry → task orchestrator rolling update).

### 10.5 Mirror-mode rollout (consumer-side pattern)

When a consumer migrates legacy citation logic to this service, the recommended rollout:

1. Deploy `citare-service` alongside existing citation logic.
2. The consumer calls both paths (old + new) in parallel on 1% of requests.
3. Compare results; log divergence to a separate stream.
4. After 7 days of low divergence, ramp to 10% → 50% → 100% read traffic.
5. Once 100% stable, remove the old code.

Mirror-mode implementation is caller-side; the service is not aware of mirroring.

---

## 11. Errors

| Scenario | Status | Body |
|---|---|---|
| Valid request, success | 200 | `ExtractionResult` / normalized body |
| Missing/bad auth | 401 | `{"error": "unauthorized"}` |
| Malformed JSON | 400 | `{"error": "malformed_json", "detail": "..."}` |
| Unknown `kind` | 400 | `{"error": "unknown_input_kind", "detail": "got {kind}, expected one of: url, html, ..."}` |
| Missing required field (e.g. `kind: doi` with no `doi`) | 400 | `{"error": "missing_field", "field": "doi"}` |
| Upstream budget exhausted | 429 | `{"error": "upstream_budget", "upstream": "crossref"}` + `Retry-After` |
| Internal server error | 500 | `{"error": "internal", "requestId": "..."}` |

Every 500 response includes a `requestId` for log correlation. Request IDs are generated per-request (short uuid) and included in every log line.

---

## 12. Test plan

### 12.1 Unit tests (service-level)

- Endpoint registration: every endpoint answers (happy path) + 401 on missing auth.
- Body validation: each endpoint's input-schema branches (missing fields, wrong types).
- Error mapping: internal throws → 500 with requestId; package's `InvalidArgumentError` → 400.

### 12.2 Integration tests (service + mocked package)

- `/extract` with stubbed package client returning various `ExtractionResult` shapes → response shape matches.
- Cache read path: two identical requests → second is served from cache (detectable via logs or a test-only header `X-Citare-Cache: hit|miss`).
- Upstream budget: simulate rapid-fire; assert 429.

### 12.3 End-to-end (opt-in)

- With real CrossRef endpoint: `/extract` with `{kind: 'doi', doi: '10.1000/...'}` returns a CSL item.
- With real Citoid: `/extract` with `{kind: 'url', url: 'https://en.wikipedia.org/wiki/Test'}` succeeds.

Default-off; gated by `CITARE_E2E=1`.

### 12.4 Load test

One-off (not in CI): 100 RPS sustained, 2× service instances, cache MISS forced (via query variation). Assert:
- p50 latency < 100ms for cache-hit.
- p99 latency < 1500ms for cache-miss w/o upstream (DOM strategies only).
- Zero memory leak over 1h (RSS stable).

---

## 13. Observability

- STDOUT logs → CloudWatch (same shape as y-websocket).
- Prometheus scraping via `/metrics`.
- Alarms (CloudWatch):
  - 5xx rate > 1% over 5 min → page on-call.
  - Latency p99 > 3000ms over 5 min → page on-call.
  - Cache hit rate < 20% over 1h → non-paging alert (indicates callers aren't caching and we should investigate).

---

## 14. Licensing

MIT. Same authorship rules as the package. See `AUTHORSHIP.md` alongside this spec.

---

## 15. Out-of-scope but worth capturing

- **Cross-region replication.** Single-region in v0.1. If CloudFront or multi-region ever matters, follow y-websocket's replication story.
- **GraphQL endpoint.** No. POST JSON is sufficient for internal callers.
- **gRPC.** No. HTTP JSON matches existing Ruby/Java patterns.
- **WebSocket streaming of multi-URL batch.** No. Callers batch in their own code.
