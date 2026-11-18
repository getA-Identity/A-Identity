import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  FORMER_CELO_PAYTO,
  FORMER_OPERATING_WALLET,
  RETIRED_COMPROMISED,
  SWEEP_RECIPIENTS,
  isRetired,
  knownCompromised,
  retiredAddresses,
  retiredEntry,
  retiredPayToRefusal,
  retiredPublic,
  shortAddress,
  type RetiredAddress,
} from './retired.js'
import { evmWalletClientFromKey, noSignerReason, retiredSignerRefusal, usableSignerKey } from './evm/client.js'
import { getChainById } from './registry.js'
import { PROVENANCE, agentWalletClearedFor } from './provenance.js'
import { arcLedgerFacts } from './frontend-ledger.js'
import { ATTESTATIONS } from '../asp/attestations.js'
import { collectOurAddresses, committedOurKeys, committedRetiredKeys, liveOurAddressSources } from '../arc-owner-vault.js'
import { x402PayTo } from '../x402.js'
import { nanopayOnce } from '../nanopay.js'

/**
 * The retired list (retired.ts) and the protections that read it. The addresses are spelled out
 * only in retired.ts; everything here reads them from the module, which is what every other
 * file must do too, and the guard below holds them to it.
 */

/** Compiled to dist/chains/, so mcp/src is two levels up and the repository root three. */
const MCP_SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const TX_HASH = /0x[0-9a-f]{64}/g

test('the retired list holds exactly the two compromised addresses, each well formed, dated and evidenced', () => {
  assert.equal(RETIRED_COMPROMISED.length, 2)
  assert.deepEqual(RETIRED_COMPROMISED.map((r) => r.label), ['the former operating wallet', 'the former Celo pay-to'])
  assert.equal(FORMER_OPERATING_WALLET, RETIRED_COMPROMISED[0])
  assert.equal(FORMER_CELO_PAYTO, RETIRED_COMPROMISED[1])
  for (const r of RETIRED_COMPROMISED) {
    assert.match(r.address, /^0x[0-9a-f]{40}$/, 'the comparison form is lowercase')
    assert.equal(r.checksum, getAddress(r.address), 'the display form is the EIP-55 spelling of the same address')
    assert.equal(r.retiredOn, '2026-11-11')
    assert.equal(r.metricCutoff, '2026-11-01T13:01:41Z', 'the cutoff the season report used before the list existed')
    assert.ok(Number.isFinite(Date.parse(r.metricCutoff)))
    assert.ok((r.evidence.match(TX_HASH) ?? []).length >= 2, `${r.label}: the evidence names its transactions in full`)
    assert.doesNotMatch(r.label, /\bours?\b/i, 'a retired address is never called ours')
    assert.ok(Object.isFrozen(r))
  }
  assert.ok(Object.isFrozen(RETIRED_COMPROMISED), 'nothing adds to the list at run time')
  assert.equal(new Set(retiredAddresses()).size, 2)
  assert.deepEqual(retiredPublic(), RETIRED_COMPROMISED.map((r) => ({ address: r.address, label: r.label, retiredOn: r.retiredOn })))
  assert.equal(shortAddress(FORMER_OPERATING_WALLET.checksum), '0xd305...ed36')
})

test('isRetired and retiredEntry match any spelling of a retired address, and nothing else', () => {
  for (const r of RETIRED_COMPROMISED) {
    for (const spelled of [r.address, r.checksum, `0x${r.address.slice(2).toUpperCase()}`, ` ${r.checksum} `]) {
      assert.equal(isRetired(spelled), true, spelled)
      assert.equal(retiredEntry(spelled), r)
    }
  }
  for (const other of ['0x' + '00'.repeat(20), '0x' + 'ab'.repeat(20), '', null, undefined, 'not an address', RETIRED_COMPROMISED[0].address.slice(0, 41)]) {
    assert.equal(isRetired(other), false, String(other))
    assert.equal(retiredEntry(other), null)
  }
  assert.deepEqual(committedRetiredKeys(), [...retiredAddresses()].sort())
})

test('the sweep recipients are known with their evidence, and are not retired addresses of ours', () => {
  assert.equal(SWEEP_RECIPIENTS.length, 2)
  for (const s of SWEEP_RECIPIENTS) {
    assert.match(s.address, /^0x[0-9a-f]{40}$/)
    assert.equal(isRetired(s.address), false, 'a sweep recipient was never ours, so it is not retired')
    assert.ok((s.evidence.match(TX_HASH) ?? []).length >= 1)
    assert.deepEqual(knownCompromised(s.address.toUpperCase().replace('0X', '0x')), { kind: 'sweep-recipient', label: s.label, evidence: s.evidence })
  }
  for (const r of RETIRED_COMPROMISED) assert.equal(knownCompromised(r.checksum)?.kind, 'retired')
  assert.equal(knownCompromised('0x' + 'ab'.repeat(20)), null)
})

test('no retired address is ours: no committed list, env list or key turns one into ours, and the page key list leaves it out', () => {
  const committed = committedOurKeys()
  for (const r of RETIRED_COMPROMISED) assert.ok(!committed.includes(r.address), `${r.label} is not ours`)
  // Every source admission reads, each naming a retired address the way the live env named them before.
  const listed = RETIRED_COMPROMISED.map((r) => r.checksum).join(',')
  const env = { X402_GATEWAY_INTERNAL_PAYERS: listed, X402_3009_INTERNAL_PAYERS: listed, X402_GATEWAY_PAYTO: RETIRED_COMPROMISED[1].checksum } as NodeJS.ProcessEnv
  const live = liveOurAddressSources(env)
  const ours = collectOurAddresses({
    ...live,
    gatewayInternalPayers: [...live.gatewayInternalPayers, ...retiredAddresses()],
    attestationValidators: [...live.attestationValidators, RETIRED_COMPROMISED[0].checksum],
    ourPayees: [...live.ourPayees, { address: RETIRED_COMPROMISED[1].address, why: 'planted' }],
    committedKeyAddresses: { ...live.committedKeyAddresses, ARC_MAINNET_SIGNER_KEY: RETIRED_COMPROMISED[0].checksum },
    provenance: [...live.provenance, { chain: 'arc-mainnet', agent: { tokenId: '1', caip: 'x', owner: RETIRED_COMPROMISED[0].checksum, tokenUri: 'x' } }],
  })
  for (const r of RETIRED_COMPROMISED) assert.equal(ours.byAddress.has(r.address), false, `${r.label} must never be ours`)
  const { keys, retired } = arcLedgerFacts([...committed, ...retiredAddresses()])
  for (const held of Object.values(keys)) for (const r of RETIRED_COMPROMISED) assert.ok(!held.includes(r.address))
  assert.deepEqual(retired, retiredPublic())
})

test('a key whose address is retired is refused where signers are built: a labeled no-op that never names the key', async (t) => {
  // No test holds a retired key, so a test key stands in for one through the lookup the module takes.
  const key = `0x${'5a'.repeat(32)}`
  const standIn = privateKeyToAccount(key as `0x${string}`).address
  const lookup = (a: string): RetiredAddress | null => (a.toLowerCase() === standIn.toLowerCase() ? FORMER_OPERATING_WALLET : null)
  const said = retiredSignerRefusal(key, 'ARC_MAINNET_SIGNER_KEY', lookup)
  assert.ok(said)
  assert.match(said, /^ARC_MAINNET_SIGNER_KEY holds the key of the former operating wallet, which A-Identity retired on 2026-11-11 because someone else holds that key, so this server never signs with it\.$/)
  assert.ok(!said.includes(key.slice(2)) && !said.includes(standIn), 'neither the key nor its address is in the refusal')
  assert.equal(retiredSignerRefusal(key.slice(2), 'X', lookup)?.startsWith('X holds the key'), true, 'a bare key is the same key')
  // The real list refuses nothing a fresh key derives, and a value that is not a key is not judged here.
  assert.equal(retiredSignerRefusal(key, 'X'), null)
  for (const notAKey of [undefined, '', 'nope', `0x${'5a'.repeat(31)}`]) assert.equal(retiredSignerRefusal(notAKey, 'X', lookup), null)

  const logged = t.mock.method(console, 'error', () => {})
  assert.equal(usableSignerKey(key, 'ARC_SIGNER_KEY', lookup), undefined)
  assert.equal(usableSignerKey(key, 'ARC_SIGNER_KEY'), key)
  const arc = getChainById('arc-mainnet')!
  assert.equal(await evmWalletClientFromKey(arc, key, {}, lookup), null, 'no client, so nothing can be signed')
  const fresh = await evmWalletClientFromKey(arc, key, {})
  assert.equal(fresh?.account.address, standIn, 'a key that is not retired still builds its client')
  const lines = JSON.stringify(logged.mock.calls.map((c) => c.arguments))
  assert.match(lines, /retired on 2026-11-11/)
  assert.ok(!lines.includes(key.slice(2)), 'the log never carries the key')
})

test('nothing is paid to a retired address: the legacy x402 pay-to refuses one and does not fall back to the signer', async (t) => {
  t.mock.method(console, 'error', () => {})
  const fallback = `0x${'6b'.repeat(32)}`
  for (const r of RETIRED_COMPROMISED) {
    assert.equal(await x402PayTo({ X402_PAY_TO: r.checksum, ARC_SIGNER_KEY: fallback } as NodeJS.ProcessEnv), null)
    assert.equal(await x402PayTo({ X402_PAY_TO: r.address } as NodeJS.ProcessEnv), null)
    assert.match(retiredPayToRefusal('X402_PAY_TO', r.checksum) ?? '', new RegExp(`^X402_PAY_TO names ${r.label} \\(${shortAddress(r.checksum).replace(/\./g, '\\.')}\\), which A-Identity retired on 2026-11-11`))
  }
  const ours = '0x' + '7c'.repeat(20)
  assert.equal(await x402PayTo({ X402_PAY_TO: ours } as NodeJS.ProcessEnv), ours)
  assert.equal(await x402PayTo({ ARC_SIGNER_KEY: fallback } as NodeJS.ProcessEnv), privateKeyToAccount(fallback as `0x${string}`).address.toLowerCase(), 'the signer fallback production relies on still works')
  assert.equal(retiredPayToRefusal('X402_PAY_TO', ours), null)
})

test('a path with no signer says why: a retired key is named as refused, never as not set', () => {
  const key = `0x${'5a'.repeat(32)}`
  const standIn = privateKeyToAccount(key as `0x${string}`).address
  const lookup = (a: string): RetiredAddress | null => (a.toLowerCase() === standIn.toLowerCase() ? FORMER_OPERATING_WALLET : null)
  const env = { ARC_SIGNER_KEY: key } as NodeJS.ProcessEnv
  assert.equal(noSignerReason(env, 'ARC_SIGNER_KEY', lookup), retiredSignerRefusal(key, 'ARC_SIGNER_KEY', lookup))
  assert.match(noSignerReason(env, 'ARC_SIGNER_KEY', lookup), /^ARC_SIGNER_KEY holds the key of the former operating wallet, which A-Identity retired on 2026-11-11/)
  assert.equal(noSignerReason({} as NodeJS.ProcessEnv, 'ARC_SIGNER_KEY', lookup), 'No ARC_SIGNER_KEY set.')
  // Every Arc testnet path that answers without a signer opens its reason with it, so none says "not set" of a refused key.
  for (const file of ['appkit.ts', 'cctp.ts', 'airdrop.ts', 'gateway.ts', 'nanopay.ts', 'autopilot.ts', 'trust-oracle.ts']) {
    const text = readFileSync(join(MCP_SRC, file), 'utf8')
    assert.doesNotMatch(text, /'No ARC_SIGNER_KEY( set\.| -)/, `${file} hard-codes a no-key reason`)
    assert.match(text, /noSignerReason\(env, 'ARC_SIGNER_KEY'\)/, file)
  }
  assert.match(readFileSync(join(MCP_SRC, 'aa-wallet.ts'), 'utf8'), /retiredSignerRefusal\(env\.ARC_SIGNER_KEY, 'ARC_SIGNER_KEY'\) \?\? 'No PIMLICO_API_KEY/)
})

test('no server-signed nanopayment pays a retired address: nanopayOnce refuses it before it reads or signs anything', async () => {
  for (const r of RETIRED_COMPROMISED) {
    for (const spelled of [r.checksum, r.address]) {
      const out = await nanopayOnce(0.01, spelled, { ARC_SIGNER_KEY: `0x${'6b'.repeat(32)}` } as NodeJS.ProcessEnv)
      assert.deepEqual(out, { ok: false, reason: retiredPayToRefusal('payTo', spelled) })
    }
  }
})

test('the two agents the former operating wallet still holds are former agents, and the two it gave up on 2026-11-17 are ours again', () => {
  const former = PROVENANCE.filter((p) => p.formerAgent).map((p) => `${p.chain} #${p.formerAgent!.tokenId}`)
  assert.deepEqual(former.sort(), ['arbitrum #1259', 'base #73232'])
  for (const p of PROVENANCE) {
    if (p.agent) assert.equal(isRetired(p.agent.owner), false, `${p.chain}: an agent a retired address holds is not our agent`)
    if (!p.formerAgent) continue
    const chain = getChainById(p.chain)!
    assert.equal(p.formerAgent.caip, `${chain.caip2}:8004/${p.formerAgent.tokenId}`)
    assert.equal(p.formerAgent.heldBy, FORMER_OPERATING_WALLET.checksum)
    assert.match(p.formerAgent.note, /does not control this agent alone, because someone else holds the same key, so it is not ours and we do not vouch for it/)
    // Our validator rated both on chain and revoked that feedback on 2026-11-17: the note names the
    // revokeFeedback the entry records, and says A-Identity will not try to move the agent.
    const revocation = p.artifacts.find((a) => a.kind === 'attestation' && a.date === '2026-11-17' && a.note?.startsWith(`revokeFeedback(${p.formerAgent!.tokenId}, 1)`))
    assert.ok(revocation, `${p.chain}: the ledger records no revokeFeedback for #${p.formerAgent.tokenId}`)
    assert.ok(
      p.formerAgent.note.includes(`the feedback our oracle validator wrote for it on chain was revoked on 2026-11-17 (revokeFeedback, tx ${revocation.txHash.slice(0, 10)}), and A-Identity decided that day not to try to move it`),
      `${p.chain}: the feedback clause`,
    )
    assert.ok(p.summary.includes(`revoked the feedback it had written for it on 2026-11-17 (tx ${revocation.txHash.slice(0, 10)})`), `${p.chain}: the summary names the revocation`)
    for (const text of [p.formerAgent.note, p.summary]) assert.doesNotMatch(text, /has not been revoked|no longer controls/)
    assert.doesNotMatch(p.summary, /\bis ours\b(?! any more)/, `${p.chain}: the summary must not call it ours`)
  }
  // Arc testnet #849980 and Robinhood Chain testnet #0 moved from the former operating wallet to the
  // founder's wallet, the one that holds Arc Mainnet #0, on 2026-11-17: ours again, never former.
  const founder = PROVENANCE.find((p) => p.chain === 'arc-mainnet')!.agent!.owner
  for (const [chain, tokenId] of [['arc', '849980'], ['rhchain-testnet', '0']] as const) {
    const p = PROVENANCE.find((x) => x.chain === chain)!
    assert.equal(p.formerAgent, undefined, `${chain} #${tokenId} is ours again, not a former agent`)
    assert.equal(p.agent?.tokenId, tokenId)
    assert.equal(p.agent?.owner, founder, `${chain} #${tokenId} is held by the founder's wallet`)
    assert.match(p.summary, /is ours again: A-Identity registered it/)
    assert.ok(p.caveats.some((c) => c.startsWith(`On 2026-11-17 A-Identity moved agent #${tokenId} from the former operating wallet 0xd305...ed36 to 0xCB88...1bdf`)), `${chain}: a caveat records the move`)
    // The move cleared the agent wallet, so the ledger says so, and readers narrow a stored KYA "verified" with it.
    const evm = getChainById(chain)?.evmChainId
    assert.equal(agentWalletClearedFor(evm, tokenId)?.on, '2026-11-17', `${chain} #${tokenId}: the ledger records the cleared agent wallet`)
    assert.ok(p.artifacts.some((a) => a.kind === 'mint' && a.date === '2026-11-17' && a.txHash === agentWalletClearedFor(evm, tokenId)?.txHash), `${chain}: the move is an artifact`)
  }
  // A token the ledger never moved is not narrowed: Arc Mainnet #0 kept its agent wallet question to its own reads.
  assert.equal(agentWalletClearedFor(getChainById('arc-mainnet')?.evmChainId, '0'), null)
})

test('every attestation our validator revoked says so with the revokeFeedback the ledger records, and every former agent\'s is revoked', () => {
  const formerIds = new Set(PROVENANCE.filter((p) => p.formerAgent).map((p) => `${p.chain}:${p.formerAgent!.tokenId}`))
  const revoked = ATTESTATIONS.filter((a) => a.revoked)
  // Revoked on 2026-11-17: the two former agents' feedback, and Meridian's on Arc testnet, which is ours again.
  assert.deepEqual(revoked.map((a) => `${a.chain}:${a.tokenId}`).sort(), ['arbitrum:1259', 'arc:849980', 'base:73232'])
  for (const id of formerIds) assert.ok(revoked.some((a) => `${a.chain}:${a.tokenId}` === id), `${id}: a former agent's attestation must say it was revoked`)
  for (const a of ATTESTATIONS) {
    if (!a.revoked) {
      assert.equal(a.caveat, undefined, `${a.chain} #${a.tokenId} stands and carries no caveat`)
      continue
    }
    // The revocation is the one the ledger records on that chain, with its block and day, and its link is derived.
    const recorded = PROVENANCE.find((p) => p.chain === a.chain)?.artifacts.find((x) => x.txHash === a.revoked!.txHash)
    assert.ok(recorded, `${a.chain} #${a.tokenId}: the ledger does not record revocation ${a.revoked.txHash}`)
    assert.equal(recorded.kind, 'attestation')
    assert.equal(recorded.blockNumber, a.revoked.blockNumber)
    assert.equal(recorded.date, a.revoked.revokedOn)
    assert.equal(a.revoked.revokedOn, '2026-11-17')
    assert.equal(a.revoked.txUrl, `${getChainById(a.chain)!.explorer}/tx/${a.revoked.txHash}`)
    assert.ok(a.caveat?.startsWith(`Our oracle validator revoked this feedback on 2026-11-17 (revokeFeedback, tx ${a.revoked.txHash}), so it no longer stands on chain`), `${a.chain} #${a.tokenId}: the caveat`)
    assert.doesNotMatch(a.caveat ?? '', /No revokeFeedback has been sent|still stands on chain|not been revoked|no longer controls/)
    if (formerIds.has(`${a.chain}:${a.tokenId}`)) {
      assert.match(a.caveat ?? '', /an agent A-Identity registered that is still held by 0xd305\.\.\.ed36, the former operating wallet/)
    } else {
      assert.doesNotMatch(a.caveat ?? '', /still held by/, `${a.chain} #${a.tokenId} is ours again`)
    }
  }
})

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) filesUnder(full, out)
    else if (/\.(ts|tsx|js|mjs|cjs|json|md|mdx|css|html|txt)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * Files outside the module that still spell a retired address out, each with why, each due to go:
 * the test fails once such a file no longer needs its line, so an exception cannot outlive its reason.
 */
const NAMED_EXCEPTIONS: Record<string, string> = {
  // Empty since the homepage ring stopped naming the former operating wallet as an owner (it lists only
  // agents A-Identity holds). Add a file here only with its reason, and remove it once the reason is gone.
}

test('neither retired address appears in mcp/src or src outside the files allowed to name it', () => {
  const bodies = RETIRED_COMPROMISED.map((r) => new RegExp(r.address.slice(2), 'i'))
  const importsModule = /from '(?:\.{1,2}\/)+(?:chains\/)?retired\.js'/
  const offenders: string[] = []
  const seen = new Set<string>()
  for (const root of [MCP_SRC, join(REPO, 'src')]) {
    for (const file of filesUnder(root)) {
      const text = readFileSync(file, 'utf8')
      if (!bodies.some((b) => b.test(text))) continue
      const rel = relative(REPO, file).split('\\').join('/')
      seen.add(rel)
      if (rel === 'mcp/src/chains/retired.ts' || rel === 'mcp/src/chains/provenance.ts') continue
      if (rel === 'src/lib/arc-ledger.ts') {
        // The generated retired export, and only there.
        const before = text.slice(0, text.indexOf('export const ARC_LEDGER_RETIRED'))
        if (text.includes('export const ARC_LEDGER_RETIRED') && !bodies.some((b) => b.test(before))) continue
      }
      if (/\.test\.ts$/.test(rel) && importsModule.test(text)) continue
      if (NAMED_EXCEPTIONS[rel]) continue
      offenders.push(rel)
    }
  }
  assert.deepEqual(offenders, [], `Read a retired address from mcp/src/chains/retired.ts (or src/lib/arc-ledger.ts ARC_LEDGER_RETIRED) instead of spelling it out:\n  ${offenders.join('\n  ')}`)
  assert.ok(seen.has('mcp/src/chains/retired.ts'), 'the guard did not find the module itself, so it is not reading what it should')
  for (const rel of Object.keys(NAMED_EXCEPTIONS)) assert.ok(seen.has(rel), `${rel} no longer names a retired address: remove its exception from this test`)
})

test('the canary workflow checks exactly the retired list, under whatever name it gives the list', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/guardrail-canary.yml'), 'utf8')
  const lists = [...workflow.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g)]
    .map((m) => ({ name: m[1], addresses: (m[2].match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()) }))
    .filter((l) => l.addresses.some((a) => isRetired(a)))
  assert.equal(lists.length, 1, `expected one inline list of retired addresses in the canary, found ${lists.map((l) => l.name).join(', ') || 'none'}`)
  assert.deepEqual([...new Set(lists[0].addresses)].sort(), [...retiredAddresses()].sort(), `the canary's ${lists[0].name} list must equal RETIRED_COMPROMISED`)
})

test('the homepage ring and the agent card advertise only agents A-Identity holds, and the ring every one of them', () => {
  const ring = readFileSync(join(REPO, 'src/components/sections/AgentRing.tsx'), 'utf8')
  const card = JSON.parse(readFileSync(join(REPO, 'public/.well-known/agent-card.json'), 'utf8')) as {
    note?: string
    registrations?: { chain?: string; agentId?: number | string; owner?: string }[]
  }
  const regs = card.registrations ?? []
  // The card writes agentId as a number, the way ERC-8004 does; the ledger keeps token ids as strings.
  const idOf = (r: { agentId?: number | string }) => String(r.agentId)
  const ringHas = (chain: string, tokenId: string) => new RegExp(`chain: '${chain}',\\s*tokenId: '${tokenId}'`).test(ring)
  let ownersCompared = 0
  for (const p of PROVENANCE) {
    const caip2 = getChainById(p.chain)!.caip2
    if (p.formerAgent) {
      const id = p.formerAgent.tokenId
      assert.equal(ringHas(p.chain, id), false, `the ring still has a card for former agent ${p.chain} #${id}`)
      assert.equal(regs.some((r) => r.chain === caip2 && idOf(r) === id), false, `the agent card still registers former agent ${caip2} #${id}`)
      assert.ok(card.note?.includes(`#${id}`), `the agent card's note does not name former agent #${id}`)
    }
    if (p.agent) {
      assert.ok(ringHas(p.chain, p.agent.tokenId), `the ring has no card for our agent ${p.chain} #${p.agent.tokenId}`)
      // A registration the card shares with the ledger names the owner the ledger names (Robinhood Chain testnet #0 since
      // 2026-11-17). Arc testnet #849980 is ours too but is no registration of the card: its tokenURI is its own Meridian
      // metadata, so it is a different agent (public-copy.test.ts holds that).
      const reg = regs.find((r) => r.chain === caip2 && idOf(r) === p.agent!.tokenId)
      if (reg?.owner) {
        ownersCompared += 1
        assert.equal(reg.owner.toLowerCase(), p.agent.owner.toLowerCase(), `the agent card and the ledger disagree on who holds ${caip2} #${p.agent.tokenId}`)
      }
    }
  }
  // Every registration that names an owner was held to the ledger above, so a change in how the card writes an id cannot
  // quietly turn the owner check off.
  assert.equal(ownersCompared, regs.filter((r) => r.owner).length, 'a registration in the agent card names an owner but matches no agent in the ledger')
  for (const r of regs) assert.equal(isRetired(r.owner), false, `the agent card registers ${r.chain} #${r.agentId} under a retired owner`)
  assert.match(card.note ?? '', /so A-Identity does not control them alone\. They are not ours and this card does not vouch for them/)
  assert.doesNotMatch(card.note ?? '', /no longer controls/)
  assert.doesNotMatch(card.note ?? '', /0x[0-9a-fA-F]{40}/, 'the note names no address')
})

test('the proof page shows a former agent apart from our agent, never green, and counts a retired payer as internal', () => {
  const page = readFileSync(join(REPO, 'src/routes/ChainProof.tsx'), 'utf8')
  const start = page.indexOf('{net.formerAgent && (')
  assert.ok(start > 0, 'the proof page renders no former agent')
  const block = page.slice(start, page.indexOf('{/* Contracts, each with whether code is actually there right now. */}', start))
  assert.match(block, /Former agent #\{net\.formerAgent\.tokenId\}/)
  assert.match(block, /not ours: held by a retired address/)
  assert.doesNotMatch(block, /tone="ok"|ownerOf matches|\/address\//, 'no green chip and no owner link for a former agent')
  // What a retired address paid is internal, never external, and the build knows the list as well as the backend does.
  assert.match(page, /import \{ ARC_LEDGER_RETIRED \} from '\.\.\/lib\/arc-ledger'/)
  assert.equal(page.split('|| retired.has(s.payer.toLowerCase())').length - 1, 2, 'both EVM logs count a retired payer as internal')
  assert.match(page, /s\.retired \? 'internal: retired payer, not ours' : 'internal'/)
})
