/**
 * Scoring unit tests. Covers the 6-dim rubric in isolation by calling
 * the exported helpers the scorer uses. Keeps the signatures stable so
 * downstream consumers (e.g. the host-app eval) can depend on
 * them without reaching into private internals.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Black-box: drive the score CLI via tsx on a tiny synthetic run.
describe("score CLI (black box)", () => {
  it("produces multi-summary.md + multi-scores.json from a 2-variant run", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-score-"));
    try {
      const resultsDir = join(root, "results");
      mkdirSync(resultsDir, { recursive: true });

      const expected = {
        title: "Foo Bar",
        DOI: "10.1/x",
        type: "article-journal",
      };
      const item = {
        op: "crossref_doi_lookup" as const,
        id: "doi-1",
        expected,
        baseline_pre: expected,
        citare_solo: { ...expected, DOI: undefined },
        baseline_post: expected,
        baseline_pre_ms: 100,
        citare_solo_ms: 50,
        baseline_post_ms: 80,
      };
      writeFileSync(
        join(resultsDir, "raw-v1.jsonl"),
        JSON.stringify(item) + "\n",
      );
      writeFileSync(
        join(resultsDir, "raw-v2.jsonl"),
        JSON.stringify({ ...item, baseline_post_ms: 60 }) + "\n",
      );
      writeFileSync(join(resultsDir, "llm-calls-v1.jsonl"), "");
      writeFileSync(join(resultsDir, "llm-calls-v2.jsonl"), "");

      const config = {
        corpus: {},
        opsEnabled: ["crossref_doi_lookup"],
        variants: [
          { name: "v1", provider: "none", usdPerMtokIn: 0, usdPerMtokOut: 0 },
          { name: "v2", provider: "none", usdPerMtokIn: 0, usdPerMtokOut: 0 },
        ],
        resultsDir,
      };
      const cfgPath = join(root, "cfg.json");
      writeFileSync(cfgPath, JSON.stringify(config));

      const scoreTs = join(__dirname, "..", "score.ts");
      const res = spawnSync(
        process.execPath,
        [require.resolve("tsx/cli"), scoreTs, "--config", cfgPath],
        { encoding: "utf8" },
      );
      if (res.status !== 0) {
        throw new Error(
          `score CLI failed: ${res.status}\n${res.stdout}\n${res.stderr}`,
        );
      }
      expect(existsSync(join(resultsDir, "multi-summary.md"))).toBe(true);
      const scores = JSON.parse(
        readFileSync(join(resultsDir, "multi-scores.json"), "utf8"),
      );
      expect(scores.postPerVariant.v1).toBeDefined();
      expect(scores.postPerVariant.v2).toBeDefined();
      // baseline_pre is perfect → baseline donor picked, pre cells populated.
      expect(scores.baselineWeighted).not.toBeNull();
      expect(scores.baselinePerOp.crossref_doi_lookup.pre.aggregate).toBeGreaterThan(0.5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
