import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './registry.js'

/**
 * Registry versus prose: the guard for the class of falsehood that actually shipped.
 *
 * public/llms-full.txt told every agent that read it that Robinhood Chain was "not yet
 * deployed" while our own agent was minted on it, and omitted Celo from the live list
 * while Celo was live. Nothing caught that, because unlike the agent manifest, those
 * files were pinned by nothing at all.
 *
 * You cannot assert that prose equals data. What you can assert is that a chain is NAMED
 * where it should be, is NOT named next to words that contradict its status, and that
 * the status buckets contain the right chains. That is what this does.
 */

/** Compiled to dist/chains/, so the repo root is three levels up. */
const repo = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')

const NAMED_EVERYWHERE = ['public/llms-full.txt', 'public/index.md', 'README.md']
const STALE_WORDS = /not yet deployed|coming soon|to be deployed|adapted but not|is planned/i

test('every live chain is named in the public copy', () => {
  for (const file of NAMED_EVERYWHERE) {
    const text = repo(file)
    for (const c of CHAINS.filter((x) => x.status === 'live')) {
      assert.ok(
        text.includes(c.shortName) || text.includes(c.name),
        `${file} never names ${c.name}, which is live. A live chain nobody can find is a live chain nobody believes.`,
      )
    }
  }
})

test('no live or beta chain is described with stale words nearby', () => {
  // The exact defect: "Adapted but not yet deployed: ... Robinhood Chain".
  for (const file of [...NAMED_EVERYWHERE, 'public/llms.txt']) {
    const text = repo(file)
    for (const c of CHAINS.filter((x) => x.status === 'live' || x.status === 'beta')) {
      for (const name of new Set([c.name, c.shortName])) {
        let from = 0
        for (;;) {
          const at = text.indexOf(name, from)
          if (at === -1) break
          const window = text.slice(Math.max(0, at - 120), at + name.length + 120)
          assert.ok(
            !STALE_WORDS.test(window),
            `${file} describes ${name} (status ${c.status}) with a stale phrase nearby:\n  ...${window.replace(/\s+/g, ' ').trim()}...`,
          )
          from = at + name.length
        }
      }
    }
  }
})

test('the llms-full status buckets hold the right chains', () => {
  // The three markers are load-bearing: restructuring the file fails this test instead of
  // silently disabling the check.
  const text = repo('public/llms-full.txt')
  const markers = ['Live today:', 'Beta, wired and readable:', 'Planned, descriptor only:']
  for (const m of markers) assert.ok(text.includes(m), `public/llms-full.txt lost its "${m}" bucket marker`)
  const slice = (start: string) => {
    const from = text.indexOf(start) + start.length
    const rest = markers.map((m) => text.indexOf(m, from)).filter((i) => i > 0)
    const nextSection = text.indexOf('\n## ', from)
    const ends = [...rest, nextSection > 0 ? nextSection : text.length].filter((i) => i > 0)
    return text.slice(from, Math.min(...ends))
  }
  const live = slice(markers[0])
  const planned = slice(markers[2])
  for (const c of CHAINS.filter((x) => x.status === 'live')) {
    assert.ok(live.includes(c.shortName) || live.includes(c.name), `${c.name} is live but missing from the "Live today" bucket`)
  }
  for (const c of CHAINS.filter((x) => x.status === 'planned')) {
    assert.ok(
      !live.includes(c.name),
      `${c.name} is planned but appears under "Live today"`,
    )
    assert.ok(planned.includes(c.shortName) || planned.includes(c.name), `${c.name} is planned but missing from the planned bucket`)
  }
})

test('README names the registry address of every wired chain that has one', () => {
  const text = repo('README.md').toLowerCase()
  for (const c of CHAINS.filter((x) => (x.status === 'live' || x.status === 'beta') && x.contracts.identityRegistry)) {
    assert.ok(
      text.includes(c.contracts.identityRegistry!.toLowerCase()),
      `README.md never names ${c.name}'s identity registry ${c.contracts.identityRegistry}. The repo front door should let someone check the claim.`,
    )
  }
})

test('the agent card advertises every agent the provenance ledger records', async () => {
  const { PROVENANCE } = await import('./provenance.js')
  const card = JSON.parse(repo('public/.well-known/agent-card.json')) as {
    registrations?: { chain?: string; registry?: string }[]
  }
  const regs = card.registrations ?? []
  for (const p of PROVENANCE) {
    if (!p.agent) continue
    const chain = CHAINS.find((c) => c.id === p.chain)!
    if (chain.testnet) continue
    const hit = regs.find((r) => r.chain === chain.caip2)
    assert.ok(hit, `agent-card.json advertises no registration on ${chain.caip2}, but the ledger records agent #${p.agent.tokenId} there`)
    assert.equal(
      hit.registry?.toLowerCase(),
      chain.contracts.identityRegistry?.toLowerCase(),
      `agent-card.json names the wrong registry for ${chain.caip2}`,
    )
  }
})

test('.env.example documents every per-chain env var the registry declares', () => {
  const text = repo('.env.example')
  for (const c of CHAINS) {
    for (const v of [c.signerEnvVar, c.rpcEnvVar]) {
      if (!v) continue
      assert.ok(text.includes(v), `.env.example never mentions ${v}, declared by the ${c.id} descriptor`)
    }
  }
})

test('the docs chain overview lists every chain in the registry', () => {
  const text = repo('docs/chains/overview.mdx')
  for (const c of CHAINS) {
    assert.ok(
      text.includes(c.caip2),
      `docs/chains/overview.mdx never names ${c.caip2} (${c.name}). A chain invisible in the docs is a chain nobody can build on.`,
    )
  }
})

/*
 * The "testnet only" class, which is the one that shipped for months.
 *
 * SECURITY.md opened with "A-Identity is a testnet application. It runs on Arc testnet"
 * and listed exactly one chain signer, described as test funds, while the registry
 * carried four LIVE mainnets whose signers broadcast real-value settlements without a
 * human. mcp/README.md said "testnet only" on the same day its own rails settled in real
 * USDC. A reader deciding how carefully to treat a key was being told the wrong blast
 * radius, which is the most expensive direction for this particular lie to point.
 *
 * Prose cannot be asserted equal to data. What can be asserted is that a document does
 * not make a whole-product claim the registry contradicts, and that every key capable of
 * spending real money is at least NAMED where the keys are documented.
 */

/**
 * A blanket claim about the PRODUCT, as opposed to a true statement about one chain.
 *
 * The distinction is the whole design of this check, and the first draft got it wrong: a
 * bare /testnet[- ]only/ also fired on ROADMAP's "Testnet only; pubnet is still `planned`",
 * which is an accurate scoping note about the Stellar rail. A guard that flags honest
 * sentences gets deleted, so the subject has to be there: something has to BE testnet-only,
 * and that something has to be the product.
 *
 * Both historical offenders are covered: SECURITY.md's "A-Identity is a **testnet**
 * application" and mcp/README's "It is **testnet only**". The `\*{0,2}` allow for the
 * markdown bold they were written in.
 */
const TESTNET_ONLY_CLAIM =
  /\b(?:A-Identity|the product|this project|the platform|the backend|it|this)\s+is\s+(?:an?\s+)?\*{0,2}testnet\*{0,2}[\s-]*(?:only|app|application|project)\b/i

test('no document calls the whole product testnet-only while a mainnet is live', () => {
  const liveMainnets = CHAINS.filter((c) => !c.testnet && c.status === 'live')
  if (!liveMainnets.length) return // nothing to contradict
  for (const file of ['SECURITY.md', 'README.md', 'mcp/README.md', 'ROADMAP.md']) {
    const text = repo(file)
    // A line may quote the claim in order to correct it, so only lines that ASSERT it count:
    // any line that also says it is not true is the correction, not the claim.
    const offenders = text
      .split('\n')
      .filter((l) => TESTNET_ONLY_CLAIM.test(l) && !/\bnot\b|\bused to\b|\bstopped\b|\bno longer\b/i.test(l))
    assert.equal(
      offenders.length,
      0,
      `${file} still calls the product testnet-only, but ${liveMainnets
        .map((c) => c.name)
        .join(', ')} ${liveMainnets.length === 1 ? 'is' : 'are'} live mainnet in the registry.\n` +
        offenders.map((l) => `  > ${l.trim()}`).join('\n'),
    )
  }
})

test('SECURITY.md names every signer that can spend real money', () => {
  const text = repo('SECURITY.md')
  // Mainnet first: those are the keys whose absence understates the risk. Testnet signers
  // are listed too, because "which keys exist" is the question this document answers.
  for (const c of CHAINS) {
    if (!c.signerEnvVar) continue
    assert.ok(
      text.includes(c.signerEnvVar),
      `SECURITY.md never mentions ${c.signerEnvVar} (${c.name}, ${c.testnet ? 'testnet' : 'MAINNET'}). ` +
        `Every signer in the registry is a hot wallet this product signs with; one missing from the ` +
        `key inventory is a key nobody rotates.`,
    )
  }
})

test('SECURITY.md marks every live mainnet signer as spending real value', () => {
  const text = repo('SECURITY.md')
  for (const c of CHAINS) {
    if (c.testnet || c.status !== 'live' || !c.signerEnvVar) continue
    // The row for this signer, whatever table it lives in.
    const row = text.split('\n').find((l) => l.includes(c.signerEnvVar!))
    assert.ok(row, `no line in SECURITY.md carries ${c.signerEnvVar}`)
    assert.match(
      row!,
      /real value/i,
      `SECURITY.md lists ${c.signerEnvVar} but does not say it spends real value, and ${c.name} is a ` +
        `live mainnet. This is the exact shape of the claim that was wrong before: a mainnet hot ` +
        `wallet documented as though it were a testnet key.`,
    )
  }
})

/**
 * No testnet mirror is named in the landing page's public chain sentence.
 *
 * ProtocolsWall drops a testnet whose mainnet twin already carries the headline, because
 * the mirror adds a name without adding information. That rule was a hand-written set of
 * two ids and it was missing the third, so the sentence read "Stellar, Stellar test and
 * Base are in beta": a testnet, in a marketing line, immediately after its own twin.
 *
 * The rule is derived now, which removes the possibility rather than policing it. This
 * pins the outcome, because the derivation has one judgement call in it and that call is
 * worth stating out loud: Arc STAYS. Arc is a testnet with no mainnet twin, it is the chain
 * identity and escrow actually settle on, and the sentence goes on to say so.
 */
test('the landing chain sentence names no testnet mirror, and still names Arc', () => {
  const isMirror = (c: (typeof CHAINS)[number]) =>
    c.testnet && CHAINS.some((o) => !o.testnet && o.id !== c.id && c.id.startsWith(`${o.id}-`))

  const named = CHAINS.filter((c) => !isMirror(c))
  const mirrors = CHAINS.filter(isMirror).map((c) => c.id)

  // Every testnet that HAS a mainnet twin must be dropped. Naming them is the assertion:
  // a fourth pair added to the registry lands here rather than in the marketing copy.
  assert.deepEqual(mirrors.sort(), ['celo-sepolia', 'rhchain-testnet', 'stellar-testnet'])

  assert.ok(named.some((c) => c.id === 'arc'), 'Arc has no mainnet twin and must stay in the sentence')
  assert.equal(
    named.filter((c) => c.testnet).map((c) => c.id).join(','), 'arc',
    'Arc is the only testnet the public sentence may name',
  )

  // And the component must actually use the derived rule rather than growing a new list.
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/components/sections/ProtocolsWall.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(src, /const isMirror = /, 'ProtocolsWall must derive its mirror set')
  assert.doesNotMatch(src, /MIRRORS = new Set/, 'a hand-written mirror list is what missed stellar-testnet')
})
