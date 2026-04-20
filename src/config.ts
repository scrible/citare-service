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
    timeoutMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const authSecret = env.IBID_SERVICE_AUTH ?? env.TEST_IBID_SERVICE_AUTH;
  if (!authSecret || authSecret.length < 16) {
    throw new Error(
      "IBID_SERVICE_AUTH must be set to a 16+ character secret before startup",
    );
  }
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
      timeoutMs: Number(env.IBID_TIMEOUT_MS ?? 5_000),
    },
  };
}
