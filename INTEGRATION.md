# Integrating `citare-service` into a downstream consumer

Minimal checklist for wiring this service into a Ruby / Java / Python /
browser app. Keep consumer-specific overrides in the consumer's own repo;
this doc just enumerates what needs to be in place.

## 1. Pick a deployment shape

- **Local dev**: `docker compose up` from this repo. Reachable at
  `http://localhost:3000`. Set `CITARE_SERVICE_AUTH` to any 16+ char string
  and pass the same value to callers as `X-Citare-Auth`.
- **Sidecar in a consumer's dev stack**: add a service entry to the
  consumer's `docker-compose.yml` referencing the published image
  (`bwthomas/citare-service:latest` when published; build locally otherwise).
- **Managed deploy**: build from this repo's Dockerfile; push to a registry;
  run 1+ tasks behind a reverse proxy (HAProxy, nginx, ELB). Health probe
  on `GET /health`.

## 2. Environment variables the consumer must set

| Var | Required | Notes |
|---|---|---|
| `CITARE_SERVICE_AUTH` | yes | 16+ char random secret. Shared with callers; they pass it as `X-Citare-Auth`. |
| `CITARE_USER_AGENT` | no | Default identifies this service; override to identify the consumer / its contact address for polite-pool upstreams (CrossRef). |
| `CITARE_LLM_ANTHROPIC_API_KEY` | no | Enables the LLM fallback strategy. Omit = no LLM calls. |
| `CITARE_LLM_ANTHROPIC_MODEL` | no | Defaults to `claude-haiku-4-5-20251001`. |
| `CITARE_TRANSLATION_SERVER_URL` | no | Root URL of a self-hosted Zotero translation-server. When set, the `TranslationServer` strategy fires for URL extractions and `CitoidUrl` is suppressed to avoid double-firing. Unset → Wikipedia Citoid continues to handle URL extractions. See §6 for the deploy-shape tradeoffs. |

Full env var catalog lives in `SPEC.md` §7.

## 3. Reverse-proxy route (typical)

Mount at `/api/citare/*` (or wherever the consumer prefers); strip prefix
before forwarding to the service.

HAProxy example:
```
acl citare_api path_beg /api/citare/
use_backend citare_backend if citare_api

backend citare_backend
    http-request set-path %[path,regsub(^/api/citare/,/)]
    server citare1 citare-service:3000 check
```

Nginx example:
```nginx
location /api/citare/ {
    proxy_pass http://citare-service:3000/;
    proxy_set_header X-Citare-Auth $http_x_citare_auth;
    proxy_read_timeout 15s;
}
```

## 4. Caller wiring

Every protected endpoint requires `X-Citare-Auth: <secret>`. Content-Type is
`application/json` for all request bodies.

Ruby (HTTParty):
```ruby
HTTParty.post(
  "#{ENV['CITARE_SERVICE_URL']}/extract",
  headers: {
    "Content-Type" => "application/json",
    "X-Citare-Auth" => ENV.fetch("CITARE_SERVICE_AUTH"),
  },
  body: { kind: "doi", doi: "10.1038/nature12373" }.to_json,
  timeout: 15,
)
```

Java (java.net.http):
```java
HttpClient client = HttpClient.newHttpClient();
HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create(System.getenv("CITARE_SERVICE_URL") + "/extract"))
    .header("Content-Type", "application/json")
    .header("X-Citare-Auth", System.getenv("CITARE_SERVICE_AUTH"))
    .POST(HttpRequest.BodyPublishers.ofString(
        "{\"kind\":\"doi\",\"doi\":\"10.1038/nature12373\"}"))
    .timeout(Duration.ofSeconds(15))
    .build();
HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
```

Browser fetch:
```js
const res = await fetch(`${citareUrl}/extract`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Citare-Auth": citareSecret,
  },
  body: JSON.stringify({ kind: "url", url: "https://example.com/x" }),
});
```

## 5. Response handling

Always JSON. Status codes:

- **200** — success. Body is an `ExtractionResult` per `citare`
  SPEC §5.2 (for `/extract`) or a `{csl, warnings}` shape for parsers.
- **400** — body validation failure. Inspect `issues` for zod details.
- **401** — missing or bad `X-Citare-Auth`.
- **429** — upstream rate limit (crossref / citoid / openlibrary). Respect
  `Retry-After` header.
- **500** — internal error. `requestId` is in the body for log correlation.

Empty results (`confidence: 0`, no fields) are **not** errors — the service
returns 200 with a stable shape so consumers can render / store uniformly.

## 6. URL-extraction backend choice

Two deploy shapes are supported for URL extraction:

### 6.1 Default — Wikipedia Citoid

Free public service; no extra infrastructure. Subject to Wikipedia's
Citoid rate limits, uptime, and whichever Zotero translators happen to
be deployed there. Fine for low-volume production and local development.

### 6.2 Optional — self-hosted Zotero translation-server sidecar

Set `CITARE_TRANSLATION_SERVER_URL` to route URL extractions through a
Zotero translation-server instance you run. When set, the
`TranslationServer` strategy (priority 70, baseline confidence 60) wins
over `CitoidUrl` and `CitoidUrl` is suppressed for the same run.

**Tradeoffs:**

| | Citoid (default) | translation-server sidecar |
|---|---|---|
| Infrastructure | none | one more container |
| Latency | ~1-3s (Wikipedia) | ~200-500ms (localhost) |
| Uptime | Wikipedia's SLA | yours |
| Privacy | URLs sent to Wikipedia | URLs stay inside your network |
| Translator freshness | whatever Wikipedia ships | whatever image tag you pin |

**AGPL compliance:** Zotero's translation-server is AGPL-3.0 licensed.
citare-service communicates with it over HTTP and does not embed, modify,
or redistribute its source code. AGPL §13's conveying-modified-
network-services obligations attach only when a modified version of an
AGPL program is made available over a network. The reference
`docker-compose.yml` entry uses the unmodified
`zotero/translation-server:latest` image — no §13 obligation arises.
**If you build your own modified translation-server image, you are
responsible for your own §13 compliance**; that is out of scope for
this service. Zotero's source is at
<https://github.com/zotero/translation-server>.

## 7. Observability

Point a Prometheus scraper at `GET /metrics` with `X-Citare-Auth`. Metrics
prefix is `citare_`. See `SPEC.md` §4.9 for the emitted series.

Health probes should hit `GET /health` (no auth required).

## 8. When to bump `citare` vs bump this service

- New strategies, new extraction primitives → upgrade the `citare`
  pinned version in `package.json`, rebuild this image. Consumers see the
  improvement on their next request.
- New endpoints, new routing behavior, auth changes → bump this service's
  own version; SPEC.md should reflect the new shape.

## 9. Multi-candidate search (`POST /lookup-candidates`)

Unlike `/extract`, which returns a single best answer, `/lookup-candidates`
returns a list of plausible candidates sorted by confidence. Useful when
the consumer wants to present a choose-from-list UI for title-only
searches (e.g., a user types a book or article title and picks from
matches).

Request body:

```json
{
  "kind": "bookTitle" | "articleTitle",
  "title": "required",
  "author": "optional",
  "maxResults": 10
}
```

Response:

```json
{
  "candidates": [
    {
      "csl": {...},
      "confidence": 75,
      "strategyName": "GoogleBooks",
      "fieldConfidence": {...},
      "provenance": {...},
      "warnings": []
    },
    ...
  ]
}
```

- Book-title queries route through configured
  `CITARE_ISBN_*` adapters' `searchByTitle` methods (if any).
- Article-title queries route through any consumer-supplied
  `ArticleSearchAdapter` instances (see `citare`), with a
  built-in CrossRef freetext adapter (<https://api.crossref.org/works>)
  as the fallback.

## 10. Deferred rollout pattern (mirror-mode)

When migrating consumer code from its own citation logic to this service,
the recommended pattern (see `SPEC.md` §10.5):

1. Deploy this service alongside existing code.
2. Call both paths in parallel on 1% of requests.
3. Log divergence to a separate stream.
4. Ramp 10% → 50% → 100% once divergence is acceptably low.
5. Remove the legacy path.

The service is not aware of mirroring — this is consumer-side behavior.
