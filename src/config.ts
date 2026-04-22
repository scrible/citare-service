/**
 * Env-derived service configuration. SPEC §7.
 *
 * Fail-fast: refuse to start without a shared secret. Tests pass a fake
 * secret via `TEST_IBID_SERVICE_AUTH`, keeping production defaults strict.
 */

export interface ServiceConfig {
  port: number;
  authSecret: string;
  logLevel: "debug" | "info" | "warn" | "error";
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  ibid: {
    userAgent: string;
    crossrefEndpoint: string;
    citoidEndpoint: string;
    /** Optional self-hosted Zotero translation-server endpoint. Empty → unset. */
    translationServerEndpoint: string;
    timeoutMs: number;
  };
  cache: {
    max: number;
    ttlMs: number;
  };
  budget: {
    crossref: { capacity: number; refillPerSec: number };
    citoid: { capacity: number; refillPerSec: number };
    openlibrary: { capacity: number; refillPerSec: number };
  };
  llm:
    | { provider: "anthropic"; apiKey: string; model: string }
    | { provider: "none" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const authSecret = env.IBID_SERVICE_AUTH ?? env.TEST_IBID_SERVICE_AUTH;
  if (!authSecret || authSecret.length < 16) {
    throw new Error(
      "IBID_SERVICE_AUTH must be set to a 16+ character secret before startup",
    );
  }
  const anthropicKey = env.IBID_LLM_ANTHROPIC_API_KEY;
  return {
    port: Number(env.PORT ?? 3000),
    authSecret,
    logLevel: (env.LOG_LEVEL as ServiceConfig["logLevel"]) ?? "info",
    bodyLimitBytes: Number(env.BODY_LIMIT_BYTES ?? 2 * 1024 * 1024),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 10_000),
    ibid: {
      userAgent:
        env.IBID_USER_AGENT ??
        "ibid-service/0.1.0 (+https://github.com/bwthomas/ibid-service)",
      crossrefEndpoint:
        env.IBID_CROSSREF_ENDPOINT ?? "https://api.crossref.org",
      citoidEndpoint:
        env.IBID_CITOID_ENDPOINT ??
        "https://en.wikipedia.org/api/rest_v1/data/citation",
      translationServerEndpoint: env.IBID_TRANSLATION_SERVER_URL ?? "",
      timeoutMs: Number(env.IBID_TIMEOUT_MS ?? 5_000),
    },
    cache: {
      max: Number(env.IBID_CACHE_MAX ?? 10_000),
      ttlMs: Number(env.IBID_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000),
    },
    budget: {
      crossref: {
        capacity: Number(env.IBID_BUDGET_CROSSREF_CAPACITY ?? 50),
        refillPerSec: Number(env.IBID_BUDGET_CROSSREF_REFILL_PER_SEC ?? 50),
      },
      citoid: {
        capacity: Number(env.IBID_BUDGET_CITOID_CAPACITY ?? 30),
        refillPerSec: Number(env.IBID_BUDGET_CITOID_REFILL_PER_SEC ?? 30),
      },
      openlibrary: {
        capacity: Number(env.IBID_BUDGET_OPENLIBRARY_CAPACITY ?? 20),
        refillPerSec: Number(env.IBID_BUDGET_OPENLIBRARY_REFILL_PER_SEC ?? 20),
      },
    },
    llm: anthropicKey
      ? {
          provider: "anthropic",
          apiKey: anthropicKey,
          model: env.IBID_LLM_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        }
      : { provider: "none" },
  };
}
