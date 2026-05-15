# Citation-quality eval harness

Config-driven comparison harness for the `citare` library.
Sized for a few-hundred-item ground-truth corpus across 5 ops (DOI
lookup, RIS parsing, CrossRef freetext search, URL extraction, legacy-bib
upgrade). For each op, runs up to three pipelines per LLM variant:

1. **baseline** — the host application's pre-citare pipeline (e.g.
   a host app's legacy extraction pipeline). Opt-in via a `BaselineAdapter` module.
2. **citare solo** — library defaults, no LLM, no host fallbacks.
3. **citare post** — citare primary with the variant's LLM, baseline
   fallback when a method is exposed for the op.

## Quick start

```bash
# From citare-service repo root:
npx tsx eval/harness.ts --config eval/configs/default.json
npx tsx eval/score.ts --config eval/configs/default.json
```

Outputs land under the config's `resultsDir` (default: `eval/results/`):

```
results/
  raw-<variant>.jsonl        # per-item record, one JSON per line
  llm-calls-<variant>.jsonl  # per-LLM-call telemetry
  multi-summary.md           # human-readable comparison
  multi-scores.json          # structured scores
```

## Config schema

See `eval/config-schema.ts` (Zod). Keys:

| Key | Purpose |
|---|---|
| `corpus.{doi,url,ris,legacyBib,freetext}` | Paths to JSONL corpora. Relative to the config file's directory. Any may be omitted; ops using missing corpora are silently skipped. |
| `opsEnabled` | Which ops to run. Subset of `crossref_doi_lookup`, `parse_ris`, `crossref_field_search`, `extract_from_url`, `upgrade_legacy_bib`. |
| `usageWeights` | Op-frequency weights (proportions) for the usage-weighted quality aggregate. |
| `variants[]` | LLM variants to sweep. Each has `name`, `provider` (`bedrock-invoke` / `bedrock-converse` / `anthropic` / `none`), optional `modelId`, and pricing (`usdPerMtokIn/Out`). |
| `baseline.enabled` | Opt into loading a host-app `BaselineAdapter`. When false, baseline columns are omitted. |
| `baseline.modulePath` | Path to a module whose default export is a `BaselineAdapterFactory`. |
| `pacingMs` | Sleep between HTTP calls to pace upstreams (CrossRef, target sites). |
| `resultsDir` | Where raw JSONL + summary land. Relative to config dir. |

## BaselineAdapter

Host apps (e.g., a host app) ship their own adapter implementing the
`BaselineAdapter` interface (`eval/baseline-adapter.ts`). Factory must
be the default export:

```ts
// host-baseline.ts
import type { BaselineAdapter } from "/path/to/citare-service/eval/baseline-adapter";

export default function(): BaselineAdapter {
  return {
    name: "host-baseline",
    async doiLookup(doi) { /* ... */ },
    async extractUrl(url) { /* ... */ },
    parseRis(ris) { /* ... */ },
    upgradeLegacyBib(bib) { /* ... */ },
    async freetextSearch(author, title, max) { /* ... */ },
  };
}
```

All methods are optional — missing methods skip that op's pre column
for that adapter. The harness never imports adapter code directly; it
resolves `config.baseline.modulePath` via `await import()`.

## CLI flags

```
--config <path>       Required. Path to config JSON.
--variant <name>      Optional. Run just one variant (by name).
--mode all|post-only  Default "all". "post-only" skips baseline + solo
                       columns (useful for multi-variant sweeps once the
                       baseline donor run is in place).
```

## Env vars

| Var | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / (`AWS_SESSION_TOKEN`) | Required for `bedrock-invoke` / `bedrock-converse` variants. |
| `AWS_REGION` | Defaults to `us-east-1`. |
| `ANTHROPIC_API_KEY` | Required for `provider: anthropic` variants. |

## Corpus shape

Each corpus is JSONL, one item per line, with at minimum an `expected`
CSL-JSON object. See `fixtures/` for reference shapes:

- `doi.jsonl`: `{url, expected}` — URL is `https://doi.org/<doi>`.
- `url.jsonl`: `{url, expected}` — URL is a live web page.
- `ris.jsonl`: `{id, ris, expected}`.
- `legacy-bib.jsonl`: `{id, input, expected}`.
- `freetext.jsonl`: `{id, input: {author, title}, expected}`.

## Tests

```bash
npm test -- eval/tests/
```
