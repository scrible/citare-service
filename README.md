# ibid-service

HTTP wrapper around [`@bwthomas/ibid`](https://github.com/bwthomas/ibid) for
non-TypeScript consumers (Ruby, Java, browser toolbars without the npm
dependency, etc.).

## Quick start

```bash
# Requires node 18+ and npm.
npm install
npm test

# Dev server (auto-rebuilds on src changes):
IBID_SERVICE_AUTH=dev-secret-please-replace-32-chars npm run dev

# Or via Docker:
IBID_SERVICE_AUTH=dev-secret-please-replace-32-chars docker compose up --build
```

The service listens on `:3000`. Health check at `GET /health` (no auth).

## Endpoints (all require `X-Ibid-Auth` header)

- `POST /extract` — run the full ibid pipeline on a URL / DOI / ISBN / HTML / RIS / EasyBib / free text input.
- `POST /normalize` — post-process an existing CSL item.
- `POST /parse-ris`, `/parse-easybib`, `/upgrade-bib` — pure parsers.
- `POST /parse-authors`, `/parse-date` — utility parsers.
- `GET /metrics` — Prometheus text format.

Full contract: [`SPEC.md`](SPEC.md). Integration checklist: [`INTEGRATION.md`](INTEGRATION.md).

## Configuration

Via environment variables. See [`SPEC.md` §7](SPEC.md#7-configuration) for the
full catalog. Minimum required: `IBID_SERVICE_AUTH` (16+ char random secret).

Optional: `IBID_LLM_ANTHROPIC_API_KEY` (or AWS creds picked up by the Bedrock
adapter) registers the LLM fallback strategy. When set, the freetext-search
CrossRef adapter is also auto-wired with LLM rescue (see ibid
[SPEC §8.1.2](../ibid/SPEC.md#812-crossrefreetext--optional-llm-rescue)).

### Recommended latency-first config

A reasonable starting point for a latency-sensitive mixed-input consumer:

```
IBID_SERVICE_AUTH=<16+ char secret>
IBID_LLM_ANTHROPIC_API_KEY=<anthropic key>   # or AWS creds for Bedrock
IBID_STRATEGY_CITOID_URL_ENABLED=false       # drop ibid's slowest built-in
IBID_STRATEGY_LLM_ENABLED=false              # no URL-extraction LLM rescue
# optional: IBID_LLM_ANTHROPIC_MODEL=us.amazon.nova-lite-v1:0  # Bedrock Converse
# optional: IBID_CACHE_ENABLED=false         # disable in-memory LRU during ops
```

Disabling `CitoidUrl` drops ibid's slowest built-in strategy from the pipeline.
Disabling the `Llm` strategy turns off URL-extraction LLM rescue — measurement
on a K-12 research corpus (2026-04-23) showed it regresses quality at corpus
scale while adding 500–1700ms per call. The freetext LLM rescue remains on
independently (via `articleSearchAdapters`, not the `Llm` strategy), so messy
author/title queries still benefit from LLM re-ranking at negligible cost.

### Strategy overrides (`IBID_STRATEGY_*`)

Each built-in strategy in the underlying package can be tuned per env-var.
Pattern (strategy names are upper-snake-cased — e.g. `CitoidUrl` → `CITOID_URL`):

| Env var | Default | Effect |
|---|---|---|
| `IBID_STRATEGY_<NAME>_ENABLED` | unset (strategy runs) | `false` removes the strategy from the pipeline entirely. |
| `IBID_STRATEGY_<NAME>_FALLBACK` | unset (SPEC-defined tier) | `true` promotes the strategy into the post-primary fallback tier so it only runs after primary-tier fold, with `ctx.currentBest` visible. |
| `IBID_STRATEGY_<NAME>_MIN_CURRENT_BEST_CONFIDENCE` | unset (strategy's own gate only) | Integer N — layers an extra `ctx.currentBest?.confidence < N` gate on top of the strategy's own `shouldRun`. Only meaningful in the fallback tier. |

Unrecognized strategy names are logged at `warn` and ignored. The full
mechanism (tiers, folding, gating semantics) lives in ibid
[SPEC §8.1.1.1](../ibid/SPEC.md#8111-per-strategy-overrides-optionsstrategyoverrides).

Strategy names available as of this writing: `CitoidDoi`, `CitoidUrl`,
`CrossRefDoi`, `DoiInHtml`, `Highwire`, `ImageExtractor`, `IsbnAdapterChain`,
`Llm`, `MetaTagFallback`, `OpenLibraryIsbn`, `SchemaOrgLdJson`,
`SchemaOrgMicrodata`, `TranslationServer`, `UrlFallback`, plus the vendor
family (`Gale*`, `Proquest*`, `Ebsco*`, `Credo*`, `Britannica`, `Wikipedia`,
`WorldBook`, etc.).

### Cost and latency guidance

CitoidUrl disabled saves roughly 1s per URL extraction at negligible quality
cost; leaving the LLM wired enables freetext rescue at ~$0.12/month per 100k
operations.

## Eval harness

The [`eval/`](eval/) directory ships a config-driven quality-and-cost
comparison harness (baseline vs. ibid-solo vs. ibid-post-LLM) over a
few-hundred-item JSONL corpus. See [`eval/README.md`](eval/README.md) for
corpus shape, config keys, and LLM-variant sweep.

## License

MIT. See [`AUTHORSHIP.md`](AUTHORSHIP.md) for provenance conventions.
