import { describe, it, expect } from "vitest";

import { createServiceCache, createNoopServiceCache } from "../src/cache.js";
import type { CachedResult } from "citare";

describe("createNoopServiceCache", () => {
  it("returns null on get and silently drops sets", async () => {
    const c = createNoopServiceCache();
    await c.set("k", { csl: {}, confidence: 1 } as unknown as CachedResult);
    expect(await c.get("k")).toBeNull();
  });

  it("reports size 0 and 0/0 counters", async () => {
    const c = createNoopServiceCache();
    await c.set("k", {} as unknown as CachedResult);
    await c.get("k");
    expect(c.size()).toBe(0);
    expect(c.counters()).toEqual({ hits: 0, misses: 0 });
  });
});

function fixture(over: Partial<CachedResult> = {}): CachedResult {
  return {
    csl: { type: "webpage", title: "T" },
    confidence: 60,
    fieldConfidence: {},
    strategyName: "Stub",
    pipelineVersion: "0.2.0",
    extractedAt: new Date().toISOString(),
    ...over,
  };
}

describe("createServiceCache", () => {
  it("stores and retrieves values by key", async () => {
    const cache = createServiceCache({ max: 10, ttlMs: 60_000 });
    await cache.set("k1", fixture());
    const got = await cache.get("k1");
    expect(got?.confidence).toBe(60);
  });

  it("returns null on a cache miss", async () => {
    const cache = createServiceCache({ max: 10, ttlMs: 60_000 });
    expect(await cache.get("missing")).toBeNull();
  });

  it("counts hits and misses", async () => {
    const cache = createServiceCache({ max: 10, ttlMs: 60_000 });
    await cache.set("k1", fixture());
    await cache.get("k1"); // hit
    await cache.get("k2"); // miss
    await cache.get("k2"); // miss
    expect(cache.counters()).toEqual({ hits: 1, misses: 2 });
  });

  it("evicts oldest when max capacity reached", async () => {
    const cache = createServiceCache({ max: 2, ttlMs: 60_000 });
    await cache.set("a", fixture({ confidence: 1 }));
    await cache.set("b", fixture({ confidence: 2 }));
    await cache.set("c", fixture({ confidence: 3 }));
    // `a` is the least-recently-used; should be evicted.
    expect(await cache.get("a")).toBeNull();
    expect((await cache.get("b"))?.confidence).toBe(2);
    expect((await cache.get("c"))?.confidence).toBe(3);
  });

  it("expires entries past TTL", async () => {
    const cache = createServiceCache({ max: 10, ttlMs: 1 });
    await cache.set("k", fixture());
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get("k")).toBeNull();
  });

  it("reports current size", async () => {
    const cache = createServiceCache({ max: 10, ttlMs: 60_000 });
    expect(cache.size()).toBe(0);
    await cache.set("a", fixture());
    await cache.set("b", fixture());
    expect(cache.size()).toBe(2);
  });
});
