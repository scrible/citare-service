/**
 * Config schema + loader for the eval harness. Zod shape mirrors the
 * JSON files under `eval/configs/` and the host-side
 * `website/env/development/citation-eval/host.config.json`.
 *
 * Paths in the config file are resolved relative to the config file's
 * own directory. Absolute paths are kept as-is.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const VariantSchema = z.object({
  /** Filename-safe short name. Surfaces in raw-<name>.jsonl and summary. */
  name: z.string().min(1),
  /**
   * Provider flavor:
   *  - "bedrock-invoke" → InvokeModel (Anthropic-only, via ibid's built-in
   *    createBedrockLlm). Cheaper sig path for Claude models.
   *  - "bedrock-converse" → Converse API, model-agnostic (Nova, Llama, …).
   *  - "anthropic" → direct Anthropic API (needs ANTHROPIC_API_KEY).
   *  - "none" → no LLM; solo+post reduce to library-defaults behavior.
   */
  provider: z.enum(["bedrock-invoke", "bedrock-converse", "anthropic", "none"]),
  /** Bedrock model-id or Anthropic model slug. Ignored when provider=none. */
  modelId: z.string().optional(),
  /** USD per 1M input tokens; used for cost aggregation in the scorer. */
  usdPerMtokIn: z.number().nonnegative().default(0),
  /** USD per 1M output tokens; used for cost aggregation in the scorer. */
  usdPerMtokOut: z.number().nonnegative().default(0),
  /**
   * Optional prompt overrides. Keys are ibid surface names
   * ("urlExtraction", "freetextRescue"). Values are system-prompt
   * strings or `null` to keep the library defaults. Not wired through
   * yet — reserved for host-side prompt tuning.
   */
  systemPromptOverrides: z
    .record(z.union([z.string(), z.null()]))
    .optional(),
});
export type VariantConfig = z.infer<typeof VariantSchema>;

export const CorpusSchema = z.object({
  doi: z.string().optional(),
  url: z.string().optional(),
  ris: z.string().optional(),
  legacyBib: z.string().optional(),
  freetext: z.string().optional(),
});
export type CorpusConfig = z.infer<typeof CorpusSchema>;

export const OpNameSchema = z.enum([
  "crossref_doi_lookup",
  "parse_ris",
  "crossref_field_search",
  "extract_from_url",
  "upgrade_legacy_bib",
]);
export type OpName = z.infer<typeof OpNameSchema>;

export const EvalConfigSchema = z.object({
  corpus: CorpusSchema,
  opsEnabled: z.array(OpNameSchema).min(1),
  /**
   * Op-frequency weights for the usage-weighted quality aggregate.
   * Need not sum to 1 — the scorer treats them as proportions.
   */
  usageWeights: z.record(OpNameSchema, z.number().nonnegative()).default({
    extract_from_url: 0.7,
    crossref_doi_lookup: 0.12,
    crossref_field_search: 0.08,
    parse_ris: 0.05,
    upgrade_legacy_bib: 0.05,
  }),
  variants: z.array(VariantSchema).min(1),
  baseline: z
    .object({
      enabled: z.boolean().default(false),
      /** Path to a module whose default export is BaselineAdapterFactory. */
      modulePath: z.string().nullable().default(null),
    })
    .default({ enabled: false, modulePath: null }),
  /** Sleep (ms) between HTTP calls to pace upstream APIs politely. */
  pacingMs: z.number().int().nonnegative().default(350),
  /**
   * Where raw + llm-call JSONL files land + where the scorer writes
   * multi-summary.md / multi-scores.json. Relative paths resolve
   * against the config file's directory.
   */
  resultsDir: z.string().default("./results"),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export interface LoadedConfig {
  /** Validated config. All paths resolved to absolute. */
  config: EvalConfig;
  /** Absolute directory the config file lives in (for relative path resolution). */
  configDir: string;
  /** Absolute path the config was loaded from. */
  configPath: string;
}

/**
 * Load a config JSON, validate, and resolve all corpus + results paths
 * to absolute locations. The config's own directory is the anchor for
 * relative paths.
 */
export function loadConfig(configPath: string): LoadedConfig {
  const absConfig = isAbsolute(configPath) ? configPath : resolve(configPath);
  const raw = readFileSync(absConfig, "utf8");
  const parsed = JSON.parse(raw);
  const config = EvalConfigSchema.parse(parsed);
  const configDir = dirname(absConfig);

  const resolvePath = (p: string | undefined): string | undefined =>
    p == null ? undefined : isAbsolute(p) ? p : resolve(configDir, p);

  config.corpus = {
    doi: resolvePath(config.corpus.doi),
    url: resolvePath(config.corpus.url),
    ris: resolvePath(config.corpus.ris),
    legacyBib: resolvePath(config.corpus.legacyBib),
    freetext: resolvePath(config.corpus.freetext),
  };
  config.resultsDir = resolvePath(config.resultsDir)!;
  if (config.baseline.modulePath) {
    config.baseline.modulePath = resolvePath(config.baseline.modulePath)!;
  }
  return { config, configDir, configPath: absConfig };
}
