/**
 * /lookup-candidates route smoke. Happy path + auth + validation.
 */

import { describe, it, expect } from "vitest";

import { buildServer } from "../src/server.js";

const TEST_SECRET = "test-secret-abcdefghijklmnop";

async function makeApp() {
  process.env.TEST_CITARE_SERVICE_AUTH = TEST_SECRET;
  process.env.LOG_LEVEL = "error";
  const { app } = await buildServer();
  return app;
}

describe("/lookup-candidates", () => {
  it("401s without X-Citare-Auth", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/lookup-candidates",
      payload: { kind: "bookTitle", title: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400s on invalid body", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/lookup-candidates",
      headers: { "x-citare-auth": TEST_SECRET },
      payload: { kind: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("200s with empty candidates array when no adapters configured", async () => {
    const app = await makeApp();
    // No isbnAdapters → bookTitle query yields [].
    const res = await app.inject({
      method: "POST",
      url: "/lookup-candidates",
      headers: { "x-citare-auth": TEST_SECRET },
      payload: { kind: "bookTitle", title: "nothing" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toEqual([]);
    await app.close();
  });
});
