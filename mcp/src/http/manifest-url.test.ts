import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeNonJsonManifest } from './guardrail-routes.js'

/**
 * Quick register used to answer every bad manifest URL with "the URL did not return
 * valid JSON", which is true and useless: the caller cannot tell whether they pasted
 * the wrong kind of link, hit a dead host, or have a genuinely malformed document.
 * These pin the diagnosis, because the message IS the feature here.
 */

const HTML = '<!doctype html><html><head><title>Agent 61152</title></head><body></body></html>'

test('an 8004scan explorer page is named as such and points at the tokenURI', () => {
  const msg = describeNonJsonManifest('https://8004scan.io/agents/base/61152?tab=metadata', 'text/html', HTML)
  assert.match(msg, /8004scan explorer page/)
  assert.match(msg, /tokenURI/)
  // No bare restatement of the old message.
  assert.doesNotMatch(msg, /did not return valid JSON/)
})

test('block explorers get the explorer hint, matched on host not on the whole URL', () => {
  for (const u of [
    'https://celoscan.io/token/0xabc?a=1',
    'https://www.oklink.com/x-layer/evm/address/0xabc',
    'https://testnet.arcscan.app/tx/0xdead',
  ]) {
    assert.match(describeNonJsonManifest(u, 'text/html', HTML), /block explorer page/, u)
  }
})

test('a GitHub blob URL is redirected to raw.githubusercontent.com', () => {
  const msg = describeNonJsonManifest('https://github.com/org/repo/blob/main/manifest.json', 'text/html', HTML)
  assert.match(msg, /raw\.githubusercontent\.com/)
})

test('an unknown host serving HTML still gets the HTML diagnosis and an example', () => {
  const msg = describeNonJsonManifest('https://example.com/agent', 'text/html; charset=utf-8', HTML)
  assert.match(msg, /returned an HTML page/)
  assert.match(msg, /well-known\/agent-manifest\.json/)
})

test('HTML is detected from the body even when the content-type lies', () => {
  const msg = describeNonJsonManifest('https://example.com/agent', 'application/json', HTML)
  assert.match(msg, /returned an HTML page/)
})

test('an empty body says so rather than blaming the JSON', () => {
  assert.match(describeNonJsonManifest('https://example.com/a.json', 'application/json', '   '), /empty body/)
})

test('a non-HTML, non-empty body reports the content type it actually got', () => {
  const msg = describeNonJsonManifest('https://example.com/a.yaml', 'text/yaml; charset=utf-8', 'name: agent')
  assert.match(msg, /text\/yaml/)
  // The parameters are stripped, only the media type is shown.
  assert.doesNotMatch(msg, /charset/)
})

test('a malformed JSON document with no content-type falls back to the plain message', () => {
  const msg = describeNonJsonManifest('https://example.com/a.json', '', '{"name": ')
  assert.equal(msg, 'the URL did not return valid JSON')
})

test('a hostname that merely contains a known host is not matched', () => {
  // "8004scan.io.evil.com" must not inherit the 8004scan hint.
  const msg = describeNonJsonManifest('https://8004scan.io.evil.com/x', 'text/html', HTML)
  assert.doesNotMatch(msg, /8004scan explorer/)
  assert.match(msg, /returned an HTML page/)
})

test('a subdomain of a known host still matches', () => {
  assert.match(describeNonJsonManifest('https://www.8004scan.io/agents/base/1', 'text/html', HTML), /8004scan explorer/)
})

test('an unparseable URL does not throw, it degrades to the body-based diagnosis', () => {
  const msg = describeNonJsonManifest('not a url', 'text/html', HTML)
  assert.match(msg, /returned an HTML page/)
})
