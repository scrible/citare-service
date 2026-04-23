/**
 * Harness-local Bedrock Converse adapter.
 *
 * Ibid's built-in `createBedrockLlm` is hard-coded to Anthropic's
 * InvokeModel body format. The `/converse` endpoint is provider-agnostic
 * — same request/response shape across Anthropic, Amazon Nova, Meta
 * Llama, Mistral, Cohere — so we can compare LLM backends apples-to-
 * apples by model-id swap alone. Lives here with the eval harness for
 * now; a future ibid release that folds this in upstream will let us
 * delete this file.
 *
 * Implements ibid's `LlmAdapter` contract (`complete(req)` →
 * `{ text, tokensUsed? }`) so it's drop-in for `createIbid({ llm })`
 * and `createCrossRefFreetext({ llm })`.
 */

import { createHash, createHmac } from "node:crypto";
import type { LlmAdapter, LlmRequest, LlmResponse } from "@bwthomas/ibid/types";

export interface BedrockConverseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CreateBedrockConverseOptions {
  region: string;
  modelId: string;
  credentials?: BedrockConverseCredentials;
  host?: string;
  fetchFn?: typeof fetch;
}

export function createBedrockConverse(
  opts: CreateBedrockConverseOptions,
): LlmAdapter {
  if (!opts.region) throw new Error("createBedrockConverse: region required");
  if (!opts.modelId) throw new Error("createBedrockConverse: modelId required");
  const region = opts.region;
  const modelId = opts.modelId;
  const host = opts.host ?? `bedrock-runtime.${region}.amazonaws.com`;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const creds = resolveCredentials(opts.credentials);

      const body = JSON.stringify({
        messages: [{ role: "user", content: [{ text: req.user }] }],
        ...(req.system ? { system: [{ text: req.system }] } : {}),
        inferenceConfig: {
          maxTokens: req.maxTokens ?? 1024,
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
        },
      });

      const urlPath = `/model/${encodeURIComponent(modelId)}/converse`;
      const canonicalPath = `/model/${doubleEncode(modelId)}/converse`;
      const url = `https://${host}${urlPath}`;
      const signed = signRequest({
        method: "POST",
        host,
        path: canonicalPath,
        query: "",
        body,
        region,
        service: "bedrock",
        credentials: creds,
        extraHeaders: { "content-type": "application/json" },
      });

      const res = await fetchFn(url, {
        method: "POST",
        headers: signed.headers,
        body,
        signal: req.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Bedrock Converse error ${res.status}: ${detail.slice(0, 400)}`,
        );
      }
      const json = (await res.json()) as {
        output?: { message?: { content?: Array<{ text?: string }> } };
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
      };
      const blocks = json.output?.message?.content ?? [];
      const text = blocks
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("")
        .trim();
      const out: LlmResponse = { text };
      if (json.usage) {
        out.tokensUsed = {
          input: json.usage.inputTokens ?? 0,
          output: json.usage.outputTokens ?? 0,
        };
      }
      return out;
    },
  };
}

function resolveCredentials(
  provided?: BedrockConverseCredentials,
): BedrockConverseCredentials {
  if (provided && provided.accessKeyId && provided.secretAccessKey) return provided;
  const k = process.env.AWS_ACCESS_KEY_ID;
  const s = process.env.AWS_SECRET_ACCESS_KEY;
  const t = process.env.AWS_SESSION_TOKEN;
  if (!k || !s) {
    throw new Error(
      "createBedrockConverse: credentials required (arg or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env)",
    );
  }
  return { accessKeyId: k, secretAccessKey: s, sessionToken: t };
}

// --------- SigV4 signer (mirrors ibid's llm-bedrock.ts) ---------------

interface SignInput {
  method: "POST";
  host: string;
  path: string;
  query: string;
  body: string;
  region: string;
  service: string;
  credentials: BedrockConverseCredentials;
  extraHeaders: Record<string, string>;
}

function signRequest(input: SignInput): { headers: Record<string, string> } {
  const now = new Date();
  const amzDate = isoBasic(now);
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash,
    ...input.extraHeaders,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const sortedHeaderNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((n) => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === n)!;
      return `${n}:${String(headers[key]).trim().replace(/\s+/g, " ")}`;
    })
    .join("\n");
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders + "\n",
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + input.credentials.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmacHex(kSigning, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;
  headers["Authorization"] = authorization;

  return { headers };
}

function isoBasic(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function doubleEncode(s: string): string {
  return encodeURIComponent(s).replace(/%/g, "%25");
}
