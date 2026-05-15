/**
 * Multi-variant scorer.
 *
 * Reads `<resultsDir>/raw-<variant>.jsonl` + `llm-calls-<variant>.jsonl`
 * for each variant in the config, plus one shared baseline run (any
 * variant — pre + solo columns are LLM-invariant when solo has no LLM
 * wired, so we pick the first variant with pre/solo columns present),
 * and produces:
 *
 *   <resultsDir>/multi-summary.md    — human-readable comparison.
 *   <resultsDir>/multi-scores.json   — structured scores.
 *
 * The 6-dimension rubric:
 *   - field_completeness: fraction of expected non-empty keys present in
 *     `got`. Case-insensitive + URL alias handling.
 *   - author_accuracy: Jaccard on family-name sets.
 *   - title_fidelity: exact or containment match after normalization.
 *   - identifier_presence: DOI (preferred) or ISBN exact match.
 *   - type_classification: canonicalized CSL type equality.
 *   - date_format: yyyy-mm-dd partial credit (0.5 year + 0.25 month + 0.25 day).
 *
 * CLI: `npx tsx eval/score.ts --config <path>`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  loadConfig,
  type EvalConfig,
  type OpName,
} from "./config-schema.js";

const DIMS = [
  "field_completeness",
  "author_accuracy",
  "title_fidelity",
  "identifier_presence",
  "type_classification",
  "date_format",
] as const;
type Dim = (typeof DIMS)[number];

interface RawRecord {
  op: OpName;
  id: string;
  expected: Record<string, unknown>;
  baseline_pre?: Record<string, unknown> | null;
  citare_solo?: Record<string, unknown> | null;
  baseline_post: Record<string, unknown> | null;
  baseline_pre_ms?: number;
  citare_solo_ms?: number;
  baseline_post_ms?: number;
}

interface LlmCallRecord {
  variant: string;
  op: OpName;
  itemId: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
  ok: boolean;
}

function loadJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// --------- 6-dim scoring ---------------------------------------------

function normStr(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim();
}
function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}
function families(arr: unknown): Set<string> {
  if (!Array.isArray(arr)) return new Set();
  const out = new Set<string>();
  for (const a of arr) {
    const fam = (a as { family?: string })?.family;
    if (fam) out.add(normStr(fam));
  }
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : inter / uni;
}
function dateYMD(d: unknown): { y?: number; m?: number; d?: number } | null {
  const dp = (d as { "date-parts"?: unknown[][] })?.["date-parts"]?.[0];
  if (!dp || !Array.isArray(dp)) return null;
  return {
    y: Number(dp[0]) || undefined,
    m: Number(dp[1]) || undefined,
    d: Number(dp[2]) || undefined,
  };
}

function scoreItem(
  exp: Record<string, unknown>,
  got: Record<string, unknown> | null | undefined,
): Record<Dim, number> | null {
  if (got === undefined) return null;
  if (!got) {
    return {
      field_completeness: 0,
      author_accuracy: 0,
      title_fidelity: 0,
      identifier_presence: 0,
      type_classification: 0,
      date_format: 0,
    };
  }
  const s: Record<Dim, number> = {
    field_completeness: 0,
    author_accuracy: 1,
    title_fidelity: 1,
    identifier_presence: 1,
    type_classification: 1,
    date_format: 1,
  };

  const expectedKeys = Object.keys(exp).filter(
    (k) => isNonEmpty(exp[k]) && k !== "data_format_version",
  );
  if (expectedKeys.length) {
    let present = 0;
    for (const k of expectedKeys) {
      if (
        isNonEmpty(got[k]) ||
        isNonEmpty(got[k.toLowerCase()]) ||
        (k === "URL" && isNonEmpty(got["URL"] ?? got["url"]))
      ) {
        present++;
      }
    }
    s.field_completeness = present / expectedKeys.length;
  } else {
    s.field_completeness = 1;
  }

  const expAuthors = (exp.author ?? exp.authors) as unknown;
  if (isNonEmpty(expAuthors)) {
    const gotAuthors = (got.author ?? got.authors) as unknown;
    s.author_accuracy = jaccard(families(expAuthors), families(gotAuthors));
  }

  if (isNonEmpty(exp.title)) {
    const a = normStr(exp.title);
    const b = normStr(got.title);
    if (a && b) {
      if (a === b) s.title_fidelity = 1;
      else if (a.includes(b) || b.includes(a)) s.title_fidelity = 0.8;
      else s.title_fidelity = 0;
    } else {
      s.title_fidelity = 0;
    }
  }

  const expDoi = exp.DOI,
    expIsbn = exp.ISBN;
  if (isNonEmpty(expDoi)) {
    s.identifier_presence = normStr(got.DOI) === normStr(expDoi) ? 1 : 0;
  } else if (isNonEmpty(expIsbn)) {
    s.identifier_presence = normStr(got.ISBN) === normStr(expIsbn) ? 1 : 0;
  }

  if (isNonEmpty(exp.type)) {
    const a = String(exp.type).toLowerCase().trim();
    const b = String(got.type ?? "").toLowerCase().trim();
    const can = (x: string) =>
      x === "website"
        ? "webpage"
        : x === "journal-article"
          ? "article-journal"
          : x;
    s.type_classification = can(a) === can(b) ? 1 : 0;
  }

  if (isNonEmpty(exp.issued)) {
    const e = dateYMD(exp.issued);
    const g = dateYMD(got.issued);
    if (!e) s.date_format = 1;
    else if (!g) s.date_format = 0;
    else {
      let d = 0;
      if (e.y === g.y) d = 0.5;
      if (e.m && g.m && e.m === g.m) d += 0.25;
      else if (!e.m) d += 0.25;
      if (e.d && g.d && e.d === g.d) d += 0.25;
      else if (!e.d) d += 0.25;
      s.date_format = Math.min(1, d);
    }
  }

  return s;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[i] ?? 0;
}
function round(n: number, p = 3): number {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

// --------- Main ------------------------------------------------------

interface Cell {
  dims: Record<Dim, number>;
  aggregate: number;
  latencyMs: number[];
}
const emptyCell = (): Cell => ({
  dims: {
    field_completeness: 0,
    author_accuracy: 0,
    title_fidelity: 0,
    identifier_presence: 0,
    type_classification: 0,
    date_format: 0,
  },
  aggregate: 0,
  latencyMs: [],
});

function cliArg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

function main() {
  const configPath = cliArg(process.argv, "--config");
  if (!configPath) {
    throw new Error("Usage: score --config <path>");
  }
  const { config } = loadConfig(configPath);
  const resultsDir = config.resultsDir;
  const ops = config.opsEnabled;
  const variantNames = config.variants.map((v) => v.name);
  const weights = config.usageWeights;

  // Pick the "baseline donor" — first variant whose raw file has any
  // non-null baseline_pre OR citare_solo records. Those columns are
  // LLM-invariant (pre doesn't use LLM; solo doesn't either) so any
  // full-mode run is equivalent.
  let baselineDonor: string | null = null;
  const baselineRecords = new Map<string, RawRecord>();
  for (const v of variantNames) {
    const raws = loadJsonl<RawRecord>(join(resultsDir, `raw-${v}.jsonl`));
    if (raws.some((r) => r.baseline_pre !== undefined || r.citare_solo !== undefined)) {
      baselineDonor = v;
      for (const r of raws) baselineRecords.set(`${r.op}|${r.id}`, r);
      break;
    }
  }

  // Per-variant post records
  const postByVariant = new Map<string, Map<string, RawRecord>>();
  for (const v of variantNames) {
    const map = new Map<string, RawRecord>();
    const raws = loadJsonl<RawRecord>(join(resultsDir, `raw-${v}.jsonl`));
    for (const r of raws) map.set(`${r.op}|${r.id}`, r);
    postByVariant.set(v, map);
  }

  // LLM call records
  const llmByVariant = new Map<string, LlmCallRecord[]>();
  for (const v of variantNames) {
    llmByVariant.set(
      v,
      loadJsonl<LlmCallRecord>(join(resultsDir, `llm-calls-${v}.jsonl`)),
    );
  }

  // Baseline per-op scores (pre + solo). Missing → cells stay empty.
  const baselinePerOp: Partial<Record<OpName, { pre: Cell; solo: Cell }>> = {};
  for (const op of ops) {
    const items = Array.from(baselineRecords.values()).filter(
      (r) => r.op === op,
    );
    const preScores = items
      .map((r) => scoreItem(r.expected, r.baseline_pre))
      .filter((s): s is Record<Dim, number> => s != null);
    const soloScores = items
      .map((r) => scoreItem(r.expected, r.citare_solo))
      .filter((s): s is Record<Dim, number> => s != null);
    const preLat = items
      .map((r) => r.baseline_pre_ms)
      .filter((m): m is number => typeof m === "number");
    const soloLat = items
      .map((r) => r.citare_solo_ms)
      .filter((m): m is number => typeof m === "number");
    const preCell = emptyCell();
    const soloCell = emptyCell();
    for (const d of DIMS) {
      preCell.dims[d] = round(mean(preScores.map((s) => s[d])));
      soloCell.dims[d] = round(mean(soloScores.map((s) => s[d])));
    }
    preCell.aggregate = round(mean(DIMS.map((d) => preCell.dims[d])));
    soloCell.aggregate = round(mean(DIMS.map((d) => soloCell.dims[d])));
    preCell.latencyMs = preLat;
    soloCell.latencyMs = soloLat;
    baselinePerOp[op] = { pre: preCell, solo: soloCell };
  }

  // Per-variant post cells
  const postPerVariant: Record<string, Partial<Record<OpName, Cell>>> = {};
  for (const v of variantNames) {
    postPerVariant[v] = {};
    const records = postByVariant.get(v)!;
    for (const op of ops) {
      const items = Array.from(records.values()).filter((r) => r.op === op);
      const scores = items
        .map((r) => scoreItem(r.expected, r.baseline_post))
        .filter((s): s is Record<Dim, number> => s != null);
      const cell = emptyCell();
      for (const d of DIMS) {
        cell.dims[d] = round(mean(scores.map((s) => s[d])));
      }
      cell.aggregate = round(mean(DIMS.map((d) => cell.dims[d])));
      cell.latencyMs = items
        .map((r) => r.baseline_post_ms)
        .filter((m): m is number => typeof m === "number");
      postPerVariant[v][op] = cell;
    }
  }

  // Weighted rollups
  function weightedAgg(perOp: Partial<Record<OpName, Cell>>): number {
    let tot = 0;
    for (const op of ops) {
      const w = weights[op] ?? 0;
      tot += (perOp[op]?.aggregate ?? 0) * w;
    }
    return round(tot);
  }
  function weightedLat(perOp: Partial<Record<OpName, Cell>>, p: number): number {
    let tot = 0;
    for (const op of ops) {
      const w = weights[op] ?? 0;
      tot += percentile(perOp[op]?.latencyMs ?? [], p) * w;
    }
    return Math.round(tot);
  }

  const prePerOp: Partial<Record<OpName, Cell>> = {};
  const soloPerOp: Partial<Record<OpName, Cell>> = {};
  for (const op of ops) {
    prePerOp[op] = baselinePerOp[op]?.pre ?? emptyCell();
    soloPerOp[op] = baselinePerOp[op]?.solo ?? emptyCell();
  }
  const preWeighted = weightedAgg(prePerOp);
  const preP50 = weightedLat(prePerOp, 0.5);
  const preP95 = weightedLat(prePerOp, 0.95);
  const soloWeighted = weightedAgg(soloPerOp);
  const soloP50 = weightedLat(soloPerOp, 0.5);
  const soloP95 = weightedLat(soloPerOp, 0.95);

  // Cost per variant
  interface CostCell {
    calls: number;
    totalUsd: number;
    llmLatMsTotal: number;
  }
  const costByVariant = new Map<string, CostCell>();
  for (const v of variantNames) {
    const calls = llmByVariant.get(v) ?? [];
    costByVariant.set(v, {
      calls: calls.length,
      totalUsd: calls.reduce((s, c) => s + c.usdCost, 0),
      llmLatMsTotal: calls.reduce((s, c) => s + c.latencyMs, 0),
    });
  }

  // Markdown output
  const lines: string[] = [];
  lines.push("# Multi-variant quality / latency / cost comparison");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Baseline donor:** ${baselineDonor ?? "(none — post-only)"}`);
  lines.push(
    `**Usage weights:** ${ops.map((o) => `${o}=${weights[o] ?? 0}`).join(", ")}`,
  );
  lines.push("");
  lines.push("## Headline — usage-weighted quality, latency, cost per state");
  lines.push("");
  lines.push(
    "| State | Weighted Quality | Lat p50 (ms) | Lat p95 (ms) | LLM calls | Total LLM cost |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|");
  if (baselineDonor) {
    lines.push(
      `| baseline pre | ${preWeighted} | ${preP50} | ${preP95} | — | $0 |`,
    );
    lines.push(
      `| citare solo | ${soloWeighted} | ${soloP50} | ${soloP95} | — | $0 |`,
    );
  }
  for (const v of variantNames) {
    const per = postPerVariant[v] ?? {};
    const wq = weightedAgg(per);
    const p50 = weightedLat(per, 0.5);
    const p95 = weightedLat(per, 0.95);
    const cost = costByVariant.get(v)!;
    lines.push(
      `| post-citare + ${v} | **${wq}** | ${p50} | ${p95} | ${cost.calls} | $${cost.totalUsd.toFixed(5)} |`,
    );
  }
  lines.push("");

  // Per-op × variant quality
  lines.push("## Post-citare quality per op × variant");
  lines.push("");
  lines.push(
    "| Op | " +
      variantNames.join(" | ") +
      (baselineDonor ? " | citare solo | baseline pre |" : " |"),
  );
  lines.push(
    "|---|" +
      variantNames.map(() => "---:").join("|") +
      (baselineDonor ? "|---:|---:|" : "|"),
  );
  for (const op of ops) {
    const row = [`\`${op}\``];
    for (const v of variantNames) {
      row.push(String(postPerVariant[v]?.[op]?.aggregate ?? 0));
    }
    if (baselineDonor) {
      row.push(String(baselinePerOp[op]?.solo.aggregate ?? 0));
      row.push(String(baselinePerOp[op]?.pre.aggregate ?? 0));
    }
    lines.push("| " + row.join(" | ") + " |");
  }
  lines.push("");

  // Latency p50 per op × variant
  lines.push("## Latency p50 (ms) per op × variant — post-citare state only");
  lines.push("");
  lines.push(
    "| Op | " +
      variantNames.join(" | ") +
      (baselineDonor ? " | citare solo | baseline pre |" : " |"),
  );
  lines.push(
    "|---|" +
      variantNames.map(() => "---:").join("|") +
      (baselineDonor ? "|---:|---:|" : "|"),
  );
  for (const op of ops) {
    const row = [`\`${op}\``];
    for (const v of variantNames) {
      row.push(String(percentile(postPerVariant[v]?.[op]?.latencyMs ?? [], 0.5)));
    }
    if (baselineDonor) {
      row.push(
        String(percentile(baselinePerOp[op]?.solo.latencyMs ?? [], 0.5)),
      );
      row.push(
        String(percentile(baselinePerOp[op]?.pre.latencyMs ?? [], 0.5)),
      );
    }
    lines.push("| " + row.join(" | ") + " |");
  }
  lines.push("");

  // LLM call stats
  lines.push("## LLM call stats per variant");
  lines.push("");
  lines.push(
    "| Variant | Calls | Tot LLM latency (ms) | Median call (ms) | Total cost |",
  );
  lines.push("|---|---:|---:|---:|---:|");
  for (const v of variantNames) {
    const calls = llmByVariant.get(v) ?? [];
    const lats = calls.map((c) => c.latencyMs);
    const cost = costByVariant.get(v)!;
    lines.push(
      `| ${v} | ${calls.length} | ${cost.llmLatMsTotal} | ${percentile(lats, 0.5)} | $${cost.totalUsd.toFixed(5)} |`,
    );
  }
  lines.push("");

  writeFileSync(join(resultsDir, "multi-summary.md"), lines.join("\n"));
  const out = {
    generatedAt: new Date().toISOString(),
    configPath,
    baselineDonor,
    usageWeights: weights,
    baselinePerOp,
    baselineWeighted: baselineDonor
      ? {
          pre: { quality: preWeighted, latP50: preP50, latP95: preP95 },
          solo: { quality: soloWeighted, latP50: soloP50, latP95: soloP95 },
        }
      : null,
    postPerVariant,
    costByVariant: Object.fromEntries(costByVariant.entries()),
  };
  writeFileSync(
    join(resultsDir, "multi-scores.json"),
    JSON.stringify(out, null, 2),
  );
  console.log("Wrote multi-summary.md + multi-scores.json to", resultsDir);
}

main();
