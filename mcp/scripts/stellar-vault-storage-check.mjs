#!/usr/bin/env node
/**
 * Check the vault panel against the ledger itself: read a vault's raw storage over RPC and
 * compare every policy field with what GET /api/stellar/vault/read answers.
 *
 * The panel (/app/vault/stellar) and the read endpoint both go through the contract's own
 * view functions. This goes underneath them: one getLedgerEntries call fetches, for every
 * vault named, its instance entry (DailyCap, AutoApproveMax, Frozen, AllowlistEnabled,
 * SessionKeyExpiry, Owner, Operator), its temporary SpentOnDay(day) entry, and the token
 * contract's Balance entry for it. One call means one ledger: every raw value below was
 * read at the same `latestLedger`. A missing SpentOnDay entry is not an error; the contract
 * stores spend per UTC day in temporary storage, and a day with no payment has no entry,
 * which reads as zero.
 *
 *   cd mcp && npm run build
 *   node scripts/stellar-vault-storage-check.mjs --chain stellar-testnet \
 *     --vault CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI --vault <C...> \
 *     [--api https://a-identity.xyz] [--json out.json]
 *
 * Read-only: it signs and submits nothing. Exit 0 when every field matches, 1 when any
 * differs or cannot be read, 2 on bad arguments.
 */
import { writeFileSync } from 'node:fs'
import { Address, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

const argv = process.argv.slice(2)
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []))
const one = (name, def) => all(name)[0] ?? def

let CHAINS, stellarRpcUrl
try {
  ;({ CHAINS } = await import('../dist/chains/index.js'))
  ;({ stellarRpcUrl } = await import('../dist/chains/stellar/client.js'))
} catch {
  console.error('mcp/dist is not built. Run: cd mcp && npm run build')
  process.exit(2)
}
const chain = CHAINS.find((c) => c.ecosystem === 'stellar' && (c.id === one('chain') || c.caip2 === one('chain')))
const vaults = all('vault')
if (!chain || vaults.length === 0 || vaults.some((v) => !/^C[A-Z2-7]{55}$/.test(v))) {
  console.error('usage: stellar-vault-storage-check.mjs --chain <stellar | stellar-testnet> --vault <C...> [--vault <C...>] [--api <base>] [--json <file>]')
  process.exit(2)
}
const api = one('api', 'https://a-identity.xyz').replace(/\/+$/, '')
const token = chain.settlementTokens?.[0]
if (!token) {
  console.error(`${chain.id} declares no settlement token`)
  process.exit(2)
}

const server = new rpc.Server(stellarRpcUrl(chain, process.env))
const contractData = (contract, key, durability) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key, durability }))
const sym = (s) => xdr.ScVal.scvSymbol(s)

// The day index the contract uses is floor(ledger close time / 86400). Taken from the read
// endpoint, which asks the contract's own today() view, and checked against the clock below.
const reads = []
for (const v of vaults) {
  const res = await fetch(`${api}/api/stellar/vault/read?network=${encodeURIComponent(chain.caip2)}&contract=${v}`, { signal: AbortSignal.timeout(90_000) })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body) {
    console.error(`${api} answered ${res.status} for ${v}: ${body?.reason ?? ''}`)
    process.exit(1)
  }
  reads.push(body)
}
const day = reads[0].day
const clockDay = Math.floor(Date.now() / 86_400_000)
if (reads.some((r) => r.day !== day)) console.warn('note: the reads straddle a UTC day boundary; run again')
if (day !== clockDay) console.warn(`note: the contract's day ${day} is not the clock's ${clockDay}; a read at midnight UTC can do that`)

const keys = vaults.flatMap((v) => [
  contractData(v, xdr.ScVal.scvLedgerKeyContractInstance(), xdr.ContractDataDurability.persistent()),
  contractData(v, xdr.ScVal.scvVec([sym('SpentOnDay'), nativeToScVal(BigInt(day), { type: 'u64' })]), xdr.ContractDataDurability.temporary()),
  contractData(token.address, xdr.ScVal.scvVec([sym('Balance'), new Address(v).toScVal()]), xdr.ContractDataDurability.persistent()),
])
const got = await server.getLedgerEntries(...keys)
const byKey = new Map(got.entries.map((e) => [e.key.toXDR('base64'), e]))
const entry = (k) => byKey.get(k.toXDR('base64')) ?? null

const rows = []
let mismatches = 0
for (const [i, v] of vaults.entries()) {
  const [kInstance, kSpent, kBalance] = keys.slice(i * 3, i * 3 + 3)
  const inst = entry(kInstance)
  if (!inst) {
    console.error(`${v}: no instance entry at ledger ${got.latestLedger}`)
    process.exit(1)
  }
  const storage = new Map(
    (inst.val.contractData().val().instance().storage() ?? []).map((m) => [String(scValToNative(m.key())), scValToNative(m.val())]),
  )
  const spent = entry(kSpent)
  const bal = entry(kBalance)
  const ledger = {
    DailyCap: String(storage.get('DailyCap')),
    AutoApproveMax: String(storage.get('AutoApproveMax')),
    Frozen: String(storage.get('Frozen')),
    AllowlistEnabled: String(storage.get('AllowlistEnabled')),
    SessionKeyExpiry: String(storage.get('SessionKeyExpiry')),
    [`SpentOnDay(${day})`]: spent ? String(scValToNative(spent.val.contractData().val())) : 'absent (reads as 0)',
    [`${token.symbol} balance`]: bal ? String(scValToNative(bal.val.contractData().val()).amount) : 'absent (reads as 0)',
    Owner: String(storage.get('Owner')),
    Operator: String(storage.get('Operator')),
  }
  const r = reads[i]
  const viaApi = {
    DailyCap: r.dailyCap.raw,
    AutoApproveMax: r.autoApproveMax.raw,
    Frozen: String(r.frozen),
    AllowlistEnabled: String(r.allowlistEnabled),
    SessionKeyExpiry: String(r.sessionKeyExpiry),
    [`SpentOnDay(${day})`]: r.spentToday.raw,
    [`${token.symbol} balance`]: r.balance.raw,
    Owner: r.owner,
    Operator: r.operator,
  }
  for (const field of Object.keys(ledger)) {
    const raw = ledger[field].startsWith('absent') ? '0' : ledger[field]
    const same = raw === viaApi[field]
    if (!same) mismatches += 1
    rows.push({ vault: v, field, ledger: ledger[field], api: viaApi[field], match: same, ledgerSeq: got.latestLedger, apiLedger: r.ledger })
  }
}

console.log(`Raw storage read at ledger ${got.latestLedger} (${chain.caip2}); API reads at ledger(s) ${reads.map((r) => r.ledger).join(', ')}; day ${day}\n`)
for (const r of rows) console.log(`${r.match ? 'ok  ' : 'DIFF'} ${r.vault.slice(0, 8)}  ${r.field.padEnd(20)} ledger ${r.ledger.padEnd(24)} api ${r.api}`)
if (one('json')) writeFileSync(one('json'), `${JSON.stringify({ chain: chain.caip2, ledger: got.latestLedger, day, api, rows }, null, 2)}\n`)
console.log(mismatches ? `\n${mismatches} field(s) differ` : '\nevery field matches')
process.exit(mismatches ? 1 : 0)
