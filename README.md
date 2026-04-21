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

Optional: `IBID_LLM_ANTHROPIC_API_KEY` enables the LLM-fallback strategy
for low-confidence extractions.

## License

MIT. See [`AUTHORSHIP.md`](AUTHORSHIP.md) for provenance conventions.
