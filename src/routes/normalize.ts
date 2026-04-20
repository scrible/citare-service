/**
 * `POST /normalize` — SPEC §4.2.
 *
 * Takes a caller-authored CSL item, runs the package's post-processing
 * pipeline (SPEC §6.14) + filterFieldsByType. Returns a cleaned CSL.
 */

import type { FastifyInstance } from "fastify";
import {
  canonicalizeUrl,
  filterFieldsByType,
} from "@bwthomas/ibid";
import { z } from "zod";

const bodySchema = z.object({
  csl: z.record(z.string(), z.unknown()),
});

export function registerNormalizeRoute(app: FastifyInstance) {
  app.post("/normalize", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const warnings: string[] = [];
    const csl = filterFieldsByType(
      parsed.data.csl as Parameters<typeof filterFieldsByType>[0],
    );
    if (typeof csl.URL === "string") {
      const before = csl.URL;
      csl.URL = canonicalizeUrl(csl.URL);
      if (csl.URL !== before) warnings.push(`Canonical URL rewritten: ${before} -> ${csl.URL}`);
    }
    if (typeof csl.title === "string") {
      csl.title = csl.title.trim();
    }
    return reply.send({ csl, warnings });
  });
}
