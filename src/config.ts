/**
 * Env-derived service configuration. SPEC §7.
 *
 * Fail-fast: refuse to start without a shared secret. Tests pass a fake
 * secret via `TEST_CITARE_SERVICE_AUTH`, keeping production defaults strict.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceConfig {
  port: number;
  authSecret: string;
  logLevel: "debug" | "info" | "warn" | "error";
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  citare: {
    userAgent: string;
    crossrefEndpoint: string;
    citoidEndpoint: string;
    /** Optional self-hosted Zotero translation-server endpoint. Empty → unset. */
    translationServerEndpoint: string;
    timeoutMs: number;
    /**
     * Per-strategy overrides passed through to citare's `strategyOverrides`.
     * Env-driven; each entry keyed by strategy name. Default: empty.
     *
     * Env-var pattern for each strategy:
     *   CITARE_STRATEGY_<NAME>_ENABLED=false
     *   CITARE_STRATEGY_<NAME>_FALLBACK=true
     *   CITARE_STRATEGY_<NAME>_MIN_CURRENT_BEST_CONFIDENCE=40
     *
     * e.g. `CITARE_STRATEGY_CITOID_URL_FALLBACK=true` to move CitoidUrl
     * into citare's fallback tier (see citare SPEC §8.1.1.1 for mechanism).
     */
    strategyOverrides: Record<
      string,
      { enabled?: boolean; fallback?: boolean; minCurrentBestConfidence?: number }
    >;
  };
  cache: {
    enabled: boolean;
    max: number;
    ttlMs: number;
  };
  budget: {
    crossref: { capacity: number; refillPerSec: number };
    citoid: { capacity: number; refillPerSec: number };
    openlibrary: { capacity: number; refillPerSec: number };
  };
  llm:
    | {
        provider: "anthropic";
        apiKey: string;
        model: string;
        /**
         * Tuning knobs for freetext-search LLM rescue. All optional —
         * `undefined` → the library's defaults in
         * `citare/article-crossref-freetext`.
         */
        freetextRescue?: FreetextRescueConfig;
      }
    | {
        provider: "bedrock";
        region: string;
        modelId: string;
        /** IAM credentials — picked up from AWS_* env vars by default. */
        accessKeyId: string;
        secretAccessKey: string;
        /** Optional; set when credentials are a temporary STS session. */
        sessionToken?: string;
        /** Same shape as the Anthropic-direct variant. */
        freetextRescue?: FreetextRescueConfig;
      }
    | { provider: "none" };
}

export interface FreetextRescueConfig {
  minScore?: number;
  minTitleOverlap?: number;
  maxCandidates?: number;
  maxTokens?: number;
  temperature?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const authSecret = env.CITARE_SERVICE_AUTH ?? env.TEST_CITARE_SERVICE_AUTH;
  if (!authSecret || authSecret.length < 16) {
    throw new Error(
      "CITARE_SERVICE_AUTH must be set to a 16+ character secret before startup",
    );
  }
  const llm = resolveLlmConfig(env);
  return {
    port: Number(env.PORT ?? 3000),
    authSecret,
    logLevel: (env.LOG_LEVEL as ServiceConfig["logLevel"]) ?? "info",
    bodyLimitBytes: Number(env.BODY_LIMIT_BYTES ?? 2 * 1024 * 1024),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 10_000),
    citare: {
      userAgent:
        env.CITARE_USER_AGENT ??
        "citare-service/0.1.0 (+https://github.com/bwthomas/citare-service)",
      crossrefEndpoint:
        env.CITARE_CROSSREF_ENDPOINT ?? "https://api.crossref.org",
      citoidEndpoint:
        env.CITARE_CITOID_ENDPOINT ??
        "https://en.wikipedia.org/api/rest_v1/data/citation",
      translationServerEndpoint: env.CITARE_TRANSLATION_SERVER_URL ?? "",
      timeoutMs: Number(env.CITARE_TIMEOUT_MS ?? 5_000),
      strategyOverrides: parseStrategyOverrides(env),
    },
    cache: {
      enabled: boolOrUndef(env.CITARE_CACHE_ENABLED) ?? true,
      max: Number(env.CITARE_CACHE_MAX ?? 10_000),
      ttlMs: Number(env.CITARE_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000),
    },
    budget: {
      crossref: {
        capacity: Number(env.CITARE_BUDGET_CROSSREF_CAPACITY ?? 50),
        refillPerSec: Number(env.CITARE_BUDGET_CROSSREF_REFILL_PER_SEC ?? 50),
      },
      citoid: {
        capacity: Number(env.CITARE_BUDGET_CITOID_CAPACITY ?? 30),
        refillPerSec: Number(env.CITARE_BUDGET_CITOID_REFILL_PER_SEC ?? 30),
      },
      openlibrary: {
        capacity: Number(env.CITARE_BUDGET_OPENLIBRARY_CAPACITY ?? 20),
        refillPerSec: Number(env.CITARE_BUDGET_OPENLIBRARY_REFILL_PER_SEC ?? 20),
      },
    },
    llm,
  };
}

/**
 * Pick the LLM provider at boot time. Precedence:
 *   1. Bedrock via explicit env creds — if both `AWS_ACCESS_KEY_ID` and
 *      `AWS_SECRET_ACCESS_KEY` are set. Highest precedence since
 *      explicit env vars always win over profiles per AWS SDK convention.
 *   2. Bedrock via AWS profile — if `AWS_PROFILE` is set (or `default`
 *      profile exists) AND `~/.aws/credentials` has matching keys.
 *      This matches AWS-native deployments where containers mount
 *      `~/.aws:/root/.aws:ro` rather than passing keys through env
 *      (see e.g. Scrible's rails service in their docker-compose).
 *   3. Anthropic direct — if `CITARE_LLM_ANTHROPIC_API_KEY` is set.
 *   4. None — no LLM wiring; `CrossRefFreetext` rescue is skipped.
 *
 * When both Bedrock AND Anthropic creds are present, Bedrock wins and
 * a warning goes to stderr so the operator knows the Anthropic key is
 * being ignored. Silent precedence would be worse.
 *
 * Bedrock adapter (in `citare/llm-bedrock`) signs requests with
 * hand-rolled SigV4 and requires explicit access key + secret — it has
 * no AWS SDK dep, so it can't resolve profile files itself. This
 * service does the profile → explicit-creds resolution at boot so the
 * adapter stays pure.
 */
function resolveLlmConfig(
  env: NodeJS.ProcessEnv,
): ServiceConfig["llm"] {
  const freetextRescue: FreetextRescueConfig = {
    minScore: numOrUndef(env.CITARE_LLM_FREETEXT_MIN_SCORE),
    minTitleOverlap: numOrUndef(env.CITARE_LLM_FREETEXT_MIN_OVERLAP),
    maxCandidates: numOrUndef(env.CITARE_LLM_FREETEXT_MAX_CANDIDATES),
    maxTokens: numOrUndef(env.CITARE_LLM_FREETEXT_MAX_TOKENS),
    temperature: numOrUndef(env.CITARE_LLM_FREETEXT_TEMPERATURE),
  };

  const envCreds = resolveBedrockCredsFromEnv(env);
  const profileCreds = envCreds ? null : resolveBedrockCredsFromProfile(env);
  const bedrockCreds = envCreds ?? profileCreds;
  const anthropicKey = env.CITARE_LLM_ANTHROPIC_API_KEY;

  if (bedrockCreds && anthropicKey) {
    // Non-fatal — we pick Bedrock but tell the operator we're ignoring
    // the Anthropic key so misconfigurations don't hide.
    // eslint-disable-next-line no-console
    console.warn(
      "[citare-service config] Both Bedrock (AWS creds) and Anthropic " +
        "(CITARE_LLM_ANTHROPIC_API_KEY) are configured. Using Bedrock; " +
        "unset one to silence this warning.",
    );
  }
  if (bedrockCreds) {
    return {
      provider: "bedrock",
      region:
        env.CITARE_LLM_BEDROCK_REGION ??
        env.AWS_REGION ??
        env.AWS_DEFAULT_REGION ??
        "us-east-1",
      modelId:
        env.CITARE_LLM_BEDROCK_MODEL ??
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      accessKeyId: bedrockCreds.accessKeyId,
      secretAccessKey: bedrockCreds.secretAccessKey,
      sessionToken: bedrockCreds.sessionToken,
      freetextRescue,
    };
  }
  if (anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      model: env.CITARE_LLM_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      freetextRescue,
    };
  }
  return { provider: "none" };
}

interface BedrockCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function resolveBedrockCredsFromEnv(env: NodeJS.ProcessEnv): BedrockCreds | null {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

/**
 * Parse `~/.aws/credentials` INI for the named profile. Supports the
 * standard keys (`aws_access_key_id`, `aws_secret_access_key`,
 * `aws_session_token`) plus `credential_process` for completeness.
 *
 * Respects `$AWS_SHARED_CREDENTIALS_FILE` for custom paths. Falls back
 * to `~/.aws/credentials`. Returns null silently on any read/parse
 * failure — LLM just gets skipped, service boots normally.
 */
function resolveBedrockCredsFromProfile(env: NodeJS.ProcessEnv): BedrockCreds | null {
  const profileName = env.AWS_PROFILE ?? "default";
  const credsPath =
    env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), ".aws", "credentials");
  let contents: string;
  try {
    contents = readFileSync(credsPath, "utf8");
  } catch {
    return null;
  }
  const profile = parseIniProfile(contents, profileName);
  if (!profile) return null;
  const accessKeyId = profile["aws_access_key_id"];
  const secretAccessKey = profile["aws_secret_access_key"];
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: profile["aws_session_token"],
  };
}

/**
 * Minimal AWS-credentials-file INI parser. Returns the named profile's
 * key/value pairs, or null if the profile isn't found. Section name
 * can be either `[profile_name]` (credentials file convention) or
 * `[profile profile_name]` (config file convention) — the latter
 * supported for completeness though credentials file is the usual home.
 */
function parseIniProfile(
  contents: string,
  profileName: string,
): Record<string, string> | null {
  let current: Record<string, string> | null = null;
  const sections: Record<string, Record<string, string>> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch && sectionMatch[1]) {
      const name = sectionMatch[1].trim().replace(/^profile\s+/, "");
      current = sections[name] ?? {};
      sections[name] = current;
      continue;
    }
    if (!current) continue;
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv || !kv[1] || kv[2] === undefined) continue;
    current[kv[1].trim()] = kv[2].trim();
  }
  return sections[profileName] ?? null;
}

function numOrUndef(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function boolOrUndef(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase().trim();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

/**
 * Parse `CITARE_STRATEGY_<NAME>_<FIELD>` env vars into a
 * `strategyOverrides` dictionary. Strategy name is the literal citare
 * strategy `name`; env var token converts `CitoidUrl` ↔ `CITOID_URL`.
 *
 * Recognized suffixes: `_ENABLED`, `_FALLBACK`, `_MIN_CURRENT_BEST_CONFIDENCE`.
 */
function parseStrategyOverrides(
  env: NodeJS.ProcessEnv,
): Record<
  string,
  { enabled?: boolean; fallback?: boolean; minCurrentBestConfidence?: number }
> {
  // Known built-in strategy names → ENV token form.
  const known = [
    "CrossRefDoi",
    "DoiInHtml",
    "Highwire",
    "CitoidDoi",
    "TranslationServer",
    "CitoidUrl",
    "ImageExtractor",
    "SchemaOrgLdJson",
    "SchemaOrgMicrodata",
    "MetaTagFallback",
    "IsbnAdapterChain",
    "OpenLibraryIsbn",
    "UrlFallback",
    "Llm",
  ] as const;
  const out: Record<
    string,
    { enabled?: boolean; fallback?: boolean; minCurrentBestConfidence?: number }
  > = {};
  for (const name of known) {
    const token = name
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase();
    const enabled = boolOrUndef(env[`CITARE_STRATEGY_${token}_ENABLED`]);
    const fallback = boolOrUndef(env[`CITARE_STRATEGY_${token}_FALLBACK`]);
    const minConf = numOrUndef(
      env[`CITARE_STRATEGY_${token}_MIN_CURRENT_BEST_CONFIDENCE`],
    );
    if (enabled !== undefined || fallback !== undefined || minConf !== undefined) {
      out[name] = {};
      if (enabled !== undefined) out[name].enabled = enabled;
      if (fallback !== undefined) out[name].fallback = fallback;
      if (minConf !== undefined) out[name].minCurrentBestConfidence = minConf;
    }
  }
  return out;
}
