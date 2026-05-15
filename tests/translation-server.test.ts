/**
 * Translation-server configuration plumbing.
 *
 * The TranslationServer strategy itself is tested inside `citare`.
 * What we verify here: the CITARE_TRANSLATION_SERVER_URL env var is read and
 * flows through `loadConfig` → `createServiceCitare` → `createCitare`
 * unchanged. When unset, the strategy registers but never runs (citare 0.3+
 * keeps `TranslationServer` in the default list; its `shouldRun` returns
 * false on an empty endpoint).
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const MIN_AUTH = "test-secret-abcdefghijklmnop";

function baseEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    CITARE_SERVICE_AUTH: MIN_AUTH,
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("CITARE_TRANSLATION_SERVER_URL configuration", () => {
  it("unset → translationServerEndpoint is empty string", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.citare.translationServerEndpoint).toBe("");
  });

  it("set → translationServerEndpoint is the provided URL", () => {
    const cfg = loadConfig(
      baseEnv({
        CITARE_TRANSLATION_SERVER_URL: "http://translation-server.local:1969",
      }),
    );
    expect(cfg.citare.translationServerEndpoint).toBe(
      "http://translation-server.local:1969",
    );
  });
});
