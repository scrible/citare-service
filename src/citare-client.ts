/**
 * Shared `citare` client. Built once at server startup and
 * handed to every route. Wires the configured DOM adapter (linkedom),
 * pino child logger, shared LRU cache, and (when configured) an LLM
 * adapter — Anthropic-direct or AWS Bedrock, depending on which creds
 * the boot environment provides.
 *
 * LLM surfaces:
 *   - URL extraction (`extract_from_url`) — via `options.llm`, the
 *     existing `Llm` strategy in the extract chain.
 *   - Freetext search (`lookup-candidates/articleTitle`) — via a
 *     consumer-registered `CrossRefFreetext` adapter with `llm` wired
 *     through. The built-in core fallback is plain CrossRef; registering
 *     an LLM-enabled variant makes it the primary search adapter.
 *
 * Provider selection (see `resolveLlmConfig` in `config.ts` for env
 * semantics): Bedrock > Anthropic > none.
 */

import { createCitare } from "citare";
import { createDomAdapterFromParser } from "citare/dom-linkedom";
import { createAnthropicLlm } from "citare/llm-anthropic";
import { createBedrockLlm } from "citare/llm-bedrock";
import { createCrossRefFreetext } from "citare/article-crossref-freetext";
import type { CacheAdapter, LlmAdapter, Logger } from "citare";
import { parseHTML } from "linkedom";

import type { FreetextRescueConfig, ServiceConfig } from "./config.js";

export type CitareClient = ReturnType<typeof createCitare>;

/**
 * Construct the shared citare client. Called once; the returned client is
 * thread-safe (strategies are pure functions, and every `extract()` starts
 * from a fresh Context).
 */
export function createServiceCitare(
  config: ServiceConfig,
  logger: Logger,
  cache: CacheAdapter,
): CitareClient {
  const dom = createDomAdapterFromParser(
    (html) => parseHTML(html) as { document: unknown },
  );
  const { llm, freetextRescue } = resolveLlm(config);

  // When LLM is configured, register an LLM-enabled freetext search
  // adapter as the primary article-search surface. `lookupCandidates`
  // core calls registered adapters first; the built-in plain-CrossRef
  // fallback only fires if none hit — in practice only on empty-result
  // queries where the LLM re-rank couldn't help anyway.
  const articleSearchAdapters = llm
    ? [
        createCrossRefFreetext({
          llm,
          userAgent: config.citare.userAgent,
          llmRescue: {
            rescueMinScore: freetextRescue?.minScore,
            rescueMinTitleTokenOverlap: freetextRescue?.minTitleOverlap,
            maxCandidates: freetextRescue?.maxCandidates,
            maxTokens: freetextRescue?.maxTokens,
            temperature: freetextRescue?.temperature,
          },
        }),
      ]
    : [];

  return createCitare({
    dom,
    logger,
    cache,
    llm,
    articleSearchAdapters,
    userAgent: config.citare.userAgent,
    timeoutMs: config.citare.timeoutMs,
    crossrefEndpoint: config.citare.crossrefEndpoint,
    citoidEndpoint: config.citare.citoidEndpoint,
    translationServerEndpoint:
      config.citare.translationServerEndpoint || undefined,
    strategyOverrides: config.citare.strategyOverrides,
  });
}

/**
 * Materialize the configured LLM adapter (or `undefined` when no
 * provider is configured). Kept out of `createServiceCitare` so tests
 * can exercise provider selection in isolation.
 */
function resolveLlm(
  config: ServiceConfig,
): { llm: LlmAdapter | undefined; freetextRescue: FreetextRescueConfig | undefined } {
  if (config.llm.provider === "anthropic") {
    return {
      llm: createAnthropicLlm({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      }),
      freetextRescue: config.llm.freetextRescue,
    };
  }
  if (config.llm.provider === "bedrock") {
    return {
      llm: createBedrockLlm({
        region: config.llm.region,
        modelId: config.llm.modelId,
        credentials: {
          accessKeyId: config.llm.accessKeyId,
          secretAccessKey: config.llm.secretAccessKey,
          sessionToken: config.llm.sessionToken,
        },
      }),
      freetextRescue: config.llm.freetextRescue,
    };
  }
  return { llm: undefined, freetextRescue: undefined };
}
