/**
 * `POST /extract` — SPEC §4.1.
 *
 * Body is an `ExtractInput` from the package SPEC §5.1. Zod validates the
 * discriminated union before handing to `client.extract`. Always returns 200
 * with a full `ExtractionResult` — even for confidence-0 empty runs — per
 * SPEC §5 "no-metadata is not a server error."
 */

import type { FastifyInstance } from "fastify";
import type { ExtractInput } from "@bwthomas/ibid";
import { z } from "zod";

import type { IbidClient } from "../ibid-client.js";

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

export function registerExtractRoute(app: FastifyInstance, client: IbidClient) {
  app.post("/extract", async (req, reply) => {
    const parsed = extractInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    // Zod's `z.unknown()` infers as optional; cast to the SPEC-typed union
    // after the validation guard, which has already ensured the body shape.
    const result = await client.extract(parsed.data as ExtractInput);
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
