import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { chat, DEFAULT_BASE_URL, DEFAULT_MODEL, fetchSignature, LlmHttpError, loadLlmConfig, sha256, SKIP_NO_KEY } from '../agent/llm.ts';
import type { FetchLike } from '../lib/rpc.ts';

// A fake API key value for the tests: plain words, nothing a secret scanner would mistake.
const KEY = 'fake-near-ai-key-for-tests';

function keyFile(content: string, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aid-llm-')), 'key');
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe('NEAR AI configuration', () => {
  test('no key: a SKIP message, never a crash', () => {
    const c = loadLlmConfig({});
    assert.equal(c.ok, false);
    assert.equal(c.ok ? '' : c.skip, SKIP_NO_KEY);
    assert.equal(c.settings.baseUrl, DEFAULT_BASE_URL);
    assert.equal(c.settings.model, DEFAULT_MODEL);
    assert.equal(c.settings.temperature, 0);
  });

  test('a 0600 key file, plain or JSON', () => {
    const plain = loadLlmConfig({ NEAR_AI_KEY_FILE: keyFile(`${KEY}\n`) });
    assert.equal(plain.ok && plain.key.value(), KEY);
    const json = loadLlmConfig({ NEAR_AI_KEY_FILE: keyFile(JSON.stringify({ api_key: KEY })) });
    assert.equal(json.ok && json.key.value(), KEY);
    assert.ok(!JSON.stringify(json).includes(KEY), 'the config object never serializes the key');
  });

  test('a key file others can read is refused, with the fix', () => {
    const c = loadLlmConfig({ NEAR_AI_KEY_FILE: keyFile(KEY, 0o644) });
    assert.equal(c.ok, false);
    assert.match(c.ok ? '' : c.skip, /chmod 600/);
    assert.ok(!(c.ok ? '' : c.skip).includes(KEY));
  });

  test('model and base URL come from the environment', () => {
    const c = loadLlmConfig({ NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: 'z-ai/glm-5.3-flash', NEAR_AI_BASE_URL: 'https://example.invalid/v1/' });
    assert.equal(c.settings.model, 'z-ai/glm-5.3-flash');
    assert.equal(c.settings.baseUrl, 'https://example.invalid/v1');
  });
});

describe('chat', () => {
  const cfg = loadLlmConfig({ NEAR_AI_API_KEY: KEY });
  if (!cfg.ok) throw new Error('test setup');

  test('temperature 0, fixed seed, tools; the key only in the Authorization header', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const responseBody = JSON.stringify({ id: 'chat-1', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pay_invoice', arguments: '{"payee":"x.testnet","amount_usdc":"0.50","memo":"INV-1"}' } }] } }] });
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body ?? '' };
      return { ok: true, status: 200, text: async () => responseBody };
    };
    const t = await chat(cfg.settings, cfg.key, { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'pay_invoice', description: 'd', parameters: {} } }] }, { fetchImpl });
    assert.ok(seen);
    const s = seen as { url: string; headers: Record<string, string>; body: string };
    assert.equal(s.url, `${DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(s.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(s.body) as Record<string, unknown>;
    assert.equal(body.temperature, 0);
    assert.equal(body.seed, cfg.settings.seed);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(t.message.tool_calls[0]?.function.name, 'pay_invoice');
    assert.equal(t.exchange.chat_id, 'chat-1');
    assert.equal(t.exchange.request_body, s.body, 'the exact bytes sent');
    assert.equal(t.exchange.request_sha256, sha256(s.body));
    assert.equal(t.exchange.response_sha256, sha256(responseBody));
    assert.ok(!JSON.stringify(t.exchange).includes(KEY), 'the recorded exchange holds no key');
  });

  test('an HTTP error is a typed error that carries the exchange, without the key', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid api key"}' });
    await assert.rejects(chat(cfg.settings, cfg.key, { messages: [{ role: 'user', content: 'x' }] }, { fetchImpl }), (e: unknown) => {
      assert.ok(e instanceof LlmHttpError);
      assert.equal(e.status, 401);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  });

  test('signature: the signed text is checked for our request and response hashes', async () => {
    const exchange = { url: 'u', model: DEFAULT_MODEL, sent_at: 't', latency_ms: 1, request_body: 'req', request_sha256: sha256('req'), response_status: 200, response_body: 'res', response_sha256: sha256('res'), chat_id: 'chat-9' };
    let calls = 0;
    const fetchImpl: FetchLike = async (url) => {
      calls++;
      assert.match(url, /\/signature\/chat-9\?model=Qwen%2FQwen3\.6-35B-A3B-FP8&signing_algo=ecdsa$/);
      if (calls === 1) return { ok: false, status: 404, text: async () => 'Chat id not found or expired' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: `${DEFAULT_MODEL}:${sha256('req')}:${sha256('res')}`, signature: '0xabc', signing_address: '0xdef', signing_algo: 'ecdsa', signature_kind: 'provider_tee' }) };
    };
    const s = await fetchSignature(cfg.settings, cfg.key, exchange, { fetchImpl, sleep: async () => {} });
    assert.equal(s.fetched, true);
    assert.deepEqual(s.hashes_in_signed_text, { request: true, response: true });
    assert.equal(s.signing_address, '0xdef');
    assert.equal(calls, 2, 'a "not found" on another TEE node is retried');
  });
});
