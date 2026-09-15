#!/usr/bin/env node
/**
 * How long the deployed spend vaults have left before their state archives.
 *
 * Audit finding A2-04. A Soroban ledger entry has a TTL, and a contract's instance entry
 * carries every field this vault reads on every call: owner, operator, token, decimals,
 * cap, ceiling, frozen, allowlist flag, session expiry. `bump_instance` extends it, but it
 * is called only on WRITING entrypoints and on none of the thirteen views. So a vault that
 * is deployed, funded and then left alone drifts toward archival on a timer, and the pubnet
 * vault is in exactly that state today: its budget is spent, and x402 sales pay the payTo
 * account rather than the vault, so nothing writes to it.
 *
 * What archival is NOT: a brick. A2 proved by test, and CAP-0066 has done it on-chain since
 * protocol 23, that an archived Persistent or Instance entry is restored WITH ITS VALUE
 * rather than returning None. The four `unwrap()`s in storage.rs are therefore unreachable
 * this way. What it costs is rent on the next call, which now restores the entry inside
 * itself, and an operator who does not know it is coming.
 *
 * Note the asymmetry that makes this worth a script rather than a calendar reminder: a
 * TEMPORARY entry, which is what the day bucket is, is deleted permanently rather than
 * archived. Only persistent and instance entries come back.
 *
 * A write extends the clock only ONCE THE REMAINING LIFE IS BELOW the 60-day threshold.
 * `bump_instance` calls `extend_ttl(threshold, extend_to)`, which does nothing while the
 * current TTL is still above it. Verified on 2026-08-25: a real `set_frozen(false)` landed
 * on the pubnet vault and `live until` did not move, because 134 days remained.
 *
 * An archived entry still comes back from getLedgerEntries, with liveUntilLedgerSeq 0 (read
 * live on 2026-09-15). This script used to subtract that 0 from the current ledger and print
 * an archival date years in the past as if it were a countdown; it now says ARCHIVED.
 *
 * So this cannot be topped up early. Run it, and act when it warns.
 *
 *   node mcp/scripts/stellar-vault-archival.mjs                  # both networks
 *   node mcp/scripts/stellar-vault-archival.mjs --warn-days 30   # exit 1 when closer
 *
 * Exit codes: 0 all vaults comfortably live, 1 a vault is archived, missing or inside the
 * warning window, 2 a vault could not be read or the arguments are wrong.
 */
import { Address, rpc, xdr } from '@stellar/stellar-sdk'

import { CHAINS } from '../dist/chains/index.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const WARN_DAYS = Number(arg('warn-days', 30))
if (!Number.isFinite(WARN_DAYS) || WARN_DAYS < 0) {
  // A missing value used to become NaN, and every comparison against NaN is false, so the
  // warning could never fire while the flag looked set.
  console.error('--warn-days needs a number of days, for example --warn-days 45')
  process.exit(2)
}

/** Measured on pubnet 2026-08-24. Testnet ran 5.010 s the same day. */
const CLOSE_SECONDS = 5.625

const targets = CHAINS.filter((c) => c.ecosystem === 'stellar' && c.contracts?.spendVault).map((c) => ({
  chain: c,
  vault: c.contracts.spendVault,
  rpcUrl: c.rpcUrls[0],
}))

if (targets.length === 0) {
  console.error('No Stellar chain in the registry declares contracts.spendVault.')
  process.exit(2)
}

let worst = Infinity
/** 0 nothing wrong, 1 archived or missing, 2 unreadable. The worst one decides the exit. */
let problem = 0
for (const { chain, vault, rpcUrl } of targets) {
  const server = new rpc.Server(rpcUrl)
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(vault).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )

  let res
  try {
    res = await server.getLedgerEntries(key)
  } catch (e) {
    console.error(`${chain.id}: could not read the ledger entry: ${e instanceof Error ? e.message : e}`)
    problem = Math.max(problem, 2)
    continue
  }

  if (!res.entries.length) {
    // Never deployed here, or pruned beyond what the RPC will return. Worth saying out loud
    // rather than reporting as "0 days left", which reads as a countdown that finished normally.
    console.log(`${chain.id} ${vault}`)
    console.log('  NO INSTANCE ENTRY. Either this address is not deployed on this network, or the')
    console.log('  RPC no longer returns its archived entry.')
    problem = Math.max(problem, 1)
    continue
  }

  const current = res.latestLedger
  for (const entry of res.entries) {
    const liveUntil = entry.liveUntilLedgerSeq
    console.log(`${chain.id} ${vault}`)
    console.log(`  ledger now      ${current}`)
    if (typeof liveUntil !== 'number' || liveUntil <= current) {
      console.log(`  live until      ${liveUntil ?? '(not reported)'}`)
      console.log('  ARCHIVED. The instance entry came back with a lapsed TTL. Its values are kept; the')
      console.log('  next call to this vault restores it inside that same call, and whoever sends it')
      console.log('  pays the rent.')
      problem = Math.max(problem, 1)
      continue
    }
    const remaining = liveUntil - current
    const days = (remaining * CLOSE_SECONDS) / 86400
    const when = new Date(Date.now() + remaining * CLOSE_SECONDS * 1000)
    worst = Math.min(worst, days)

    console.log(`  live until      ${liveUntil}`)
    console.log(`  remaining       ${remaining} ledgers, about ${days.toFixed(1)} days at ${CLOSE_SECONDS}s`)
    console.log(`  archives around ${when.toISOString().slice(0, 10)}`)
    if (days < WARN_DAYS) {
      console.log(`  WARNING: under the ${WARN_DAYS}-day threshold. A write extends it only once`)
      console.log('  the remaining life is below the 60-day mark, so acting early buys nothing.')
      console.log('  The cheapest deliberate touch is set_frozen(false) on an unfrozen vault.')
    }
  }
}

if (problem === 2) {
  console.error('\nAt least one vault could not be read, so this run proves nothing about it.')
  process.exit(2)
}
if (problem === 1) {
  console.error('\nAt least one vault has no live instance entry.')
  process.exit(1)
}
if (worst < WARN_DAYS) {
  console.error(`\nA vault is within ${WARN_DAYS} days of archival.`)
  process.exit(1)
}
console.log(`\nAll vaults have more than ${WARN_DAYS} days of instance TTL left.`)
