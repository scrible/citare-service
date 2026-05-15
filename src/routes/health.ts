/**
 * `GET /health` — SPEC §4.8. No auth, unconditional 200.
 */

import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE_VERSION = readPkgVersion("package.json");
const CITARE_VERSION = readPkgVersion("node_modules/citare/package.json");

export function registerHealthRoute(app: FastifyInstance, startedAt: number) {
  app.get("/health", async () => ({
    ok: true,
    version: SERVICE_VERSION,
    citareVersion: CITARE_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));
}

/**
 * Read a package.json version relative to the current working directory.
 * Works identically in `node dist/server.js` (cwd = /app in Docker) and
 * `vitest` runs (cwd = repo root). No `import.meta.url` gymnastics —
 * those resolve differently after tsup bundles the source tree.
 */
function readPkgVersion(relativePath: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), relativePath), "utf8"),
    );
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}
