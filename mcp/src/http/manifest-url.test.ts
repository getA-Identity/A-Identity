import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeNonJsonManifest } from './guardrail-routes.js'
import { parseExplorerAgentUrl, resolveAgentManifestUrl, describeOwnership } from '../chains/explorer-agent-url.js'
import { getChainById } from '../chains/registry.js'

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

/**
 * Second half of the same problem. The hint above is correct and still leaves the caller
 * to go read the chain by hand, which is exactly what happened: someone pasted
 * https://8004scan.io/agents/xlayer/11611?tab=metadata, and the manifest URL they needed
 * was tokenURI(11611) on X Layer's ERC-8004 identity registry. That is a value we can read.
 *
 * The parse half is pure by construction, so these run with no network at all; the read
 * half runs against an injected reader. Nothing here accepts a fabricated fallback: a
 * chain that will not answer must produce a labeled error, never a made-up URL.
 */

const XLAYER = getChainById('xlayer')!

test('an 8004scan agent page resolves to the chain and token id it names', () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611?tab=metadata')
  assert.ok(link, 'the real-world URL must parse')
  assert.equal(link!.chain.id, 'xlayer')
  assert.equal(link!.tokenId, 11611n)
  // The registry address comes from the chain registry, never from this test.
  assert.equal(link!.registry, XLAYER.contracts.identityRegistry)
})

test('a chain slug the registry does not carry is not resolved, so the hint still applies', () => {
  assert.equal(parseExplorerAgentUrl('https://8004scan.io/agents/not-a-chain/11611'), null)
})

test('a malformed or off-shape URL returns null instead of throwing', () => {
  for (const u of [
    'not a url',
    '',
    'ftp://8004scan.io/agents/xlayer/1',
    'https://8004scan.io/agents',
    'https://8004scan.io/agents/xlayer',
    'https://8004scan.io/agents/xlayer/notanumber',
    'https://8004scan.io/agents/xlayer/11611/extra',
    // The same host-suffix trap the hint table already guards against.
    'https://8004scan.io.evil.com/agents/xlayer/11611',
    // A host with no agent-page grammar of its own.
    'https://example.com/agents/xlayer/11611',
  ]) {
    assert.equal(parseExplorerAgentUrl(u), null, u)
  }
})

test('a subdomain of the explorer still resolves, and a large token id survives the parse', () => {
  const link = parseExplorerAgentUrl('https://www.8004scan.io/agents/xlayer/849980/')
  assert.equal(link?.tokenId, 849980n)
})

test('the live read returns the tokenURI the chain holds, plus the owner, labeled live', async () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611')!
  const seen: string[] = []
  const out = await resolveAgentManifestUrl(link, {
    readContract: async (fn) => {
      seen.push(fn)
      return fn === 'tokenURI' ? 'https://static.example.com/card/abc.json' : `0x${'ab'.repeat(20)}`
    },
  })
  assert.ok(!('error' in out))
  const r = out as Exclude<typeof out, { error: string }>
  assert.equal(r.live, true)
  assert.equal(r.tokenURI, 'https://static.example.com/card/abc.json')
  assert.equal(r.chainId, 'xlayer')
  assert.equal(r.tokenId, '11611')
  assert.equal(r.onchainOwner, `0x${'ab'.repeat(20)}`)
  assert.deepEqual(seen, ['tokenURI', 'ownerOf'])
  // The note has to say where the value came from, not just carry the value.
  assert.match(r.note, /tokenURI\(11611\)/)
})

test('an unminted token id says so rather than inventing a URL', async () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611')!
  const out = await resolveAgentManifestUrl(link, {
    readContract: async () => { throw new Error('The contract function "tokenURI" reverted.') },
  })
  assert.ok('error' in out)
  assert.match((out as { error: string }).error, /no agent #11611/)
  // "retry" is the wrong advice for a token that does not exist.
  assert.doesNotMatch((out as { error: string }).error, /retry/)
})

test('an RPC that will not answer is a labeled failure naming the chain, not a silent fallback', async () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611')!
  const out = await resolveAgentManifestUrl(link, {
    readContract: () => new Promise(() => {}),
    timeoutMs: 10,
  })
  assert.ok('error' in out)
  const err = (out as { error: string }).error
  assert.match(err, /tokenURI\(11611\)/)
  assert.match(err, new RegExp(XLAYER.name))
  assert.match(err, /Nothing was registered/)
})

test('a token whose tokenURI is empty on chain is named as such', async () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611')!
  const out = await resolveAgentManifestUrl(link, { readContract: async () => '  ' })
  assert.ok('error' in out)
  assert.match((out as { error: string }).error, /tokenURI is empty on chain/)
})

test('ownerOf failing degrades the ownership check without losing the manifest URL', async () => {
  const link = parseExplorerAgentUrl('https://8004scan.io/agents/xlayer/11611')!
  const out = await resolveAgentManifestUrl(link, {
    readContract: async (fn) => {
      if (fn === 'ownerOf') throw new Error('execution reverted')
      return 'https://static.example.com/card/abc.json'
    },
  })
  assert.ok(!('error' in out))
  const r = out as Exclude<typeof out, { error: string }>
  assert.equal(r.tokenURI, 'https://static.example.com/card/abc.json')
  assert.equal(r.onchainOwner, null)
})

test('registering from a token owned by someone else warns that it is not a claim on it', () => {
  const note = describeOwnership(`0x${'ab'.repeat(20)}`, `0x${'cd'.repeat(20)}`, '11611', 'OKX X Layer')
  assert.equal(note.claimsOnchainToken, false)
  assert.equal(note.matchesCaller, false)
  assert.match(note.warning!, /does not claim, transfer, or prove ownership/)
  assert.match(note.warning!, /0x(ab){20}/)
})

test('the owner registering their own token gets no warning, and still no ownership claim', () => {
  // Checksum casing must not turn a match into a warning.
  const note = describeOwnership(`0x${'AB'.repeat(20)}`, `0x${'ab'.repeat(20)}`, '11611', 'OKX X Layer')
  assert.equal(note.matchesCaller, true)
  assert.equal(note.warning, null)
  assert.equal(note.claimsOnchainToken, false)
})

test('a non-wallet session cannot be compared, and the warning says so rather than implying a match', () => {
  const note = describeOwnership(`0x${'ab'.repeat(20)}`, 'someone@example.com', '11611', 'OKX X Layer')
  assert.equal(note.callerAccount, null)
  assert.equal(note.matchesCaller, null)
  assert.match(note.warning!, /not a wallet session/)
  assert.match(note.warning!, /does not claim/)
})

test('an unreadable owner is reported as unchecked, never as approved', () => {
  const note = describeOwnership(null, `0x${'cd'.repeat(20)}`, '11611', 'OKX X Layer')
  assert.equal(note.matchesCaller, null)
  assert.match(note.warning!, /did not answer/)
  assert.match(note.warning!, /claims no token/)
})
