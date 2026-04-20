/**
 * Smoke tests for the Phase-1 server. Each route's happy path + the
 * SPEC §4-required 401-on-missing-auth shape. Uses Fastify's `.inject`
 * so no port is allocated.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { buildServer } from "../src/server.js";

const TEST_SECRET = "test-secret-abcdefghijklmnop";

async function makeApp() {
  process.env.TEST_IBID_SERVICE_AUTH = TEST_SECRET;
  // Silence server logs during tests.
  process.env.LOG_LEVEL = "error";
  const { app } = await buildServer();
  return app;
}

describe("/health", () => {
  it("responds 200 without auth", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.ibidVersion).toBe("string");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

describe("auth", () => {
  it("401s when X-Ibid-Auth is missing on a protected route", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/parse-ris",
      headers: { "content-type": "application/json" },
      payload: { text: "TY  - JOUR\nTI  - X\nER  - " },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("401s when X-Ibid-Auth is wrong", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/parse-ris",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": "wrong-secret",
      },
      payload: { text: "TY  - JOUR\nTI  - X\nER  - " },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("/parse-ris", () => {
  it("returns CSL for a minimal RIS record", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/parse-ris",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { text: "TY  - JOUR\nTI  - Sample title\nAU  - Doe, Jane\nER  - \n" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.csl.type).toBe("article-journal");
    expect(body.csl.title).toBe("Sample title");
    expect(body.csl.author).toEqual([{ family: "Doe", given: "Jane" }]);
    expect(Array.isArray(body.warnings)).toBe(true);
    await app.close();
  });

  it("400s on missing text", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/parse-ris",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("/normalize", () => {
  it("strips tracking params from URL + trims title", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/normalize",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: {
        csl: {
          type: "article-journal",
          title: "  foo  ",
          URL: "https://x.com/?utm_source=y&id=1",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.csl.title).toBe("foo");
    expect(body.csl.URL).toBe("https://x.com/?id=1");
    expect(body.warnings[0]).toMatch(/Canonical URL rewritten/);
    await app.close();
  });
});

describe("/extract", () => {
  it("400s on unknown kind", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/extract",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { kind: "nope" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns a stable ExtractionResult shape for a text-kind empty run", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/extract",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { kind: "text", text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.csl).toEqual({});
    expect(body.confidence).toBe(0);
    expect(body.strategyName).toBeNull();
    expect(body.provenance.inputKind).toBe("text");
    await app.close();
  });
});

describe("/metrics", () => {
  it("exposes Prometheus text after at least one request", async () => {
    const app = await makeApp();
    // Warm up: one health call + one parse-ris call.
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({
      method: "POST",
      url: "/parse-ris",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { text: "TY  - JOUR\nER  - " },
    });
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-ibid-auth": TEST_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/ibid_requests_total/);
    expect(res.body).toMatch(/ibid_request_duration_ms/);
    await app.close();
  });

  it("requires auth", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("config", () => {
  beforeAll(() => {
    delete process.env.IBID_SERVICE_AUTH;
  });

  it("refuses to start without a secret", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() =>
      loadConfig({} as NodeJS.ProcessEnv),
    ).toThrow(/16\+ character/);
  });
});
