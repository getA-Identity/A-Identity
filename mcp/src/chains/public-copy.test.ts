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
  // The middle marker gained "(test networks)" on 2026-08-27, when stellar pubnet and base
  // moved to the live bucket and the only chains left in it were the three testnet mirrors.
  // It DROPPED the parenthetical on 2026-08-30, when Algorand mainnet entered at beta:
  // wired and credential-gated but a mainnet, so the old title had become false. The
  // rename failing this test is the mechanism working: the marker is load-bearing, so a
  // restructure has to be deliberate rather than silently disabling the check below.
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

test('the agent card registers exactly our agents whose tokenURI is the card, and is a valid ERC-8004 registration file and A2A 0.3.0 card', async () => {
  const { PROVENANCE } = await import('./provenance.js')
  const { CELO_TOOLS } = await import('../celo-x402.js')
  type Registration = { chain?: string; agentId?: unknown; agentRegistry?: unknown; caip?: string; registry?: string }
  type Service = { name?: unknown; endpoint?: unknown; version?: unknown; description?: unknown; skills?: unknown }
  type Skill = { id?: unknown; name?: unknown; description?: unknown; tags?: unknown }
  const card = JSON.parse(repo('public/.well-known/agent-card.json')) as {
    type?: unknown
    name?: unknown
    description?: unknown
    url?: unknown
    version?: unknown
    protocolVersion?: unknown
    capabilities?: unknown
    defaultInputModes?: unknown
    defaultOutputModes?: unknown
    image?: unknown
    active?: unknown
    x402Support?: unknown
    supportedTrust?: unknown
    note?: string
    provider?: { organization?: unknown; url?: string }
    skills?: Skill[]
    services?: Service[]
    registrations?: Registration[]
  }
  const regs = card.registrations ?? []
  const site = card.provider?.url ?? ''
  assert.match(site, /^https:\/\//)
  // Where this file is served: the tokenURI of every agent it is the registration file of.
  const self = `${site}/.well-known/agent-card.json`

  // Held to the ledger, testnets included. A registration says "this token is this agent", and explorers check it both
  // ways (8004scan's profile: a registration MUST match the on-chain agent and registry that point to this file). So every
  // agent of ours whose tokenURI is this file is registered here, and an agent of ours whose tokenURI is other metadata is
  // not: Arc testnet #849980 (Meridian) carries its own inline JSON, so it is a different agent, and the note says why it
  // is absent. A formerAgent (provenance.ts), one A-Identity registered that a retired address still holds, is never
  // registered here either (retired.test.ts), because the card advertises what we vouch for.
  for (const p of PROVENANCE) {
    const agent = p.agent
    if (!agent) continue
    const chain = CHAINS.find((c) => c.id === p.chain)!
    const what = `${chain.caip2} #${agent.tokenId}`
    const hit = regs.find((r) => r.chain === chain.caip2 && String(r.agentId) === agent.tokenId)
    if (agent.tokenUri !== self) {
      assert.equal(hit, undefined, `agent-card.json registers ${what}, whose tokenURI is other metadata, so it is a different agent`)
      assert.ok(card.note?.includes(`#${agent.tokenId}`), `the card's note does not say why ${what}, ours, is not registered`)
      continue
    }
    assert.ok(hit, `agent-card.json does not register ${what}, whose tokenURI the ledger records as this file`)
    assert.equal(hit.registry?.toLowerCase(), chain.contracts.identityRegistry?.toLowerCase(), `agent-card.json names the wrong registry for ${what}`)
    assert.equal(hit.agentId, Number(agent.tokenId), `agent-card.json writes the agentId of ${what} as ${JSON.stringify(hit.agentId)}`)
  }
  // On a chain where the ledger records our agent, the card registers that agent and no other token: Robinhood Chain #1
  // carries this file's URL too, minted by someone else (the ledger's caveats). X Layer #6271 is in no ledger entry: it is
  // the oracle's OKX.AI listing, whose file OKX.AI hosts.
  for (const r of regs) {
    const ours = PROVENANCE.find((p) => p.agent && CHAINS.find((c) => c.id === p.chain)?.caip2 === r.chain)?.agent
    if (ours) assert.equal(String(r.agentId), ours.tokenId, `agent-card.json registers ${r.chain} #${String(r.agentId)}, but our agent there is #${ours.tokenId}`)
  }

  // The card is also the ERC-8004 registration file (EIP-8004 registration-v1) that Arc Mainnet #0, Robinhood Chain #0
  // and Robinhood Chain testnet #0 resolve to, and indexers read it as one (Celo #9759 resolved here too, until its owner
  // pointed it at our Celo registration file on 2026-11-19, so the loop above holds it out). Until 2026-11-18 it had no type and
  // no agentRegistry in any registration, which 8004scan flagged (WA001, WA012), and no services, so the QuickNode
  // explorer listed it unconfigured.
  assert.equal(card.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1')
  for (const [field, value] of [['name', card.name], ['description', card.description]] as const) {
    assert.ok(typeof value === 'string' && value.trim().length > 0, `the registration file has no ${field}`)
  }
  assert.equal(card.active, true, 'active is the boolean true')
  assert.ok(card.x402Support === undefined || typeof card.x402Support === 'boolean', 'x402Support, when present, is a boolean')

  // The image is a square PNG of at least 512 px on our own site, and the file is in public/, so the link cannot rot unseen.
  assert.ok(typeof card.image === 'string' && card.image.startsWith(`${site}/`), 'the image is an absolute URL on our site')
  const png = readFileSync(fileURLToPath(new URL(`../../../public${new URL(card.image).pathname}`, import.meta.url)))
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'the image is a PNG')
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  assert.ok(width === height && width >= 512, `the image is ${width}x${height}; explorers want a square of 512 px or more`)

  // Trust models from the set the spec and 8004scan know.
  const TRUST = ['reputation', 'crypto-economic', 'tee-attestation', 'social-graph']
  assert.ok(Array.isArray(card.supportedTrust) && card.supportedTrust.length > 0, 'supportedTrust is a non-empty list')
  for (const t of card.supportedTrust) assert.ok(TRUST.includes(t), `supportedTrust names an unknown trust model: ${t}`)

  // Every registration carries a numeric agentId and an agentRegistry that names the chain and registry its own fields name.
  // agentRegistry is the form cardClaims (evm-pay-check) and mintTxHint (erc8004.ts) read before the chain and registry fields.
  assert.ok(regs.length > 0, 'the registration file lists no registration')
  for (const r of regs) {
    assert.ok(typeof r.agentId === 'number' && Number.isSafeInteger(r.agentId) && r.agentId >= 0, `${r.chain}: agentId is a non-negative integer`)
    assert.match(String(r.agentRegistry), /^[a-z][-a-z0-9]{0,31}:[0-9]+:0x[0-9a-fA-F]{40}$/, `${r.chain}: agentRegistry is {namespace}:{chainId}:{registry}`)
    assert.equal(r.agentRegistry, `${r.chain}:${r.registry}`, `${r.chain}: agentRegistry disagrees with chain and registry`)
    assert.equal(r.caip, `${r.agentRegistry}/${r.agentId}`, `${r.chain}: caip disagrees with agentRegistry and agentId`)
  }

  // Indexers key services by name, so a name appears once, and every endpoint is an https URL.
  const services = card.services ?? []
  const names = services.map((s) => String(s.name).toLowerCase())
  assert.equal(new Set(names).size, names.length, `two services share a name: ${names.join(', ')}`)
  for (const s of services) {
    assert.ok(typeof s.name === 'string' && s.name.length > 0 && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint), `service ${String(s.name)} has no https endpoint`)
  }
  const service = (name: string) => services.find((s) => s.name === name)
  assert.equal(service('web')?.endpoint, site)
  const serverCard = JSON.parse(repo('public/.well-known/mcp/server-card.json')) as { endpoint: string; protocolVersion: string }
  assert.deepEqual([service('MCP')?.endpoint, service('MCP')?.version], [serverCard.endpoint, serverCard.protocolVersion], 'the MCP service is the server card endpoint at its protocol version')
  // A2A points at this very file, with its skills. Celo #9759 resolves to our Celo registration file, celo-8004.json
  // (on chain since 2026-11-19), and that file's A2A service points here, so an agent that starts from the Celo token
  // still reaches this card. Its version is 0.3.0, the A2A AgentCard
  // schema the file validates against (and 8004scan's standard value), not the "1.0" of the card's own protocolVersion: an
  // A2A 1.0 interface needs protocolBinding and protocolVersion, and the card's supportedInterfaces are its MCP and x402
  // endpoints, not A2A bindings. There is no A2A message endpoint, and the service says so.
  assert.equal(service('A2A')?.endpoint, self)
  const celoFile = `${site}/.well-known/celo-8004.json`
  assert.equal(PROVENANCE.find((p) => p.chain === 'celo')?.agent?.tokenUri, celoFile, 'Celo #9759 resolves to its own registration file')
  const celoDoc = JSON.parse(repo('public/.well-known/celo-8004.json')) as { services?: Service[] }
  assert.equal(celoDoc.services?.find((s) => s.name === 'A2A')?.endpoint, self, 'the file Celo #9759 resolves to points its A2A service at this card')
  assert.equal(service('A2A')?.version, '0.3.0')
  assert.match(String(service('A2A')?.description), /for discovery only: A-Identity serves no A2A message endpoint/)
  assert.deepEqual(service('A2A')?.skills, (card.skills ?? []).map((s) => s.id))
  // The Celo check page is a real route, and the paid Celo tools are listed exactly, in the rail's order.
  assert.equal(service('celo-check')?.endpoint, `${site}/check/celo`)
  assert.match(repo('src/App.tsx'), /path="\/check\/celo"/)
  const tools = `${site}/api/celo/tools/`
  assert.deepEqual(
    services.map((s) => String(s.endpoint)).filter((e) => e.startsWith(tools)).map((e) => e.slice(tools.length)),
    [...CELO_TOOLS],
  )
  // The agent wallet is read on chain (setAgentWallet); declaring one in the file is deprecated (8004scan WA083).
  assert.equal(services.some((s) => s.name === 'agentWallet'), false)

  // The same file stays a valid A2A 0.3.0 AgentCard: the nine fields that schema requires, with its types, and every skill
  // with the four it requires. Nothing else holds this, and the next edits to this file (x402Support, a partner field)
  // must not drop or retype any of them.
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  const texts = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(text)
  for (const f of ['name', 'description', 'url', 'version', 'protocolVersion'] as const) assert.ok(text(card[f]), `A2A: ${f} is a non-empty string`)
  assert.match(String(card.url), /^https:\/\//)
  assert.ok(typeof card.capabilities === 'object' && card.capabilities !== null && !Array.isArray(card.capabilities), 'A2A: capabilities is an object')
  for (const f of ['defaultInputModes', 'defaultOutputModes'] as const) assert.ok(texts(card[f]), `A2A: ${f} is a non-empty list of media types`)
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0, 'A2A: skills is a non-empty list')
  for (const s of card.skills) {
    for (const f of ['id', 'name', 'description'] as const) assert.ok(text(s[f]), `A2A: a skill has no ${f}`)
    assert.ok(texts(s.tags), `A2A: skill ${String(s.id)} has no tags`)
  }
  // A2A makes the provider optional but requires both of its fields, and this test reads the site from it, so it is here.
  assert.ok(text(card.provider?.organization) && text(card.provider?.url), 'A2A: the provider has an organization and a url')
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

  /**
   * The named exception, the only one: a testnet with no mainnet twin in the registry that the
   * sentence names on purpose, with the reason written beside it. ProtocolsWall.tsx declares
   * the same map, and the loop below keeps the two in step. A new twinless testnet therefore
   * fails here until someone decides about it in writing, which is the point of naming it.
   */
  const STANDALONE_TESTNETS: Record<string, string> = {
    'near-testnet': 'hackathon-era testnet integration; no NEAR mainnet registry exists yet',
  }

  const named = CHAINS.filter((c) => !isMirror(c))
  const mirrors = CHAINS.filter(isMirror).map((c) => c.id)

  // Every testnet that HAS a mainnet twin must be dropped. Naming them is the assertion:
  // a fourth pair added to the registry lands here rather than in the marketing copy.
  assert.deepEqual(mirrors.sort(), ['algorand-testnet', 'celo-sepolia', 'rhchain-testnet', 'stellar-testnet'])

  assert.ok(named.some((c) => c.id === 'arc'), 'Arc has no mainnet twin and must stay in the sentence')
  assert.equal(
    named.filter((c) => c.testnet).map((c) => c.id).join(','), ['arc', ...Object.keys(STANDALONE_TESTNETS)].join(','),
    'Arc and the named standalone testnets are the only testnets the public sentence may name',
  )

  // And the component must actually use the derived rule rather than growing a new list.
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/components/sections/ProtocolsWall.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(src, /const isMirror = /, 'ProtocolsWall must derive its mirror set')
  assert.doesNotMatch(src, /MIRRORS = new Set/, 'a hand-written mirror list is what missed stellar-testnet')

  for (const [id, reason] of Object.entries(STANDALONE_TESTNETS)) {
    const c = CHAINS.find((x) => x.id === id)
    assert.ok(c?.testnet, `${id} is listed as a standalone testnet but the registry does not call it a testnet`)
    assert.ok(!isMirror(c), `the exception for ${id} is stale: it has a mainnet twin now, so the mirror rule drops it. Delete the entry.`)
    assert.ok(src.includes(`'${id}': '${reason}'`), `ProtocolsWall.tsx must declare the same exception for ${id}, with the same reason`)
  }
})
