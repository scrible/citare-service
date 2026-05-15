/**
 * `GET /metrics` — SPEC §4.9. Prometheus text format.
 *
 * Surfaces: request counter + duration histogram (wired from a global hook),
 * cache hit/miss counters (gauges sampled from the service cache), upstream
 * budget-deny counter (incremented by the `/extract` gate), and per-strategy
 * run outcome counters (incremented by `/extract` after each call from the
 * structured `provenance.ranStrategies`).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

import type { ServiceCache } from "../cache.js";
import type { Upstream } from "../upstream-budget.js";

export interface MetricsBundle {
  registry: Registry;
  requestsTotal: Counter<"endpoint" | "status">;
  requestDuration: Histogram<"endpoint" | "status">;
  cacheHitsTotal: Counter<never>;
  cacheMissesTotal: Counter<never>;
  cacheSize: Gauge<never>;
  budgetDeniedTotal: Counter<"upstream">;
  strategyRunsTotal: Counter<"strategy" | "outcome">;
}

export function createMetrics(): MetricsBundle {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requestsTotal = new Counter({
    name: "citare_requests_total",
    help: "Total number of /extract /normalize /parse-* requests seen.",
    labelNames: ["endpoint", "status"],
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "citare_request_duration_ms",
    help: "Service-side request latency in milliseconds.",
    labelNames: ["endpoint", "status"],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000],
    registers: [registry],
  });
  const cacheHitsTotal = new Counter({
    name: "citare_cache_hits_total",
    help: "Cache hits on the in-memory LRU.",
    registers: [registry],
  });
  const cacheMissesTotal = new Counter({
    name: "citare_cache_misses_total",
    help: "Cache misses on the in-memory LRU.",
    registers: [registry],
  });
  const cacheSize = new Gauge({
    name: "citare_cache_size",
    help: "Current number of entries in the in-memory LRU cache.",
    registers: [registry],
  });
  const budgetDeniedTotal = new Counter({
    name: "citare_budget_denied_total",
    help: "Count of /extract requests denied by per-upstream rate limits.",
    labelNames: ["upstream"],
    registers: [registry],
  });
  const strategyRunsTotal = new Counter({
    name: "citare_strategy_runs_total",
    help: "Count of ExtractionStrategy runs keyed by strategy name and outcome.",
    labelNames: ["strategy", "outcome"],
    registers: [registry],
  });
  return {
    registry,
    requestsTotal,
    requestDuration,
    cacheHitsTotal,
    cacheMissesTotal,
    cacheSize,
    budgetDeniedTotal,
    strategyRunsTotal,
  };
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

export function recordCacheCounters(
  metrics: MetricsBundle,
  cache: ServiceCache,
) {
  const { hits, misses } = cache.counters();
  const hitDelta = hits - (recordCacheCounters._lastHits ?? 0);
  const missDelta = misses - (recordCacheCounters._lastMisses ?? 0);
  if (hitDelta > 0) metrics.cacheHitsTotal.inc(hitDelta);
  if (missDelta > 0) metrics.cacheMissesTotal.inc(missDelta);
  metrics.cacheSize.set(cache.size());
  recordCacheCounters._lastHits = hits;
  recordCacheCounters._lastMisses = misses;
}
recordCacheCounters._lastHits = 0 as number | undefined;
recordCacheCounters._lastMisses = 0 as number | undefined;

export function recordBudgetDeny(
  metrics: MetricsBundle,
  upstream: Upstream,
) {
  metrics.budgetDeniedTotal.labels({ upstream }).inc();
}

export function registerMetricsRoute(
  app: FastifyInstance,
  metrics: MetricsBundle,
  cache: ServiceCache,
) {
  app.get("/metrics", async (_req, reply) => {
    // Sample cache counters at scrape time; the cache owns the authoritative
    // tally, we just mirror deltas into prom counters.
    recordCacheCounters(metrics, cache);
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
