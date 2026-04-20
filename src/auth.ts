/**
 * Shared-secret auth — SPEC §4 preface.
 *
 * Timing-attack-safe compare via a fixed-time equality routine. Constant-time
 * comparison matters because the secret is a shared token, not a per-user
 * credential — leaking bits through timing would be a real exposure.
 *
 * `/health` is excluded at route-registration time; the hook below assumes
 * it's running only on protected routes.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Fastify preHandler hook that enforces `X-Ibid-Auth: <secret>`. Returns 401
 * on missing or incorrect header.
 */
export function makeAuthHook(secret: string) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const presented = req.headers["x-ibid-auth"];
    if (typeof presented !== "string" || !safeEqual(presented, secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

/** Constant-time string compare. Returns false immediately on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
