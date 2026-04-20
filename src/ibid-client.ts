/**
 * Shared `@bwthomas/ibid` client. Built once at server startup and
 * handed to every route. Wires the configured DOM adapter (linkedom),
 * pino child logger, and service-level timeouts.
 */

import { createIbid } from "@bwthomas/ibid";
import { createDomAdapterFromParser } from "@bwthomas/ibid/dom-linkedom";
import type { Logger } from "@bwthomas/ibid";
import { parseHTML } from "linkedom";

import type { ServiceConfig } from "./config.js";

export type IbidClient = ReturnType<typeof createIbid>;

/**
 * Construct the shared ibid client. Called once; the returned client is
 * thread-safe (strategies are pure functions, and every `extract()` starts
 * from a fresh Context).
 */
export function createServiceIbid(
  config: ServiceConfig,
  logger: Logger,
): IbidClient {
  const dom = createDomAdapterFromParser(
    (html) => parseHTML(html) as { document: unknown },
  );
  return createIbid({
    dom,
    logger,
    userAgent: config.ibid.userAgent,
    timeoutMs: config.ibid.timeoutMs,
    crossrefEndpoint: config.ibid.crossrefEndpoint,
    citoidEndpoint: config.ibid.citoidEndpoint,
  });
}
