/**
 * `ibid-service` — HTTP wrapper around @bwthomas/ibid.
 *
 * Single-process Fastify server. All routes except `/health` require the
 * `X-Ibid-Auth` header (SPEC §4 preface). Graceful shutdown on SIGTERM.
 *
 * This file is intentionally thin: it boots config, constructs the shared
 * ibid client, wires metrics + auth, and registers routes. Per-route logic
 * lives in `src/routes/`.
 */

import Fastify from "fastify";
import { randomUUID } from "node:crypto";

import { makeAuthHook } from "./auth.js";
import { loadConfig } from "./config.js";
import { createServiceIbid } from "./ibid-client.js";
import { registerExtractRoute } from "./routes/extract.js";
import { registerHealthRoute } from "./routes/health.js";
import {
  createMetrics,
  installMetricsHooks,
  registerMetricsRoute,
} from "./routes/metrics.js";
import { registerNormalizeRoute } from "./routes/normalize.js";
import { registerParserRoutes } from "./routes/parsers.js";

export async function buildServer(
  configOverride?: Parameters<typeof loadConfig>[0],
) {
  const config = loadConfig(configOverride);
  const startedAt = Date.now();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty" },
    },
    bodyLimit: config.bodyLimitBytes,
    genReqId: () => randomUUID().slice(0, 8),
  });

  // Metrics hooks run before anything else so they capture every request.
  const metrics = createMetrics();
  installMetricsHooks(app, metrics);

  // `/health` must be unauthenticated so HAProxy probes don't need the secret.
  registerHealthRoute(app, startedAt);

  // Everything below requires auth.
  const authHook = makeAuthHook(config.authSecret);
  const client = createServiceIbid(config, {
    debug: (msg, meta) => app.log.debug(meta ?? {}, msg),
    info: (msg, meta) => app.log.info(meta ?? {}, msg),
    warn: (msg, meta) => app.log.warn(meta ?? {}, msg),
    error: (msg, meta) => app.log.error(meta ?? {}, msg),
  });

  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authHook);
    registerExtractRoute(protectedApp, client);
    registerNormalizeRoute(protectedApp);
    registerParserRoutes(protectedApp, client);
    registerMetricsRoute(protectedApp, metrics);
  });

  return { app, config, client, metrics, startedAt };
}

// Entrypoint: only run when executed directly, not when imported by tests.
const isDirectlyRun = process.argv[1]?.endsWith("server.js");
if (isDirectlyRun) {
  const { app, config } = await buildServer();
  const close = async () => {
    app.log.info("received SIGTERM — shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown error");
      process.exit(1);
    }
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}
