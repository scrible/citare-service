# AUTHORSHIP — ibid-service

Append-only log of authorship phase transitions for `ibid-service`.

Attribution convention: "inspired by" — never "ported from", "based on", "extracted from", or "derived from."

Detailed provenance records — including sources consulted, license-boundary reasoning, and session metadata — are maintained privately by the author.

---

## 2026-04-19 — Specification authored

- Actor: Blake Thomas, with AI assistance (Anthropic Claude).
- Wrote `SPEC.md` v0.1 and `IMPLEMENTATION-PLAN.md`.
- Spec inspired by the public Fastify + Node + Docker + ECS deployment pattern and by the shape of similar thin HTTP wrappers around npm packages. The service depends on `@bwthomas/ibid` at its API boundary only; no package internals are referenced.

## 2026-04-20 — Repo bootstrap

- Actor: Blake Thomas, with AI assistance (Anthropic Claude).
- `git init` at `~/Projects/ibid-service/`. Moved `SPEC.md`, `AUTHORSHIP.md`, `IMPLEMENTATION-PLAN.md` from `~/Documents/Claude/Specs/` into the repo root. First commit message references the specification session per the authorship convention.
- Remote not yet configured. Plan calls for `git@github.com:bwthomas/ibid-service.git` (public, MIT, matching the `@bwthomas/ibid` repo's ownership model); wire up via `gh repo create bwthomas/ibid-service --public --source=. --remote=origin --push`.

## (pending) — Implementation

Implementation has not begun. When it begins, an entry will be appended here naming the implementer, date, and commit range.

## 2026-04-22 — Translation-server plumbing

- Actor: Blake Thomas, with AI assistance (Anthropic Claude).
- Added `IBID_TRANSLATION_SERVER_URL` env var; plumbed through
  `src/config.ts` → `src/ibid-client.ts` → `createIbid({translationServerEndpoint})`.
  When set, ibid's `TranslationServer` strategy fires and `CitoidUrl` is
  suppressed for the same run.
- Reference `docker-compose.yml` gains a commented-out
  `translation-server` service using the unmodified
  `zotero/translation-server:latest` image. Consumers uncomment to opt in.
- `INTEGRATION.md` §6 documents the deploy-shape tradeoffs (Citoid
  default vs self-hosted sidecar) and the AGPL §13 reasoning —
  ibid-service communicates over HTTP and does not embed, modify, or
  redistribute translation-server source code.
- Tests: 2 new in `tests/translation-server.test.ts` verifying env-unset
  → empty endpoint and env-set → endpoint passes through. Full suite
  37/37 pass.

---

## Amendment rules

Append entries to the end. Do not edit prior entries. Include the actor, date, and artifacts touched. Use "inspired by" phrasing for any attribution. The author maintains detailed provenance records separately.
