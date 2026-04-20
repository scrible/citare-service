/**
 * `GET /metrics` — SPEC §4.9. Prometheus text format.
 *
 * Phase-1 surface: request counter + duration histogram, wired from the
 * global request hook. Strategy/upstream/cache counters (the other four
 * families listed in SPEC §4.9) are Phase-2 work; the routes still exist
 * so scrapers don't error on missing endpoints.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface MetricsBundle {
  registry: Registry;
  requestsTotal: Counter<"endpoint" | "status">;
  requestDuration: Histogram<"endpoint" | "status">;
}

export function createMetrics(): MetricsBundle {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requestsTotal = new Counter({
    name: "ibid_requests_total",
    help: "Total number of /extract /normalize /parse-* requests seen.",
    labelNames: ["endpoint", "status"],
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "ibid_request_duration_ms",
    help: "Service-side request latency in milliseconds.",
    labelNames: ["endpoint", "status"],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000],
    registers: [registry],
  });
  return { registry, requestsTotal, requestDuration };
}

export function installMetricsHooks(
  app: FastifyInstance,
  metrics: MetricsBundle,
) {
  app.addHook("onRequest", async (req) => {
    (req as FastifyRequest & { _startedAt?: number })._startedAt = Date.now();
  });
  app.addHook("onResponse", async (req, reply) => {
    const started = (req as FastifyRequest & { _startedAt?: number })._startedAt;
    if (!started) return;
    const elapsed = Date.now() - started;
    const endpoint = req.routeOptions?.url ?? req.url.split("?")[0];
    const status = String(reply.statusCode);
    metrics.requestsTotal.labels({ endpoint, status }).inc();
    metrics.requestDuration.labels({ endpoint, status }).observe(elapsed);
  });
}

export function registerMetricsRoute(
  app: FastifyInstance,
  metrics: MetricsBundle,
) {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
