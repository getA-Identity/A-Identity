#!/usr/bin/env node
/**
 * Snapshot the spend vault's allowlist, because a redeploy silently drops it.
 *
 * Audit finding A7-01, decision D-2. The vault has no `allowed_payees()` view: the
 * allowlist lives in `Allowed(Address)` persistent entries keyed to the CONTRACT ID, and
 * INV-19 deliberately refuses to add an enumerating read. The only on-chain question you
 * can ask is `is_allowed(one address)`. So there is no way to ask the contract who is on
 * its list, and a redeploy, which necessarily produces a new contract id, leaves every one
 * of those entries stranded behind an address nobody calls any more. The policy does not
 * fail loudly on the new vault. It comes up empty, and `allowlist_enabled` comes up false,
 * which is the OPEN state. That silence is what makes A7-01 a Medium rather than a Low.
 *
 * The obvious recovery, reading the `AllowlistSet` events back, has a deadline nobody
 * chose. RPC event retention is a rolling window of 120,960 ledgers, about 7.9 days, and
 * the August allowlist writes fell out of it long ago: this script read both networks on
 * 2026-09-15 and getEvents returned zero events for either vault. The events are not
 * missing, they are expired, and no amount of re-querying brings them back.
 *
 * So the snapshot is built the only way that still works: by PROBING. `is_allowed(payee)`
 * is a free simulation, and the candidate list is assembled from everything we can name,
 * the previous snapshot, the release records, the accounts this project actually uses, any
 * payee still visible in the event window, and whatever `--probe` adds. That is an
 * incomplete method and it says so in the file it writes. An allowlisted payee nobody
 * thought to name is invisible to this script and will be lost by a redeploy, which is the
 * residual risk D-2 option A accepts rather than solves.
 *
 * Two modes, and the second one is the point:
 *
 *   node mcp/scripts/stellar-vault-allowlist.mjs                  # read live, write the snapshot
 *   node mcp/scripts/stellar-vault-allowlist.mjs --check          # compare only, exit 1 on drift
 *   node mcp/scripts/stellar-vault-allowlist.mjs --probe G... --probe G...
 *
 * `--check` is the pre-redeploy gate and the weekly CI step. It writes nothing. It goes red
 * when the live allowlist has moved away from the committed snapshot, which means either
 * somebody armed a payee without recording it, or the snapshot is what a redeploy would
 * restore and it is now wrong.
 *
 * Read-only on chain. No signer, no env, nothing submitted.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Account, Address, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk'

import { CHAINS, createStellarAdapter } from '../dist/chains/index.js'
import { networkPassphrase } from '../dist/chains/stellar/client.js'

/**
 * The stand-in source account for reads, copied in intent from the adapter's own
 * READ_ONLY_SOURCE: an all-zero ed25519 key in StrKey form. It exists on no network and
 * cannot sign, which is exactly why it is safe here. The simulator needs a CLASSIC account
 * id to build a footprint and never checks that it exists.
 *
 * The adapter's `view` is private and takes no arguments, and `is_allowed` needs one, so
 * this script carries its own three-line version rather than widening the adapter's surface
 * for a maintenance script.
 */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

const CHECK = process.argv.includes('--check')
const PROBES = process.argv.reduce((acc, a, i) => (a === '--probe' ? [...acc, process.argv[i + 1]] : acc), [])

const ACCOUNT_RE = /^G[A-Z2-7]{55}$/
for (const p of PROBES) {
  if (!ACCOUNT_RE.test(String(p))) {
    console.error(`--probe ${p} is not a Stellar G... account id.`)
    process.exit(2)
  }
}

/**
 * Accounts worth asking about on every network, with where each one came from.
 *
 * Probing a testnet account against pubnet is harmless and costs one simulation: it answers
 * false, and a false is recorded rather than dropped, so the file shows what was ASKED and
 * not only what was found. That distinction is the whole reason `probed` is a separate
 * field from `allowed`.
 */
const KNOWN = [
  // soroban/releases/pubnet-v0.1.0.json constructor. Also the pubnet x402 payTo today.
  'GARC7OFBBQCZJ5N3LCI7HTTYJ2MMPDAFDNGIHSQMZ7EPJ5EAWQJ5R6I5',
  'GDLAJM25YQRTIZOVZPVEM2GJ6L2I4OTZGY3HAWX3HGMPV7SM3QZONO4S',
  // soroban/releases/testnet-v0.1.0.json constructor.
  'GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5',
  'GDZXSO4AOKPSHMQZMBNEEBQNYOIF7TWDPD7K2U5VAPKFN3QIAIELTAN6',
  // The testnet x402 seller and the buyer that has paid it.
  'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI',
  'GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R',
]

const RELEASES = new URL('../../soroban/releases/', import.meta.url)

/** The two constructor roles out of a release record, when one is there to read. */
function releaseAccounts(network) {
  try {
    const rec = JSON.parse(readFileSync(new URL(`${network}-v0.1.0.json`, RELEASES), 'utf8'))
    return [rec?.constructor?.owner, rec?.constructor?.operator].filter((g) => ACCOUNT_RE.test(String(g)))
  } catch {
    // A missing release record is not an error here. It removes two candidates from a list
    // that was never claimed to be complete, and the note in the output says so.
    return []
  }
}

const targets = CHAINS.filter((c) => c.ecosystem === 'stellar' && c.contracts?.spendVault)
if (targets.length === 0) {
  console.error('No Stellar chain in the registry declares contracts.spendVault.')
  process.exit(2)
}

let drift = 0
let failed = 0

for (const chain of targets) {
  const vault = chain.contracts.spendVault
  // Derived from the registry rather than typed, so a third Stellar network names its own
  // file the day it lands.
  const network = chain.caip2.split(':')[1]
  const file = new URL(`${network}-allowlist.json`, RELEASES)
  const net = networkPassphrase(chain)
  const server = new rpc.Server(chain.rpcUrls[0])
  const contract = new Contract(vault)

  console.log(`${chain.id}  ${chain.caip2}`)
  console.log(`  vault ${vault}`)

  /** One `is_allowed`, as a simulation. Costs nothing, signs nothing, writes nothing. */
  async function isAllowed(payee) {
    const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(contract.call('is_allowed', new Address(payee).toScVal()))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error)
    if (!sim.result) throw new Error('simulation returned no result')
    return Boolean(scValToNative(sim.result.retval))
  }

  // ── The vault's own view of itself ──────────────────────────────────────────────
  let state
  try {
    state = await createStellarAdapter(chain).readVault(vault, {})
  } catch (e) {
    console.error(`  could not read the vault: ${e instanceof Error ? e.message : e}`)
    failed += 1
    console.log('')
    continue
  }
  const latest = await server.getLatestLedger()
  console.log(`  owner ${state.owner}`)
  console.log(`  operator ${state.operator}`)
  console.log(`  allowlist_enabled ${state.allowlistEnabled}  ledger ${latest.sequence}`)

  // ── Payees still visible in the event window ────────────────────────────────────
  //
  // This is a bonus, never a source of truth. An empty result here means "nothing in the
  // window", which on a vault last touched in August is the EXPECTED answer and must not
  // be reported as "nobody is allowed". The two states are kept apart in `eventWindow`.
  let eventPayees = []
  let eventWindow
  try {
    const health = await server.getHealth()
    // A few ledgers of margin, because `oldestLedger` only moves FORWARD. Between this read
    // and the getEvents call below, the window can slide past the exact value we were given,
    // and the RPC then rejects the whole query as out of range. Ten ledgers is under a
    // minute against a 7.9-day window, and it turns a weekly flake into nothing.
    const oldest = Number(health.oldestLedger) + 10
    const retention = Number(health.ledgerRetentionWindow ?? latest.sequence - oldest)
    let cursor
    let pages = 0
    let seen = 0
    for (;;) {
      const page = await server.getEvents({
        ...(cursor ? { cursor } : { startLedger: oldest }),
        filters: [{ type: 'contract', contractIds: [vault] }],
        limit: 200,
      })
      seen += page.events.length
      for (const ev of page.events) {
        // topics[0] is the event name symbol, topics[1] is the indexed payee. Decoded
        // defensively: a topic shape we do not recognise is skipped rather than guessed at.
        try {
          const topics = ev.topic.map((t) => scValToNative(t))
          if (String(topics[0]) !== 'AllowlistSet') continue
          const payee = String(topics[1])
          if (ACCOUNT_RE.test(payee)) eventPayees.push(payee)
        } catch {
          /* an undecodable topic is not an allowlist write we can name */
        }
      }
      cursor = page.cursor ?? page.events.at(-1)?.id
      pages += 1
      if (!cursor || page.events.length < 200 || pages >= 25) break
    }
    eventPayees = [...new Set(eventPayees)].sort()
    eventWindow = {
      available: true,
      oldestLedger: oldest,
      retentionLedgers: retention,
      retentionDaysApprox: Number(((retention * 5.625) / 86400).toFixed(1)),
      contractEventsSeen: seen,
      allowlistSetPayees: eventPayees,
    }
    const days = eventWindow.retentionDaysApprox
    console.log(`  event window      ledgers ${oldest}..${latest.sequence}, about ${days} days, ${seen} contract events`)
    if (seen === 0) {
      console.log('  the window holds no event from this vault at all, which is not the same as')
      console.log('  "no payee was ever allowed". Older writes have expired out of retention.')
    }
  } catch (e) {
    // A getEvents failure is "we could not look", never "there is nothing there". Recording
    // it as the latter would turn an RPC outage into a false all-clear in the snapshot.
    eventWindow = { available: false, reason: e instanceof Error ? e.message : String(e) }
    console.log(`  event window      UNAVAILABLE (${eventWindow.reason.slice(0, 120)})`)
    console.log('  Treat this as "not looked at", not as "no events".')
  }

  // ── Whatever the last snapshot claimed ──────────────────────────────────────────
  let previous = null
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    previous = null
  }

  // ── Probe every candidate we can name ───────────────────────────────────────────
  const candidates = [
    ...(previous?.allowed ?? []),
    ...(previous?.probed ?? []).map((p) => p.account),
    ...PROBES,
    ...releaseAccounts(network),
    ...KNOWN,
    ...eventPayees,
  ].filter((g) => ACCOUNT_RE.test(String(g)))

  const probed = []
  for (const account of [...new Set(candidates)].sort()) {
    try {
      probed.push({ account, allowed: await isAllowed(account) })
    } catch (e) {
      // An unreadable probe is recorded as unreadable. It is NOT recorded as false, because
      // false is an answer and this is the absence of one.
      probed.push({ account, allowed: null, unreadable: e instanceof Error ? e.message.slice(0, 200) : String(e) })
    }
  }
  const allowed = probed.filter((p) => p.allowed === true).map((p) => p.account).sort()
  const unreadable = probed.filter((p) => p.allowed === null)

  console.log(`  probed ${probed.length} candidates, ${allowed.length} allowed${unreadable.length ? `, ${unreadable.length} unreadable` : ''}`)
  for (const p of probed) {
    const mark = p.allowed === null ? 'UNREADABLE' : p.allowed ? 'ALLOWED   ' : 'no        '
    console.log(`    ${mark} ${p.account}`)
  }
  if (state.allowlistEnabled && allowed.length === 0) {
    console.log('  NOTE: the allowlist is ENFORCED and no candidate we can name is on it. Either a')
    console.log('  payee exists that this script cannot name, or the agent path is locked out (A5-07).')
  }
  if (!state.allowlistEnabled && allowed.length > 0) {
    console.log('  NOTE: entries exist but the allowlist is NOT enforced, so they bind nothing today.')
    console.log('  They would still have to be re-armed by hand after a redeploy.')
  }

  const snapshot = {
    network: chain.caip2,
    contract: vault,
    readAt: new Date().toISOString(),
    ledger: latest.sequence,
    allowlistEnabled: state.allowlistEnabled,
    owner: state.owner,
    operator: state.operator,
    allowed,
    probed,
    eventWindow,
    note:
      'Built by PROBING is_allowed(payee) for every candidate this repo can name, not by ' +
      'enumerating the contract. The vault has no allowed_payees() view (INV-19) and RPC ' +
      'event retention is about 7.9 days, so the AllowlistSet writes that armed this list ' +
      'are gone. `allowed` is therefore a lower bound: a payee nobody named here is ' +
      'invisible to this script and would be lost by a redeploy. That residual is what ' +
      'D-2 option A accepts. Regenerate with `node mcp/scripts/stellar-vault-allowlist.mjs`, ' +
      'add candidates with --probe G..., and gate a redeploy with --check.',
  }

  if (CHECK) {
    if (!previous) {
      console.log(`  CHECK FAILED: no snapshot at soroban/releases/${network}-allowlist.json to compare against.`)
      console.log('  Run the script without --check once and commit the file it writes.')
      drift += 1
      console.log('')
      continue
    }
    const before = JSON.stringify([previous.allowed ?? [], previous.allowlistEnabled])
    const after = JSON.stringify([allowed, state.allowlistEnabled])
    if (before === after) {
      console.log('  CHECK OK: the live allowlist matches the committed snapshot.')
    } else {
      console.log('  CHECK FAILED: the live allowlist has drifted from the committed snapshot.')
      console.log(`    snapshot: enabled=${previous.allowlistEnabled} allowed=[${(previous.allowed ?? []).join(', ')}]`)
      console.log(`    live:     enabled=${state.allowlistEnabled} allowed=[${allowed.join(', ')}]`)
      console.log('  Re-run without --check to record the new state, and say in the commit why it moved.')
      drift += 1
    }
    console.log('')
    continue
  }

  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`  wrote soroban/releases/${network}-allowlist.json`)
  console.log('')
}

if (failed) {
  console.error(`${failed} vault(s) could not be read. Nothing was concluded about them.`)
  process.exit(2)
}
if (CHECK && drift) {
  console.error(`${drift} vault(s) drifted from their committed snapshot.`)
  process.exit(1)
}
console.log(CHECK ? 'Every vault matches its committed snapshot.' : 'Snapshots written. Commit them: they are data, not secrets.')
