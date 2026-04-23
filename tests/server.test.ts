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
  // Hermetic LLM config — the host's ~/.aws/credentials would otherwise
  // auto-wire a Bedrock adapter and register the Llm strategy, which
  // these tests explicitly assert is off.
  process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent-ibid-service-test-path";
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

describe("/extract — upstream budget", () => {
  it("429s with retry-after when the crossref bucket is empty", async () => {
    process.env.IBID_BUDGET_CROSSREF_CAPACITY = "1";
    process.env.IBID_BUDGET_CROSSREF_REFILL_PER_SEC = "0.001"; // no meaningful refill during the test
    const app = await makeApp();
    // First DOI call consumes the single token.
    const first = await app.inject({
      method: "POST",
      url: "/extract",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { kind: "doi", doi: "10.1000/fake" },
    });
    expect(first.statusCode).toBe(200);
    // Second call within the same second → 429.
    const second = await app.inject({
      method: "POST",
      url: "/extract",
      headers: {
        "content-type": "application/json",
        "x-ibid-auth": TEST_SECRET,
      },
      payload: { kind: "doi", doi: "10.1000/fake2" },
    });
    expect(second.statusCode).toBe(429);
    const body = second.json();
    expect(body.error).toBe("upstream_budget");
    expect(body.upstream).toBe("crossref");
    expect(second.headers["retry-after"]).toBeDefined();
    delete process.env.IBID_BUDGET_CROSSREF_CAPACITY;
    delete process.env.IBID_BUDGET_CROSSREF_REFILL_PER_SEC;
    await app.close();
  });

  it("does not gate html-kind inputs (no dedicated upstream)", async () => {
    process.env.IBID_BUDGET_CITOID_CAPACITY = "1";
    process.env.IBID_BUDGET_CITOID_REFILL_PER_SEC = "0.001";
    const app = await makeApp();
    // Two html calls in a row — neither consumes the citoid bucket because
    // the gate only fires for url/doi/isbn inputs.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/extract",
        headers: {
          "content-type": "application/json",
          "x-ibid-auth": TEST_SECRET,
        },
        payload: { kind: "html", html: "<html></html>" },
      });
      expect(res.statusCode).toBe(200);
    }
    delete process.env.IBID_BUDGET_CITOID_CAPACITY;
    delete process.env.IBID_BUDGET_CITOID_REFILL_PER_SEC;
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

describe("LLM adapter wiring", () => {
  it("registers the Llm strategy when IBID_LLM_ANTHROPIC_API_KEY is set", async () => {
    process.env.TEST_IBID_SERVICE_AUTH = TEST_SECRET;
    process.env.IBID_LLM_ANTHROPIC_API_KEY = "test-key";
    const { buildServer } = await import("../src/server.js");
    const { client, app } = await buildServer();
    expect(client.listStrategies().map((s) => s.name)).toContain("Llm");
    delete process.env.IBID_LLM_ANTHROPIC_API_KEY;
    await app.close();
  });

  it("does not register Llm strategy when no key is set", async () => {
    process.env.TEST_IBID_SERVICE_AUTH = TEST_SECRET;
    delete process.env.IBID_LLM_ANTHROPIC_API_KEY;
    const { buildServer } = await import("../src/server.js");
    const { client, app } = await buildServer();
    expect(client.listStrategies().map((s) => s.name)).not.toContain("Llm");
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
