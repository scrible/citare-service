/**
 * Quality-bar comparison harness, config-driven.
 *
 * For each enabled op and each LLM variant, runs up to three pipelines:
 *   1. baseline (host-app pre-citare) — only if a BaselineAdapter advertises
 *      that op. Omitted otherwise.
 *   2. citare solo — library defaults, no LLM, no host-app fallbacks.
 *   3. citare post — citare primary with the variant's LLM wired in, plus a
 *      baseline fallback when the adapter exposes the op.
 *
 * Output per variant:
 *   results/raw-<variant>.jsonl       per-item record, one JSON per line
 *   results/llm-calls-<variant>.jsonl per-LLM-call telemetry record
 *
 * When `--mode post-only`, the baseline + solo columns are skipped — useful
 * for multi-variant sweeps that already have a reference baseline run.
 *
 * Usage:
 *   npx tsx eval/harness.ts --config eval/configs/default.json
 *   npx tsx eval/harness.ts --config /path/to/host.config.json \
 *     --variant haiku-4-5 --mode post-only
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

import {
  createCitare,
  parseRis as citareParseRis,
  upgradeLegacyBib as citareUpgradeLegacyBib,
} from "citare";
import { createDomAdapterFromParser } from "citare/dom-linkedom";
import { createBedrockLlm } from "citare/llm-bedrock";
import { createAnthropicLlm } from "citare/llm-anthropic";
import { createCrossRefFreetext } from "citare/article-crossref-freetext";
import type {
  CslJson,
  ExtractionResult,
  LegacyBibHash,
  LlmAdapter,
  LlmRequest,
  LlmResponse,
} from "citare";

import { createBedrockConverse } from "./bedrock-converse.js";
import {
  loadConfig,
  type EvalConfig,
  type LoadedConfig,
  type OpName,
  type VariantConfig,
} from "./config-schema.js";
import {
  noBaselineAdapter,
  type BaselineAdapter,
  type BaselineAdapterFactory,
  type Csl,
} from "./baseline-adapter.js";

// --------- CLI --------------------------------------------------------

interface CliArgs {
  configPath: string;
  variant?: string;
  mode: "all" | "post-only";
}

function parseCli(argv: string[]): CliArgs {
  let configPath = "";
  let variant: string | undefined;
  let mode: "all" | "post-only" = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") configPath = argv[++i] ?? "";
    else if (a === "--variant") variant = argv[++i];
    else if (a === "--mode") {
      const m = argv[++i];
      if (m !== "all" && m !== "post-only") {
        throw new Error(`--mode must be "all" or "post-only"; got ${m}`);
      }
      mode = m;
    }
  }
  if (!configPath) {
    throw new Error("Usage: harness --config <path> [--variant <name>] [--mode all|post-only]");
  }
  return { configPath, variant, mode };
}

// --------- Telemetry --------------------------------------------------

interface LlmCallRecord {
  variant: string;
  op: string;
  itemId: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
  ok: boolean;
}

interface TelemetryState {
  calls: LlmCallRecord[];
  currentOp: string;
  currentItemId: string | null;
}

function wrapWithTelemetry(
  base: LlmAdapter,
  variant: VariantConfig,
  state: TelemetryState,
): LlmAdapter {
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const t0 = Date.now();
      let ok = true;
      let resp: LlmResponse = { text: "" };
      try {
        resp = await base.complete(req);
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        const latencyMs = Date.now() - t0;
        const tin = resp.tokensUsed?.input ?? 0;
        const tout = resp.tokensUsed?.output ?? 0;
        const usdCost =
          (tin * variant.usdPerMtokIn) / 1_000_000 +
          (tout * variant.usdPerMtokOut) / 1_000_000;
        state.calls.push({
          variant: variant.name,
          op: state.currentOp,
          itemId: state.currentItemId,
          latencyMs,
          inputTokens: tin,
          outputTokens: tout,
          usdCost,
          ok,
        });
      }
      return resp;
    },
  };
}

// --------- LLM factory ------------------------------------------------

function buildLlm(
  variant: VariantConfig,
  state: TelemetryState,
): LlmAdapter | null {
  if (variant.provider === "none") return null;
  if (!variant.modelId) {
    console.warn(
      `[variant ${variant.name}] no modelId set; running without LLM.`,
    );
    return null;
  }
  if (variant.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(`[variant ${variant.name}] ANTHROPIC_API_KEY not set.`);
      return null;
    }
    const base = createAnthropicLlm({ apiKey, model: variant.modelId });
    return wrapWithTelemetry(base, variant, state);
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn(
      `[variant ${variant.name}] no AWS credentials; running without LLM.`,
    );
    return null;
  }
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  const base: LlmAdapter =
    variant.provider === "bedrock-invoke"
      ? createBedrockLlm({ region, modelId: variant.modelId, credentials })
      : createBedrockConverse({
          region,
          modelId: variant.modelId,
          credentials,
        });
  return wrapWithTelemetry(base, variant, state);
}

// --------- Citare clients ----------------------------------------------

const USER_AGENT = "citare-service-eval/1.0 (eval@example.com)";

function buildCitareSolo() {
  return createCitare({
    dom: createDomAdapterFromParser(parseHTML),
    userAgent: USER_AGENT,
  });
}

function buildCitarePost(llm: LlmAdapter | null) {
  if (!llm) return buildCitareSolo();
  return createCitare({
    dom: createDomAdapterFromParser(parseHTML),
    userAgent: USER_AGENT,
    llm,
    articleSearchAdapters: [createCrossRefFreetext({ llm, userAgent: USER_AGENT })],
  });
}

async function citareSoloDoiLookup(doi: string): Promise<Csl | null> {
  try {
    const res: ExtractionResult = await buildCitareSolo().extractFromDoi(doi);
    return res.csl ?? null;
  } catch {
    return null;
  }
}

async function citareSoloExtractUrl(url: string): Promise<Csl | null> {
  try {
    const res: ExtractionResult = await buildCitareSolo().extractFromUrl(url);
    return res.csl ?? null;
  } catch {
    return null;
  }
}

function citareSoloRis(text: string): Csl | null {
  try {
    return citareParseRis(text).csl;
  } catch {
    return null;
  }
}

function citareSoloLegacyBib(bib: Record<string, unknown>): Csl | null {
  try {
    return citareUpgradeLegacyBib(bib as LegacyBibHash).csl;
  } catch {
    return null;
  }
}

async function citareSoloFreetext(
  author: string | null,
  title: string | null,
  max = 5,
): Promise<Csl[]> {
  const adapter = createCrossRefFreetext({ userAgent: USER_AGENT });
  try {
    return await adapter.search(
      { title: title ?? "", author: author ?? undefined },
      { maxResults: max },
    );
  } catch {
    return [];
  }
}

async function citarePostExtractUrl(
  llm: LlmAdapter | null,
  url: string,
): Promise<Csl | null> {
  try {
    const res: ExtractionResult = await buildCitarePost(llm).extractFromUrl(url);
    return res.csl ?? null;
  } catch {
    return null;
  }
}

async function citarePostFreetext(
  llm: LlmAdapter | null,
  author: string | null,
  title: string | null,
  max = 5,
): Promise<Csl[]> {
  const adapter = createCrossRefFreetext({
    userAgent: USER_AGENT,
    llm: llm ?? undefined,
  });
  try {
    return await adapter.search(
      { title: title ?? "", author: author ?? undefined },
      { maxResults: max },
    );
  } catch {
    return [];
  }
}

// --------- Post = citare primary + baseline fallback --------------------

async function postDoi(
  adapter: BaselineAdapter,
  doi: string,
): Promise<Csl | null> {
  const citare = await citareSoloDoiLookup(doi);
  if (citare) return citare;
  return (await adapter.doiLookup?.(doi)) ?? null;
}

async function postExtractUrl(
  adapter: BaselineAdapter,
  llm: LlmAdapter | null,
  url: string,
): Promise<Csl | null> {
  const citare = await citarePostExtractUrl(llm, url);
  if (citare) return citare;
  return (await adapter.extractUrl?.(url)) ?? null;
}

function postParseRis(adapter: BaselineAdapter, text: string): Csl | null {
  const citare = citareSoloRis(text);
  if (citare) return citare;
  return adapter.parseRis?.(text) ?? null;
}

function postLegacyBib(
  adapter: BaselineAdapter,
  bib: Record<string, unknown>,
): Csl | null {
  const citare = citareSoloLegacyBib(bib);
  if (citare) return citare;
  return adapter.upgradeLegacyBib?.(bib) ?? null;
}

async function postFreetext(
  adapter: BaselineAdapter,
  llm: LlmAdapter | null,
  author: string | null,
  title: string | null,
  max = 5,
): Promise<Csl[]> {
  const citare = await citarePostFreetext(llm, author, title, max);
  if (citare.length > 0) return citare;
  return (await adapter.freetextSearch?.(author, title, max)) ?? [];
}

// --------- Adapter loader --------------------------------------------

async function loadBaselineAdapter(
  config: EvalConfig,
): Promise<BaselineAdapter> {
  if (!config.baseline.enabled || !config.baseline.modulePath) {
    return noBaselineAdapter();
  }
  const url = pathToFileURL(config.baseline.modulePath).href;
  const mod = (await import(url)) as {
    default?: BaselineAdapterFactory | BaselineAdapter;
  };
  const exported = mod.default;
  if (!exported) {
    throw new Error(
      `baseline.modulePath ${config.baseline.modulePath} has no default export`,
    );
  }
  const instance =
    typeof exported === "function"
      ? await (exported as BaselineAdapterFactory)()
      : exported;
  if (!instance || typeof instance !== "object" || !("name" in instance)) {
    throw new Error(
      `baseline factory did not return a BaselineAdapter (missing .name)`,
    );
  }
  return instance as BaselineAdapter;
}

// --------- Timing helpers --------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}
function timedSync<T>(fn: () => T): { value: T; ms: number } {
  const t0 = Date.now();
  const value = fn();
  return { value, ms: Date.now() - t0 };
}

function loadJsonl(p: string): Array<Record<string, unknown>> {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// --------- Main run loop ---------------------------------------------

interface PerItemRecord {
  op: OpName;
  id: string;
  input: unknown;
  expected: unknown;
  baseline_pre?: unknown;
  citare_solo?: unknown;
  baseline_post: unknown;
  baseline_pre_ms?: number;
  citare_solo_ms?: number;
  baseline_post_ms: number;
  baseline_pre_top5?: unknown;
  citare_solo_top5?: unknown;
  baseline_post_top5?: unknown;
}

async function runVariant(
  loaded: LoadedConfig,
  variant: VariantConfig,
  baseline: BaselineAdapter,
  mode: "all" | "post-only",
): Promise<void> {
  const { config } = loaded;
  const state: TelemetryState = {
    calls: [],
    currentOp: "?",
    currentItemId: null,
  };
  const llm = buildLlm(variant, state);
  console.log(
    `\n=== variant=${variant.name} mode=${mode} provider=${variant.provider}` +
      (variant.modelId ? ` model=${variant.modelId}` : "") +
      ` baseline=${baseline.name}`,
  );

  const out: PerItemRecord[] = [];
  const runBaseline = mode === "all" && baseline.name !== "none";
  const runSolo = mode === "all";
  const pace = config.pacingMs;

  // Op: crossref_doi_lookup
  if (config.opsEnabled.includes("crossref_doi_lookup") && config.corpus.doi) {
    const items = loadJsonl(config.corpus.doi);
    console.log(`[doi] running ${items.length} items`);
    for (const [i, it] of items.entries()) {
      const doi =
        (it["expected"] as { DOI?: string })?.DOI ??
        (it["url"] as string | undefined)?.replace(/^https?:\/\/doi\.org\//, "") ??
        "";
      const id = (it["id"] as string | undefined) ?? `doi-${i + 1}`;
      state.currentOp = "crossref_doi_lookup";
      state.currentItemId = id;
      const rec: PerItemRecord = {
        op: "crossref_doi_lookup",
        id,
        input: { doi },
        expected: it["expected"],
        baseline_post: null,
        baseline_post_ms: 0,
      };
      if (runBaseline && baseline.doiLookup) {
        const r = await timed(async () => (await baseline.doiLookup!(doi)) ?? null);
        rec.baseline_pre = r.value;
        rec.baseline_pre_ms = r.ms;
        await sleep(pace);
      }
      if (runSolo) {
        const r = await timed(() => citareSoloDoiLookup(doi));
        rec.citare_solo = r.value;
        rec.citare_solo_ms = r.ms;
        await sleep(pace);
      }
      const r = await timed(() => postDoi(baseline, doi));
      rec.baseline_post = r.value;
      rec.baseline_post_ms = r.ms;
      await sleep(pace);
      out.push(rec);
      console.log(`  [${i + 1}/${items.length}] ${doi} — done`);
    }
  }

  // Op: parse_ris
  if (config.opsEnabled.includes("parse_ris") && config.corpus.ris) {
    const items = loadJsonl(config.corpus.ris);
    console.log(`[ris] running ${items.length} items`);
    for (const it of items) {
      const ris = it["ris"] as string;
      const id = it["id"] as string;
      state.currentOp = "parse_ris";
      state.currentItemId = id;
      const rec: PerItemRecord = {
        op: "parse_ris",
        id,
        input: { ris_preview: ris.slice(0, 120) },
        expected: it["expected"],
        baseline_post: null,
        baseline_post_ms: 0,
      };
      if (runBaseline && baseline.parseRis) {
        const r = timedSync(() => baseline.parseRis!(ris));
        rec.baseline_pre = r.value;
        rec.baseline_pre_ms = r.ms;
      }
      if (runSolo) {
        const r = timedSync(() => citareSoloRis(ris));
        rec.citare_solo = r.value;
        rec.citare_solo_ms = r.ms;
      }
      const r = timedSync(() => postParseRis(baseline, ris));
      rec.baseline_post = r.value;
      rec.baseline_post_ms = r.ms;
      out.push(rec);
    }
  }

  // Op: crossref_field_search (synthesized from freetext corpus)
  if (
    config.opsEnabled.includes("crossref_field_search") &&
    config.corpus.freetext
  ) {
    const items = loadJsonl(config.corpus.freetext);
    console.log(`[freetext] running ${items.length} items`);
    for (const [i, it] of items.entries()) {
      // freetext.jsonl entries carry { input: {author, title}, expected, id }
      const input = (it["input"] as { author?: string | null; title?: string | null } | undefined) ?? {};
      const expected = it["expected"] as {
        title?: string;
        authors?: { family?: string }[];
        DOI?: string;
      };
      const title = input.title ?? expected?.title ?? null;
      const author = input.author ?? expected?.authors?.[0]?.family ?? null;
      const id = (it["id"] as string | undefined) ?? `freetext-${i + 1}`;
      state.currentOp = "crossref_field_search";
      state.currentItemId = id;
      const rec: PerItemRecord = {
        op: "crossref_field_search",
        id,
        input: { author, title },
        expected,
        baseline_post: null,
        baseline_post_ms: 0,
      };
      if (runBaseline && baseline.freetextSearch) {
        const r = await timed(() => baseline.freetextSearch!(author, title, 5));
        rec.baseline_pre = r.value[0] ?? null;
        rec.baseline_pre_top5 = r.value.slice(0, 5).map((x) => x.DOI ?? null);
        rec.baseline_pre_ms = r.ms;
        await sleep(pace);
      }
      if (runSolo) {
        const r = await timed(() => citareSoloFreetext(author, title, 5));
        rec.citare_solo = r.value[0] ?? null;
        rec.citare_solo_top5 = r.value.slice(0, 5).map((x) => x.DOI ?? null);
        rec.citare_solo_ms = r.ms;
        await sleep(pace);
      }
      const r = await timed(() => postFreetext(baseline, llm, author, title, 5));
      rec.baseline_post = r.value[0] ?? null;
      rec.baseline_post_top5 = r.value.slice(0, 5).map((x) => x.DOI ?? null);
      rec.baseline_post_ms = r.ms;
      await sleep(pace);
      out.push(rec);
      console.log(`  [${i + 1}/${items.length}] "${(title ?? "").slice(0, 40)}..." — done`);
    }
  }

  // Op: extract_from_url
  if (config.opsEnabled.includes("extract_from_url") && config.corpus.url) {
    const items = loadJsonl(config.corpus.url);
    console.log(`[url] running ${items.length} items`);
    for (const [i, it] of items.entries()) {
      const url = it["url"] as string;
      const id = (it["id"] as string | undefined) ?? `url-${i + 1}`;
      state.currentOp = "extract_from_url";
      state.currentItemId = id;
      const rec: PerItemRecord = {
        op: "extract_from_url",
        id,
        input: { url },
        expected: it["expected"],
        baseline_post: null,
        baseline_post_ms: 0,
      };
      if (runBaseline && baseline.extractUrl) {
        const r = await timed(async () => (await baseline.extractUrl!(url)) ?? null);
        rec.baseline_pre = r.value;
        rec.baseline_pre_ms = r.ms;
        await sleep(pace);
      }
      if (runSolo) {
        const r = await timed(() => citareSoloExtractUrl(url));
        rec.citare_solo = r.value;
        rec.citare_solo_ms = r.ms;
        await sleep(pace);
      }
      const r = await timed(() => postExtractUrl(baseline, llm, url));
      rec.baseline_post = r.value;
      rec.baseline_post_ms = r.ms;
      await sleep(pace);
      out.push(rec);
      console.log(`  [${i + 1}/${items.length}] ${url.slice(0, 60)} — done`);
    }
  }

  // Op: upgrade_legacy_bib
  if (
    config.opsEnabled.includes("upgrade_legacy_bib") &&
    config.corpus.legacyBib
  ) {
    const items = loadJsonl(config.corpus.legacyBib);
    console.log(`[legacy-bib] running ${items.length} items`);
    for (const it of items) {
      const bib = it["input"] as Record<string, unknown>;
      const id = it["id"] as string;
      state.currentOp = "upgrade_legacy_bib";
      state.currentItemId = id;
      const rec: PerItemRecord = {
        op: "upgrade_legacy_bib",
        id,
        input: bib,
        expected: it["expected"],
        baseline_post: null,
        baseline_post_ms: 0,
      };
      if (runBaseline && baseline.upgradeLegacyBib) {
        const r = timedSync(() => baseline.upgradeLegacyBib!(bib));
        rec.baseline_pre = r.value;
        rec.baseline_pre_ms = r.ms;
      }
      if (runSolo) {
        const r = timedSync(() => citareSoloLegacyBib(bib));
        rec.citare_solo = r.value;
        rec.citare_solo_ms = r.ms;
      }
      const r = timedSync(() => postLegacyBib(baseline, bib));
      rec.baseline_post = r.value;
      rec.baseline_post_ms = r.ms;
      out.push(rec);
    }
  }

  // Write outputs
  if (!existsSync(config.resultsDir)) mkdirSync(config.resultsDir, { recursive: true });
  const rawPath = join(config.resultsDir, `raw-${variant.name}.jsonl`);
  const llmPath = join(config.resultsDir, `llm-calls-${variant.name}.jsonl`);
  writeFileSync(rawPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(
    llmPath,
    state.calls.map((r) => JSON.stringify(r)).join("\n") +
      (state.calls.length ? "\n" : ""),
  );
  console.log(`\nWrote ${out.length} records to ${rawPath}`);
  console.log(
    `Wrote ${state.calls.length} LLM-call records to ${llmPath}`,
  );
  if (state.calls.length) {
    const totalCost = state.calls.reduce((s, c) => s + c.usdCost, 0);
    const totalMs = state.calls.reduce((s, c) => s + c.latencyMs, 0);
    console.log(
      `  total LLM latency: ${totalMs}ms, cost: $${totalCost.toFixed(5)}`,
    );
  }
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const loaded = loadConfig(args.configPath);
  const { config } = loaded;
  const baseline = await loadBaselineAdapter(config);

  const variants = args.variant
    ? config.variants.filter((v) => v.name === args.variant)
    : config.variants;
  if (variants.length === 0) {
    throw new Error(
      `No variants selected (--variant ${args.variant} not in config)`,
    );
  }
  for (const v of variants) {
    await runVariant(loaded, v, baseline, args.mode);
  }
}

main().catch((err) => {
  console.error("harness failed:", err);
  process.exit(1);
});
