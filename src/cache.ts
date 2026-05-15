/**
 * In-memory LRU cache implementing citare's `CacheAdapter`. SPEC §9.
 *
 * The package owns the key format (citare:v1:{doi|canonical_url|isbn}); this
 * module just stores and evicts. TTL is uniform — pipelineVersion mismatches
 * are ignored on read by the package's merge step, so a stale entry loses
 * cleanly on its own.
 */

import { LRUCache } from "lru-cache";
import type { CacheAdapter, CachedResult } from "citare";

export interface CacheCounters {
  hits: number;
  misses: number;
}

export interface ServiceCache extends CacheAdapter {
  counters(): CacheCounters;
  size(): number;
}

export function createServiceCache(options: {
  max: number;
  ttlMs: number;
}): ServiceCache {
  const lru = new LRUCache<string, CachedResult>({
    max: options.max,
    ttl: options.ttlMs,
  });
  let hits = 0;
  let misses = 0;
  return {
    async get(key: string): Promise<CachedResult | null> {
      const value = lru.get(key);
      if (value) {
        hits++;
        return value;
      }
      misses++;
      return null;
    },
    async set(key: string, value: CachedResult): Promise<void> {
      lru.set(key, value);
    },
    counters: () => ({ hits, misses }),
    size: () => lru.size,
  };
}

/**
 * No-op ServiceCache used when `CITARE_CACHE_ENABLED=false` at the env
 * layer. Returns null on every get, drops every set, reports size 0
 * and 0/0 hits/misses. Lets operators disable a configured cache
 * backend during incidents without a redeploy.
 */
export function createNoopServiceCache(): ServiceCache {
  return {
    async get(): Promise<CachedResult | null> {
      return null;
    },
    async set(): Promise<void> {},
    counters: () => ({ hits: 0, misses: 0 }),
    size: () => 0,
  };
}
