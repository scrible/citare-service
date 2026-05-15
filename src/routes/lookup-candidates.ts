/**
 * `POST /lookup-candidates` — SPEC §4.1 (extension: multi-result search API).
 *
 * Body is a `CandidateLookupInput` from the package SPEC §6.16. Zod
 * validates the discriminated union before handing to
 * `client.lookupCandidates`. Always returns 200 with an array of
 * `ExtractionResult`; empty array means no matches.
 */

import type { FastifyInstance } from "fastify";
import type { CandidateLookupInput } from "citare";
import { z } from "zod";

import type { CitareClient } from "../citare-client.js";

const candidateInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bookTitle"),
    title: z.string().min(1),
    author: z.string().optional(),
    maxResults: z.number().int().positive().max(25).optional(),
  }),
  z.object({
    kind: z.literal("articleTitle"),
    title: z.string().min(1),
    author: z.string().optional(),
    maxResults: z.number().int().positive().max(25).optional(),
  }),
]);

export function registerLookupCandidatesRoute(
  app: FastifyInstance,
  client: CitareClient,
) {
  app.post("/lookup-candidates", async (req, reply) => {
    const parsed = candidateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const results = await client.lookupCandidates(
      parsed.data as CandidateLookupInput,
    );
    req.log.info(
      {
        endpoint: "/lookup-candidates",
        kind: parsed.data.kind,
        count: results.length,
      },
      "requestCompleted",
    );
    return reply.send({ candidates: results });
  });
}
