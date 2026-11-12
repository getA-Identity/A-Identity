// A chat client for NEAR AI Cloud, whose API is OpenAI-compatible. Global fetch, no SDK.
//
// Base URL and model ids were checked against the live model list on 2026-11-12
// (GET https://cloud-api.near.ai/v1/models, HTTP 200). The default model is one NEAR AI serves
// itself inside a TEE ("owned_by": "nearai"): Qwen/Qwen3.6-35B-A3B-FP8. z-ai/glm-5.3-flash and
// Qwen/Qwen3.8-27B are the same kind and can be picked with NEAR_AI_MODEL. Every request runs at
// temperature 0 with a fixed seed. Tool calling and seed support are what NEAR AI documents for
// these models; this client has only run against a mocked endpoint so far, so the first --llm run
// is the live test of both (an HTTP error is recorded with its exchange, see LlmHttpError).
//
// Configuration: NEAR_AI_BASE_URL, NEAR_AI_MODEL, and the API key from NEAR_AI_API_KEY or from a
// file named in NEAR_AI_KEY_FILE (mode 0600 or stricter; plain text, or JSON with "api_key").
// The key is only ever placed in the Authorization header. The recorded exchange holds the exact
// request body and response body (hashed with sha256, as NEAR AI's chat signatures are) and no
// header at all. Without a key the client does not exist: the caller gets a SKIP message.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Env } from '../lib/config.ts';
import { displayPath } from '../lib/paths.ts';
import type { FetchLike } from '../lib/rpc.ts';

export const DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
export const DEFAULT_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
export const DEFAULT_SEED = 7;

export type LlmSettings = {
  baseUrl: string;
  model: string;
  temperature: 0;
  seed: number;
  maxTokens: number;
  /** Qwen3 and GLM accept chat_template_kwargs.enable_thinking; off keeps the proposal short. */
  disableThinking: boolean;
};

export type LlmKey = { source: string; value: () => string };

/** Not ok: `skip` is the full SKIP line for the log, `short` the few words for the run header. */
export type LlmConfig = { ok: true; settings: LlmSettings; key: LlmKey } | { ok: false; settings: LlmSettings; skip: string; short: string };

export const SKIP_NO_KEY =
  'SKIP: no NEAR AI key. Put the key in a file, chmod 600 it, and set NEAR_AI_KEY_FILE to its path (or set NEAR_AI_API_KEY). Nothing was sent to a model. Run with --no-llm for the scripted story.';

function readKeyFile(path: string): { ok: true; key: string } | { ok: false; why: string } {
  const shown = displayPath(path);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { ok: false, why: `NEAR_AI_KEY_FILE ${shown} does not exist` };
  }
  if ((mode & 0o077) !== 0) return { ok: false, why: `NEAR_AI_KEY_FILE ${shown} is readable by group or others; run: chmod 600 ${shown}` };
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const k = j.api_key ?? j.apiKey ?? j.key;
      if (typeof k === 'string' && k.trim() !== '') return { ok: true, key: k.trim() };
    } catch {
      // fall through
    }
    return { ok: false, why: `NEAR_AI_KEY_FILE ${shown} is JSON without an "api_key" field` };
  }
  if (raw === '' || /\s/.test(raw)) return { ok: false, why: `NEAR_AI_KEY_FILE ${shown} does not hold a single key` };
  return { ok: true, key: raw };
}

export function loadLlmConfig(env: Env): LlmConfig {
  const settings: LlmSettings = {
    baseUrl: (env.NEAR_AI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.NEAR_AI_MODEL?.trim() || DEFAULT_MODEL,
    temperature: 0,
    seed: Number.parseInt(env.NEAR_AI_SEED ?? '', 10) || DEFAULT_SEED,
    maxTokens: Number.parseInt(env.NEAR_AI_MAX_TOKENS ?? '', 10) || 1024,
    disableThinking: (env.NEAR_AI_THINKING ?? 'off').toLowerCase() !== 'on',
  };
  const file = env.NEAR_AI_KEY_FILE?.trim();
  if (file) {
    const r = readKeyFile(file);
    if (!r.ok) return { ok: false, settings, skip: `SKIP: ${r.why}. Nothing was sent to a model.`, short: 'the NEAR AI key file is unusable' };
    const key = r.key;
    return { ok: true, settings, key: { source: `file ${displayPath(file)}`, value: () => key } };
  }
  const fromEnv = env.NEAR_AI_API_KEY?.trim();
  if (fromEnv) return { ok: true, settings, key: { source: 'env NEAR_AI_API_KEY', value: () => fromEnv } };
  return { ok: false, settings, skip: SKIP_NO_KEY, short: 'no NEAR AI key' };
}

// -- chat ----------------------------------------------------------------------------------

/** Some OpenAI-compatible servers omit "type" on a tool call; it is always a function call here. */
export type ToolCall = { id: string; type?: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type SignatureRecord = {
  fetched: boolean;
  error?: string;
  text?: string;
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
  /** Whether the signed text contains the sha256 of our exact request and response bytes. The
   * ECDSA signature itself is checked offline against the model's attested signing address. */
  hashes_in_signed_text?: { request: boolean; response: boolean };
};

export type Exchange = {
  url: string;
  model: string;
  sent_at: string;
  latency_ms: number;
  request_body: string;
  request_sha256: string;
  response_status: number;
  response_body: string;
  response_sha256: string;
  chat_id?: string;
  signature?: SignatureRecord;
};

export type AssistantTurn = { message: { content: string | null; tool_calls: ToolCall[]; reasoning?: string }; finishReason: string; exchange: Exchange };

export class LlmHttpError extends Error {
  readonly status: number;
  readonly exchange: Exchange;
  constructor(status: number, exchange: Exchange) {
    super(`NEAR AI answered HTTP ${status}: ${exchange.response_body.slice(0, 300)}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.exchange = exchange;
  }
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export type ChatDeps = { fetchImpl?: FetchLike; now?: () => Date; timeoutMs?: number };

export async function chat(
  settings: LlmSettings,
  key: LlmKey,
  req: { messages: ChatMessage[]; tools?: ToolDef[]; tool_choice?: 'auto' | 'none' | 'required' },
  deps: ChatDeps = {},
): Promise<AssistantTurn> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? (() => new Date());
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: req.messages,
    temperature: settings.temperature,
    seed: settings.seed,
    max_tokens: settings.maxTokens,
    stream: false,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.tool_choice ?? 'auto';
  }
  if (settings.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
  const requestBody = JSON.stringify(body);
  const url = `${settings.baseUrl}/chat/completions`;
  const started = now();
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key.value()}` },
    body: requestBody,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
  });
  const responseBody = await res.text();
  const exchange: Exchange = {
    url,
    model: settings.model,
    sent_at: started.toISOString(),
    latency_ms: now().getTime() - started.getTime(),
    request_body: requestBody,
    request_sha256: sha256(requestBody),
    response_status: res.status,
    response_body: responseBody,
    response_sha256: sha256(responseBody),
  };
  if (!res.ok) throw new LlmHttpError(res.status, exchange);
  let parsed: { id?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string; reasoning?: string } }> };
  try {
    parsed = JSON.parse(responseBody) as typeof parsed;
  } catch {
    throw new LlmHttpError(res.status, exchange);
  }
  if (parsed.id) exchange.chat_id = parsed.id;
  const choice = parsed.choices?.[0];
  const m = choice?.message ?? {};
  const reasoning = m.reasoning_content ?? m.reasoning;
  return {
    message: { content: m.content ?? null, tool_calls: m.tool_calls ?? [], ...(reasoning ? { reasoning } : {}) },
    finishReason: choice?.finish_reason ?? 'unknown',
    exchange,
  };
}

/**
 * Fetch NEAR AI's signature over this exchange (GET /v1/signature/{chat_id}). The signed text is
 * "{model}:{request_sha256}:{response_sha256}" (model TEE) or "{request_sha256}:{response_sha256}"
 * (gateway TEE). A model may run on several TEE nodes and the signature lives on the node that
 * served the completion, so a "not found" is retried a few times.
 */
export async function fetchSignature(settings: LlmSettings, key: LlmKey, exchange: Exchange, deps: ChatDeps & { sleep?: (ms: number) => Promise<void>; tries?: number } = {}): Promise<SignatureRecord> {
  if (!exchange.chat_id) return { fetched: false, error: 'the response carried no chat id' };
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${settings.baseUrl}/signature/${encodeURIComponent(exchange.chat_id)}?model=${encodeURIComponent(settings.model)}&signing_algo=ecdsa`;
  let last = '';
  for (let i = 0; i < (deps.tries ?? 4); i++) {
    if (i > 0) await sleep(1_000 * i);
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key.value()}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000) });
      const text = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        continue;
      }
      const j = JSON.parse(text) as Record<string, unknown>;
      const signed = typeof j.text === 'string' ? j.text : '';
      return {
        fetched: true,
        text: signed,
        ...(typeof j.signature === 'string' ? { signature: j.signature } : {}),
        ...(typeof j.signing_address === 'string' ? { signing_address: j.signing_address } : {}),
        ...(typeof j.signing_algo === 'string' ? { signing_algo: j.signing_algo } : {}),
        ...(typeof j.signature_kind === 'string' ? { signature_kind: j.signature_kind } : {}),
        hashes_in_signed_text: { request: signed.includes(exchange.request_sha256), response: signed.includes(exchange.response_sha256) },
      };
    } catch (e) {
      last = (e as Error).message;
    }
  }
  return { fetched: false, error: last || 'signature not available' };
}
