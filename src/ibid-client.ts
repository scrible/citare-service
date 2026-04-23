/**
 * Shared `@bwthomas/ibid` client. Built once at server startup and
 * handed to every route. Wires the configured DOM adapter (linkedom),
 * pino child logger, shared LRU cache, and (when configured) the
 * Anthropic LLM adapter.
 *
 * LLM surfaces:
 *   - URL extraction (`extract_from_url`) — via `options.llm`, the
 *     existing `Llm` strategy in the extract chain.
 *   - Freetext search (`lookup-candidates/articleTitle`) — via a
 *     consumer-registered `CrossRefFreetext` adapter with `llm` wired
 *     through. The built-in core fallback is plain CrossRef; registering
 *     an LLM-enabled variant makes it the primary search adapter.
 */

import { createIbid } from "@bwthomas/ibid";
import { createDomAdapterFromParser } from "@bwthomas/ibid/dom-linkedom";
import { createAnthropicLlm } from "@bwthomas/ibid/llm-anthropic";
import { createCrossRefFreetext } from "@bwthomas/ibid/article-crossref-freetext";
import type { CacheAdapter, Logger } from "@bwthomas/ibid";
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
  cache: CacheAdapter,
): IbidClient {
  const dom = createDomAdapterFromParser(
    (html) => parseHTML(html) as { document: unknown },
  );
  const llm =
    config.llm.provider === "anthropic"
      ? createAnthropicLlm({
          apiKey: config.llm.apiKey,
          model: config.llm.model,
        })
      : undefined;

  // When LLM is configured, register an LLM-enabled freetext search
  // adapter as the primary article-search surface. `lookupCandidates`
  // core calls registered adapters first; the built-in plain-CrossRef
  // fallback only fires if none hit — in practice only on empty-result
  // queries where the LLM re-rank couldn't help anyway.
  const articleSearchAdapters =
    llm && config.llm.provider === "anthropic"
      ? [
          createCrossRefFreetext({
            llm,
            userAgent: config.ibid.userAgent,
            llmRescue: {
              rescueMinScore: config.llm.freetextRescue?.minScore,
              rescueMinTitleTokenOverlap:
                config.llm.freetextRescue?.minTitleOverlap,
              maxCandidates: config.llm.freetextRescue?.maxCandidates,
              maxTokens: config.llm.freetextRescue?.maxTokens,
              temperature: config.llm.freetextRescue?.temperature,
            },
          }),
        ]
      : [];

  return createIbid({
    dom,
    logger,
    cache,
    llm,
    articleSearchAdapters,
    userAgent: config.ibid.userAgent,
    timeoutMs: config.ibid.timeoutMs,
    crossrefEndpoint: config.ibid.crossrefEndpoint,
    citoidEndpoint: config.ibid.citoidEndpoint,
    translationServerEndpoint:
      config.ibid.translationServerEndpoint || undefined,
  });
}
