/**
 * `GET /health` — SPEC §4.8. No auth, unconditional 200.
 */

import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_VERSION = readPkgVersion();
const IBID_VERSION = readIbidVersion();

export function registerHealthRoute(app: FastifyInstance, startedAt: number) {
  app.get("/health", async () => ({
    ok: true,
    version: SERVICE_VERSION,
    ibidVersion: IBID_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));
}

function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    );
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function readIbidVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "node_modules", "@bwthomas", "ibid", "package.json"),
        "utf8",
      ),
    );
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}
