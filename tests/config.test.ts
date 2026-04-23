import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    IBID_SERVICE_AUTH: "0123456789abcdef0123",
    // Force hermetic credential resolution — no accidental read of the
    // host's real ~/.aws/credentials during tests. Individual tests that
    // exercise profile resolution override this.
    AWS_SHARED_CREDENTIALS_FILE: "/nonexistent-ibid-service-test-path",
    ...extra,
  } as NodeJS.ProcessEnv;
}

/** Write a credentials INI to a temp file and return its path. */
function writeCredsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ibid-service-creds-"));
  const path = join(dir, "credentials");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loadConfig — IBID_CACHE_ENABLED", () => {
  it("defaults to true when unset", () => {
    const cfg = loadConfig(env());
    expect(cfg.cache.enabled).toBe(true);
  });
  it("false when IBID_CACHE_ENABLED=false", () => {
    const cfg = loadConfig(env({ IBID_CACHE_ENABLED: "false" }));
    expect(cfg.cache.enabled).toBe(false);
  });
  it("true when IBID_CACHE_ENABLED=true", () => {
    const cfg = loadConfig(env({ IBID_CACHE_ENABLED: "true" }));
    expect(cfg.cache.enabled).toBe(true);
  });
});

describe("loadConfig — LLM provider selection", () => {
  it("provider=none when no creds present", () => {
    const cfg = loadConfig(env());
    expect(cfg.llm.provider).toBe("none");
  });

  it("picks Anthropic when only IBID_LLM_ANTHROPIC_API_KEY set", () => {
    const cfg = loadConfig(env({ IBID_LLM_ANTHROPIC_API_KEY: "sk-ant-test" }));
    if (cfg.llm.provider !== "anthropic") throw new Error("wrong provider");
    expect(cfg.llm.apiKey).toBe("sk-ant-test");
    expect(cfg.llm.model).toBe("claude-haiku-4-5-20251001");
  });

  it("picks Bedrock when AWS creds set (both access+secret)", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      AWS_REGION: "us-west-2",
    }));
    if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
    expect(cfg.llm.region).toBe("us-west-2");
    expect(cfg.llm.accessKeyId).toBe("AKIA-test");
    expect(cfg.llm.modelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(cfg.llm.sessionToken).toBeUndefined();
  });

  it("honors IBID_LLM_BEDROCK_REGION over AWS_REGION", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      AWS_REGION: "us-east-1",
      IBID_LLM_BEDROCK_REGION: "us-west-2",
    }));
    if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
    expect(cfg.llm.region).toBe("us-west-2");
  });

  it("honors IBID_LLM_BEDROCK_MODEL override (e.g. Nova Lite)", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      IBID_LLM_BEDROCK_MODEL: "us.amazon.nova-lite-v1:0",
    }));
    if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
    expect(cfg.llm.modelId).toBe("us.amazon.nova-lite-v1:0");
  });

  it("passes through AWS_SESSION_TOKEN for STS credentials", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      AWS_SESSION_TOKEN: "sts-session-token",
    }));
    if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
    expect(cfg.llm.sessionToken).toBe("sts-session-token");
  });

  it("Bedrock wins when both Bedrock and Anthropic configured", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      IBID_LLM_ANTHROPIC_API_KEY: "sk-ant-also-set",
    }));
    expect(cfg.llm.provider).toBe("bedrock");
  });

  it("ignores half-set AWS creds (only access key, no secret)", () => {
    const cfg = loadConfig(env({ AWS_ACCESS_KEY_ID: "AKIA-test" }));
    expect(cfg.llm.provider).toBe("none");
  });

  describe("Bedrock via AWS_PROFILE (matches AWS SDK convention)", () => {
    it("resolves a named profile from a credentials file", () => {
      const path = writeCredsFile(`
[scrible-dev]
aws_access_key_id = AKIA-FROM-PROFILE
aws_secret_access_key = secret-from-profile
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "scrible-dev",
          AWS_SHARED_CREDENTIALS_FILE: path,
        }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.accessKeyId).toBe("AKIA-FROM-PROFILE");
        expect(cfg.llm.secretAccessKey).toBe("secret-from-profile");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("picks the `default` profile when AWS_PROFILE is unset", () => {
      const path = writeCredsFile(`
[default]
aws_access_key_id = AKIA-DEFAULT
aws_secret_access_key = secret-default

[scrible-dev]
aws_access_key_id = AKIA-OTHER
aws_secret_access_key = secret-other
`);
      try {
        const cfg = loadConfig(env({ AWS_SHARED_CREDENTIALS_FILE: path }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.accessKeyId).toBe("AKIA-DEFAULT");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("env vars win when both profile AND explicit env creds are set", () => {
      const path = writeCredsFile(`
[scrible-dev]
aws_access_key_id = AKIA-FROM-PROFILE
aws_secret_access_key = secret-from-profile
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "scrible-dev",
          AWS_SHARED_CREDENTIALS_FILE: path,
          AWS_ACCESS_KEY_ID: "AKIA-FROM-ENV",
          AWS_SECRET_ACCESS_KEY: "secret-from-env",
        }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.accessKeyId).toBe("AKIA-FROM-ENV");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("captures aws_session_token when present", () => {
      const path = writeCredsFile(`
[sts-session]
aws_access_key_id = ASIA-TEMP
aws_secret_access_key = temp-secret
aws_session_token = sts-token-from-profile
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "sts-session",
          AWS_SHARED_CREDENTIALS_FILE: path,
        }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.sessionToken).toBe("sts-token-from-profile");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("silently falls back to provider=none when creds file is missing", () => {
      const cfg = loadConfig(env({
        AWS_PROFILE: "scrible-dev",
        AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/path/credentials",
      }));
      expect(cfg.llm.provider).toBe("none");
    });

    it("silently falls back when profile not found in file", () => {
      const path = writeCredsFile(`
[some-other-profile]
aws_access_key_id = AKIA-OTHER
aws_secret_access_key = secret-other
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "scrible-dev",
          AWS_SHARED_CREDENTIALS_FILE: path,
        }));
        expect(cfg.llm.provider).toBe("none");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("handles comments + blank lines in the credentials file", () => {
      const path = writeCredsFile(`
# top-level comment
; another comment style

[scrible-dev]
# inline-ish
aws_access_key_id = AKIA-PARSED
aws_secret_access_key = secret-parsed  ; trailing comment should strip

[other]
aws_access_key_id = IGNORED
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "scrible-dev",
          AWS_SHARED_CREDENTIALS_FILE: path,
        }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.accessKeyId).toBe("AKIA-PARSED");
        expect(cfg.llm.secretAccessKey).toBe("secret-parsed");
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("supports `[profile foo]` section name convention (config file style)", () => {
      const path = writeCredsFile(`
[profile scrible-dev]
aws_access_key_id = AKIA-CFGFILE
aws_secret_access_key = secret-cfgfile
`);
      try {
        const cfg = loadConfig(env({
          AWS_PROFILE: "scrible-dev",
          AWS_SHARED_CREDENTIALS_FILE: path,
        }));
        if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
        expect(cfg.llm.accessKeyId).toBe("AKIA-CFGFILE");
      } finally {
        rmSync(path, { force: true });
      }
    });
  });

  it("freetextRescue tuning env vars flow through to the picked provider", () => {
    const cfg = loadConfig(env({
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret-test",
      IBID_LLM_FREETEXT_MIN_SCORE: "42",
      IBID_LLM_FREETEXT_MAX_TOKENS: "256",
    }));
    if (cfg.llm.provider !== "bedrock") throw new Error("wrong provider");
    expect(cfg.llm.freetextRescue?.minScore).toBe(42);
    expect(cfg.llm.freetextRescue?.maxTokens).toBe(256);
  });
});

describe("loadConfig — strategyOverrides", () => {
  it("is empty by default", () => {
    const cfg = loadConfig(env());
    expect(cfg.ibid.strategyOverrides).toEqual({});
  });

  it("parses IBID_STRATEGY_CITOID_URL_FALLBACK=true", () => {
    const cfg = loadConfig(env({ IBID_STRATEGY_CITOID_URL_FALLBACK: "true" }));
    expect(cfg.ibid.strategyOverrides).toEqual({
      CitoidUrl: { fallback: true },
    });
  });

  it("parses IBID_STRATEGY_LLM_ENABLED=false", () => {
    const cfg = loadConfig(env({ IBID_STRATEGY_LLM_ENABLED: "false" }));
    expect(cfg.ibid.strategyOverrides).toEqual({ Llm: { enabled: false } });
  });

  it("combines multiple fields on one strategy", () => {
    const cfg = loadConfig(
      env({
        IBID_STRATEGY_CITOID_URL_FALLBACK: "true",
        IBID_STRATEGY_CITOID_URL_MIN_CURRENT_BEST_CONFIDENCE: "40",
      }),
    );
    expect(cfg.ibid.strategyOverrides).toEqual({
      CitoidUrl: { fallback: true, minCurrentBestConfidence: 40 },
    });
  });

  it("ignores unrecognized strategy names silently at env layer", () => {
    // Env vars for non-existent strategies aren't surfaced; the library
    // will warn if the name reaches it via an explicit config, but env
    // parsing only looks at the known built-in list.
    const cfg = loadConfig(env({ IBID_STRATEGY_NOT_A_REAL_ENABLED: "false" }));
    expect(cfg.ibid.strategyOverrides).toEqual({});
  });

  it("tokenizes camelCase → SNAKE_CASE correctly", () => {
    const cfg = loadConfig(
      env({
        IBID_STRATEGY_CROSS_REF_DOI_ENABLED: "false",
        IBID_STRATEGY_SCHEMA_ORG_LD_JSON_FALLBACK: "true",
      }),
    );
    expect(cfg.ibid.strategyOverrides).toEqual({
      CrossRefDoi: { enabled: false },
      SchemaOrgLdJson: { fallback: true },
    });
  });
});
