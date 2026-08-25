#!/usr/bin/env node
/**
 * How long the deployed spend vaults have left before their state archives.
 *
 * Audit finding A2-04. A Soroban ledger entry has a TTL, and a contract's instance entry
 * carries every field this vault reads on every call: owner, operator, token, decimals,
 * cap, ceiling, frozen, allowlist flag, session expiry. `bump_instance` extends it, but it
 * is called only on WRITING entrypoints and on none of the thirteen views. So a vault that
 * is deployed, funded and then left alone drifts toward archival on a timer, and the pubnet
 * vault is in exactly that state today: the x402 rail still sells on testnet, so nothing
 * writes to it.
 *
 * What archival is NOT: a brick. A2 proved by test, and CAP-0066 has done it on-chain since
 * protocol 23, that an archived Persistent or Instance entry is restored WITH ITS VALUE
 * rather than returning None. The four `unwrap()`s in storage.rs are therefore unreachable
 * this way. What it costs is rent plus a restoring footprint on the next call, and an
 * operator who does not know it is coming.
 *
 * Note the asymmetry that makes this worth a script rather than a calendar reminder: a
 * TEMPORARY entry, which is what the day bucket is, is deleted permanently rather than
 * archived. Only persistent and instance entries come back.
 *
 * Any write resets the clock. `set_frozen(false)` on an unfrozen vault is a no-op that
 * costs a fee and buys 150 days, which is the cheapest way to touch it deliberately.
 *
 *   node mcp/scripts/stellar-vault-archival.mjs            # both networks
 *   node mcp/scripts/stellar-vault-archival.mjs --warn-days 30   # exit 1 when closer
 */
import { Address, rpc, xdr } from '@stellar/stellar-sdk'

import { CHAINS } from '../dist/chains/index.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const WARN_DAYS = Number(arg('warn-days', 30))

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
    process.exitCode = 2
    continue
  }

  if (!res.entries.length) {
    // Already archived, or never deployed. Both are worth saying out loud rather than
    // reporting as "0 days left", which reads as a countdown that has finished normally.
    console.log(`${chain.id} ${vault}`)
    console.log('  NO LIVE INSTANCE ENTRY. Either it has already archived and needs a restoring')
    console.log('  footprint on the next call, or this address is not deployed on this network.')
    process.exitCode = 1
    continue
  }

  const current = res.latestLedger
  for (const entry of res.entries) {
    const liveUntil = entry.liveUntilLedgerSeq
    const remaining = liveUntil - current
    const days = (remaining * CLOSE_SECONDS) / 86400
    const when = new Date(Date.now() + remaining * CLOSE_SECONDS * 1000)
    worst = Math.min(worst, days)

    console.log(`${chain.id} ${vault}`)
    console.log(`  ledger now      ${current}`)
    console.log(`  live until      ${liveUntil}`)
    console.log(`  remaining       ${remaining} ledgers, about ${days.toFixed(1)} days at ${CLOSE_SECONDS}s`)
    console.log(`  archives around ${when.toISOString().slice(0, 10)}`)
    if (days < WARN_DAYS) {
      console.log(`  WARNING: under the ${WARN_DAYS}-day threshold. Any write resets it; the cheapest`)
      console.log('  deliberate touch is set_frozen(false) on an unfrozen vault.')
    }
  }
}

if (worst < WARN_DAYS) {
  console.error(`\nA vault is within ${WARN_DAYS} days of archival.`)
  process.exit(1)
}
console.log(`\nAll vaults have more than ${WARN_DAYS} days of instance TTL left.`)
