# Integrating `ibid-service` into a downstream consumer

Minimal checklist for wiring this service into a Ruby / Java / Python /
browser app. Keep consumer-specific overrides in the consumer's own repo;
this doc just enumerates what needs to be in place.

## 1. Pick a deployment shape

- **Local dev**: `docker compose up` from this repo. Reachable at
  `http://localhost:3000`. Set `IBID_SERVICE_AUTH` to any 16+ char string
  and pass the same value to callers as `X-Ibid-Auth`.
- **Sidecar in a consumer's dev stack**: add a service entry to the
  consumer's `docker-compose.yml` referencing the published image
  (`bwthomas/ibid-service:latest` when published; build locally otherwise).
- **Managed deploy**: build from this repo's Dockerfile; push to a registry;
  run 1+ tasks behind a reverse proxy (HAProxy, nginx, ELB). Health probe
  on `GET /health`.

## 2. Environment variables the consumer must set

| Var | Required | Notes |
|---|---|---|
| `IBID_SERVICE_AUTH` | yes | 16+ char random secret. Shared with callers; they pass it as `X-Ibid-Auth`. |
| `IBID_USER_AGENT` | no | Default identifies this service; override to identify the consumer / its contact address for polite-pool upstreams (CrossRef). |
| `IBID_LLM_ANTHROPIC_API_KEY` | no | Enables the LLM fallback strategy. Omit = no LLM calls. |
| `IBID_LLM_ANTHROPIC_MODEL` | no | Defaults to `claude-haiku-4-5-20251001`. |

Full env var catalog lives in `SPEC.md` §7.

## 3. Reverse-proxy route (typical)

Mount at `/api/ibid/*` (or wherever the consumer prefers); strip prefix
before forwarding to the service.

HAProxy example:
```
acl ibid_api path_beg /api/ibid/
use_backend ibid_backend if ibid_api

backend ibid_backend
    http-request set-path %[path,regsub(^/api/ibid/,/)]
    server ibid1 ibid-service:3000 check
```

Nginx example:
```nginx
location /api/ibid/ {
    proxy_pass http://ibid-service:3000/;
    proxy_set_header X-Ibid-Auth $http_x_ibid_auth;
    proxy_read_timeout 15s;
}
```

## 4. Caller wiring

Every protected endpoint requires `X-Ibid-Auth: <secret>`. Content-Type is
`application/json` for all request bodies.

Ruby (HTTParty):
```ruby
HTTParty.post(
  "#{ENV['IBID_SERVICE_URL']}/extract",
  headers: {
    "Content-Type" => "application/json",
    "X-Ibid-Auth" => ENV.fetch("IBID_SERVICE_AUTH"),
  },
  body: { kind: "doi", doi: "10.1038/nature12373" }.to_json,
  timeout: 15,
)
```

Java (java.net.http):
```java
HttpClient client = HttpClient.newHttpClient();
HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create(System.getenv("IBID_SERVICE_URL") + "/extract"))
    .header("Content-Type", "application/json")
    .header("X-Ibid-Auth", System.getenv("IBID_SERVICE_AUTH"))
    .POST(HttpRequest.BodyPublishers.ofString(
        "{\"kind\":\"doi\",\"doi\":\"10.1038/nature12373\"}"))
    .timeout(Duration.ofSeconds(15))
    .build();
HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
```

Browser fetch:
```js
const res = await fetch(`${ibidUrl}/extract`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Ibid-Auth": ibidSecret,
  },
  body: JSON.stringify({ kind: "url", url: "https://example.com/x" }),
});
```

## 5. Response handling

Always JSON. Status codes:

- **200** — success. Body is an `ExtractionResult` per `@bwthomas/ibid`
  SPEC §5.2 (for `/extract`) or a `{csl, warnings}` shape for parsers.
- **400** — body validation failure. Inspect `issues` for zod details.
- **401** — missing or bad `X-Ibid-Auth`.
- **429** — upstream rate limit (crossref / citoid / openlibrary). Respect
  `Retry-After` header.
- **500** — internal error. `requestId` is in the body for log correlation.

Empty results (`confidence: 0`, no fields) are **not** errors — the service
returns 200 with a stable shape so consumers can render / store uniformly.

## 6. Observability

Point a Prometheus scraper at `GET /metrics` with `X-Ibid-Auth`. Metrics
prefix is `ibid_`. See `SPEC.md` §4.9 for the emitted series.

Health probes should hit `GET /health` (no auth required).

## 7. When to bump `ibid` vs bump this service

- New strategies, new extraction primitives → upgrade the `@bwthomas/ibid`
  pinned version in `package.json`, rebuild this image. Consumers see the
  improvement on their next request.
- New endpoints, new routing behavior, auth changes → bump this service's
  own version; SPEC.md should reflect the new shape.

## 8. Deferred rollout pattern (mirror-mode)

When migrating consumer code from its own citation logic to this service,
the recommended pattern (see `SPEC.md` §10.5):

1. Deploy this service alongside existing code.
2. Call both paths in parallel on 1% of requests.
3. Log divergence to a separate stream.
4. Ramp 10% → 50% → 100% once divergence is acceptably low.
5. Remove the legacy path.

The service is not aware of mirroring — this is consumer-side behavior.
