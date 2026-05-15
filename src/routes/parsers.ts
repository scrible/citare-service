/**
 * Thin parser wrappers — SPEC §4.3 through §4.7. Each route validates its
 * body shape and delegates to the package. Warnings are surfaced; the
 * package's parser methods return `{csl|authors|date, warnings}` already.
 */

import type { FastifyInstance } from "fastify";
import { parseEasyBib, parseRis, upgradeLegacyBib } from "citare";
import type { LegacyBibHash } from "citare";
import { z } from "zod";

import type { CitareClient } from "../citare-client.js";

export function registerParserRoutes(app: FastifyInstance, client: CitareClient) {
  app.post("/parse-ris", async (req, reply) => {
    const parsed = z.object({ text: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const { csl, warnings } = parseRis(parsed.data.text);
    return reply.send({ csl, warnings });
  });

  app.post("/parse-easybib", async (req, reply) => {
    const parsed = z.object({ payload: z.unknown() }).safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const { csl, warnings } = parseEasyBib(parsed.data.payload);
    return reply.send({ csl, warnings });
  });

  app.post("/upgrade-bib", async (req, reply) => {
    // The legacy hash has a known shape but heterogeneous content — accept
    // any object and let the package tolerate unknown fields.
    const parsed = z
      .object({
        // Spread acceptance: any object. Specific fields typed in package.
      })
      .passthrough()
      .safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const { csl, warnings } = upgradeLegacyBib(parsed.data as LegacyBibHash);
    return reply.send({ csl, warnings });
  });

  app.post("/parse-authors", async (req, reply) => {
    const parsed = z
      .object({ raw: z.union([z.string(), z.array(z.string()), z.array(z.unknown())]) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const authors = client.parseAuthors(
      parsed.data.raw as Parameters<typeof client.parseAuthors>[0],
    );
    return reply.send({ authors, warnings: [] });
  });

  app.post("/parse-date", async (req, reply) => {
    const parsed = z
      .object({ raw: z.union([z.string(), z.array(z.number()), z.record(z.string(), z.unknown())]) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", issues: parsed.error.issues });
    }
    const date = client.parseDate(
      parsed.data.raw as Parameters<typeof client.parseDate>[0],
    );
    return reply.send({ date, warnings: [] });
  });
}
