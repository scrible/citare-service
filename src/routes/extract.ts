/**
 * `POST /extract` — SPEC §4.1.
 *
 * Body is an `ExtractInput` from the package SPEC §5.1. Zod validates the
 * discriminated union before handing to `client.extract`. Always returns 200
 * with a full `ExtractionResult` — even for confidence-0 empty runs — per
 * SPEC §5 "no-metadata is not a server error." Exceptions are the budget
 * gate (429) and body-validation failures (400).
 */

import type { FastifyInstance } from "fastify";
import type { ExtractInput } from "citare";
import { z } from "zod";

import type { CitareClient } from "../citare-client.js";
import {
  recordBudgetDeny,
  type MetricsBundle,
} from "./metrics.js";
import {
  upstreamForInputKind,
  type UpstreamBudget,
} from "../upstream-budget.js";

// `document` kind is intentionally excluded from the HTTP API — a pre-parsed
// DOM document isn't JSON-serializable. Callers who have parsed HTML should
// send it as `{kind: 'html', html}`.
const extractInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({
    kind: z.literal("html"),
    html: z.string(),
    url: z.string().url().optional(),
  }),
  z.object({ kind: z.literal("doi"), doi: z.string().min(3) }),
  z.object({ kind: z.literal("isbn"), isbn: z.string().min(5) }),
  z.object({ kind: z.literal("ris"), text: z.string().min(1) }),
  z.object({ kind: z.literal("easybib"), payload: z.unknown() }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1),
    hints: z
      .object({
        suspectedDoi: z.string().optional(),
        suspectedTitle: z.string().optional(),
        source: z.enum(["pdf", "paste", "ocr", "unknown"]).optional(),
      })
      .optional(),
  }),
]);

export function registerExtractRoute(
  app: FastifyInstance,
  client: CitareClient,
  budget: UpstreamBudget,
  metrics: MetricsBundle,
) {
  app.post("/extract", async (req, reply) => {
    const parsed = extractInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const upstream = upstreamForInputKind(parsed.data.kind);
    if (upstream) {
      const gate = budget.check(upstream);
      if (!gate.ok) {
        recordBudgetDeny(metrics, gate.upstream);
        return reply
          .code(429)
          .header("retry-after", String(gate.retryAfterSec))
          .send({
            error: "upstream_budget",
            upstream: gate.upstream,
            retryAfterSec: gate.retryAfterSec,
          });
      }
    }
    // Zod's `z.unknown()` infers as optional; cast to the SPEC-typed union
    // after the validation guard, which has already ensured the body shape.
    const result = await client.extract(parsed.data as ExtractInput);

    // Record strategy outcomes for metrics. Every entry in ranStrategies has
    // either a confidence (ran and produced a result) or a reason (skipped /
    // errored). Outcome buckets: "success" (confidence > 0), "empty"
    // (ran, confidence 0), "skipped" (reason present, never ran).
    for (const r of result.provenance.ranStrategies) {
      const outcome = r.reason
        ? "skipped"
        : r.confidence > 0
          ? "success"
          : "empty";
      metrics.strategyRunsTotal.labels({ strategy: r.name, outcome }).inc();
    }

    req.log.info(
      {
        endpoint: "/extract",
        strategyName: result.strategyName,
        confidence: result.confidence,
        durationMs: result.provenance.durationMs,
        inputKind: parsed.data.kind,
      },
      "requestCompleted",
    );
    return reply.send(result);
  });
}
