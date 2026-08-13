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
