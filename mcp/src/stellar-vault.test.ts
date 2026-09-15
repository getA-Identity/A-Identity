import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { CHAINS } from './chains/index.js'
import { OWNER_METHODS } from './chains/stellar/adapter.js'
import {
  LEDGER_CLOSE_SECONDS,
  OWNER_ACTIONS,
  authorizeOwnerCall,
  chooseStellarVaultOwner,
  isOwnerAction,
  ledgerTtl,
  ownerCallPlan,
  toRawUnits,
  vaultReport,
  type VaultStateView,
} from './stellar-vault.js'

/**
 * The rules behind the two owner-signing endpoints, tested where they are pure.
 *
 * These endpoints are a RELAY: the server builds a transaction it cannot sign, the owner's
 * wallet signs it, and the server broadcasts it. A relay is only as safe as what it
 * refuses, and almost everything below is a refusal. The positive cases are here so the
 * refusals are not passing by accident.
 */

const stellar = CHAINS.find((c) => c.id === 'stellar-testnet')!
const VAULT = stellar.contracts.spendVault as string
const DECIMALS = stellar.settlementTokens?.[0]?.decimals ?? 7

// ── the call plan ────────────────────────────────────────────────────────────────

test('the six actions are exactly the six the adapter will build, in the same spelling', () => {
  // Two lists of six strings in two modules is a drift hazard, and the drift would be
  // silent: an action this module allows and the adapter does not would 500 at the last
  // step, and the reverse would be a method nobody checked against the allowlist.
  assert.deepEqual([...OWNER_ACTIONS], [...OWNER_METHODS])
  // `pay` is deliberately absent: that is the agent operator's call and the server signs it
  // itself. Relaying it here would be a second, unauthenticated door into the same money.
  assert.equal(isOwnerAction('pay'), false)
  assert.equal(isOwnerAction('upgrade'), false)
})

test('a USD amount becomes base units at the token\'s own precision, not at six', () => {
  // Stellar settles at 7 decimals and every EVM stablecoin here at 6. A cap converted at
  // the wrong precision is a 10x mispricing in whichever direction hurts more.
  assert.equal(toRawUnits(1, 7), '10000000')
  assert.equal(toRawUnits(0.25, 7), '2500000')
  assert.equal(toRawUnits(1, 6), '1000000')
  assert.equal(toRawUnits(0, 7), '0')
})

test('set_policy builds three arguments and refuses to guess the allowlist flag', () => {
  const ok = ownerCallPlan('set_policy', { dailyCapUsd: 25, autoApproveUsd: 5, allowlistEnabled: true }, DECIMALS)
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  assert.deepEqual(ok.args, [
    { kind: 'i128', value: '250000000' },
    { kind: 'i128', value: '50000000' },
    { kind: 'bool', value: true },
  ])
  // An omitted boolean would turn somebody's allowlist off. That is a decision, not an
  // omission, so it has to be sent rather than defaulted.
  const guessed = ownerCallPlan('set_policy', { dailyCapUsd: 25, autoApproveUsd: 5 }, DECIMALS)
  assert.equal(guessed.ok, false)
  if (!guessed.ok) assert.match(guessed.reason, /allowlistEnabled/)
})

test('a cap of zero is allowed and means no cap; a negative or infinite one is refused', () => {
  assert.equal(ownerCallPlan('set_policy', { dailyCapUsd: 0, autoApproveUsd: 0, allowlistEnabled: false }, DECIMALS).ok, true)
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '25', null]) {
    const r = ownerCallPlan('set_policy', { dailyCapUsd: bad, autoApproveUsd: 5, allowlistEnabled: false }, DECIMALS)
    assert.equal(r.ok, false, `${String(bad)} must not be accepted as a cap`)
  }
})

test('a payment of zero is refused here, because the contract refuses it there', () => {
  // InvalidAmount: the Soroban port refuses `amount == 0` where the Solidity original
  // transferred nothing and emitted a Paid event anyway. Catching it before the network
  // means the caller gets the reason instead of a simulation failure.
  const zero = ownerCallPlan('owner_pay', { to: Keypair.random().publicKey(), amountUsd: 0 }, DECIMALS)
  assert.equal(zero.ok, false)
  if (!zero.ok) assert.match(zero.reason, /InvalidAmount/)
})

test('an expiry of zero is accepted and the summary says what zero actually means', () => {
  const r = ownerCallPlan('set_session_key_expiry', { expiryUnix: 0 }, DECIMALS)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.args, [{ kind: 'u64', value: '0' }])
  // The thing people get backwards: 0 is NO time bound at all, which is an operator whose
  // authority never lapses, the opposite of a session key.
  assert.match(r.summary, /never lapses/)
  // A fractional or negative expiry is not a UNIX second.
  assert.equal(ownerCallPlan('set_session_key_expiry', { expiryUnix: 1.5 }, DECIMALS).ok, false)
  assert.equal(ownerCallPlan('set_session_key_expiry', { expiryUnix: -1 }, DECIMALS).ok, false)
})

test('an address argument accepts an account or a contract, and nothing else', () => {
  const g = Keypair.random().publicKey()
  assert.equal(ownerCallPlan('set_allowed', { payee: g, allowed: true }, DECIMALS).ok, true)
  assert.equal(ownerCallPlan('set_allowed', { payee: VAULT, allowed: true }, DECIMALS).ok, true)
  // A 0x address is not an address on this chain at all, and writing one to the allowlist
  // would create an entry no payee can ever match.
  assert.equal(ownerCallPlan('set_allowed', { payee: '0x000000000000000000000000000000000000dEaD', allowed: true }, DECIMALS).ok, false)
})

test('every action produces only argument kinds the adapter knows how to convert', () => {
  const g = Keypair.random().publicKey()
  const plans = [
    ownerCallPlan('set_policy', { dailyCapUsd: 1, autoApproveUsd: 1, allowlistEnabled: false }, DECIMALS),
    ownerCallPlan('set_frozen', { frozen: true }, DECIMALS),
    ownerCallPlan('set_allowed', { payee: g, allowed: false }, DECIMALS),
    ownerCallPlan('set_session_key_expiry', { expiryUnix: 1 }, DECIMALS),
    ownerCallPlan('withdraw', { to: g, amountUsd: 1 }, DECIMALS),
    ownerCallPlan('owner_pay', { to: g, amountUsd: 1 }, DECIMALS),
  ]
  assert.equal(plans.length, OWNER_ACTIONS.length, 'every action needs a case here')
  for (const p of plans) {
    assert.equal(p.ok, true)
    if (!p.ok) continue
    for (const a of p.args) assert.ok(['i128', 'u64', 'bool', 'address'].includes(a.kind), `unknown kind ${a.kind}`)
  }
})

// ── who may ask ──────────────────────────────────────────────────────────────────

const baseAuth = (over: Partial<Parameters<typeof authorizeOwnerCall>[0]>) => {
  const owner = Keypair.random().publicKey()
  return authorizeOwnerCall({
    source: owner,
    contract: VAULT,
    caller: owner,
    callerIsWallet: true,
    linkedWallets: [],
    registryVaults: [VAULT],
    ownedVaults: [],
    liveOwner: owner,
    ...over,
  })
}

test('the owner of a registry vault, signed in with that wallet, is allowed', () => {
  assert.deepEqual(baseAuth({}), { ok: true })
})

test('a wallet linked to the account counts, even when the session is an email', () => {
  // Signing in with a magic link and linking a Stellar wallet is a normal way to hold one,
  // and refusing it would mean the feature only works for wallet sign-ins.
  const owner = Keypair.random().publicKey()
  const r = authorizeOwnerCall({
    source: owner,
    contract: VAULT,
    caller: 'someone@example.test',
    callerIsWallet: false,
    linkedWallets: [owner],
    registryVaults: [VAULT],
    ownedVaults: [],
    liveOwner: owner,
  })
  assert.deepEqual(r, { ok: true })
})

test('REFUSAL: a source that is not the caller\'s own wallet is never relayed for', () => {
  // The open-relay case. A correctly signed transaction from a stranger is still a
  // transaction we would be the sender of, and being the sender is not a neutral act.
  const stranger = Keypair.random().publicKey()
  const r = baseAuth({ source: stranger, liveOwner: stranger })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'not_your_wallet')
  assert.equal(r.status, 403)
})

test('REFUSAL: a contract we do not know is not addressable, however well the caller signs', () => {
  const owner = Keypair.random().publicKey()
  const r = authorizeOwnerCall({
    source: owner,
    contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    caller: owner,
    callerIsWallet: true,
    linkedWallets: [],
    registryVaults: [VAULT],
    ownedVaults: [],
    liveOwner: owner,
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'unknown_vault')
  assert.equal(r.status, 404)
})

test('a vault recorded on an agent the caller owns is addressable even though the registry does not name it', () => {
  const owner = Keypair.random().publicKey()
  const mine = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
  const r = authorizeOwnerCall({
    source: owner,
    contract: mine,
    caller: owner,
    callerIsWallet: true,
    linkedWallets: [],
    registryVaults: [VAULT],
    ownedVaults: [mine],
    liveOwner: owner,
  })
  assert.deepEqual(r, { ok: true })
})

test('REFUSAL: the vault\'s LIVE owner decides, not our stored copy of it', () => {
  const caller = Keypair.random().publicKey()
  const actualOwner = Keypair.random().publicKey()
  const r = baseAuth({ source: caller, caller, liveOwner: actualOwner })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'not_owner')
  assert.equal(r.status, 403)
  assert.ok(r.reason.includes(actualOwner), 'say who the owner actually is, so the caller can act')
})

test('REFUSAL: an owner read that did not answer is a 502, never a pass', () => {
  // Failing open here would let anyone spend our simulation budget building owner calls for
  // vaults they do not own, just by being unlucky with the RPC.
  const r = baseAuth({ liveOwner: null })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'rpc_error')
  assert.equal(r.status, 502)
})

test('REFUSAL: a malformed source or contract stops at the shape check', () => {
  assert.equal(baseAuth({ source: 'not-an-account' }).ok, false)
  assert.equal(baseAuth({ contract: 'not-a-contract' }).ok, false)
  // A G... where a C... belongs is the exact confusion StrKey's version byte exists for.
  assert.equal(baseAuth({ contract: Keypair.random().publicKey() }).ok, false)
})

// ── the public view ──────────────────────────────────────────────────────────────

test('ledger TTL turns into days and a date, with the conversion stated beside it', () => {
  const day = Math.round(86400 / LEDGER_CLOSE_SECONDS)
  const t = ledgerTtl(1_000_000 + day * 30, 1_000_000, Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(t.remainingLedgers, day * 30)
  assert.ok(Math.abs(t.approxDays - 30) < 0.1, `about thirty days, got ${t.approxDays}`)
  assert.equal(t.archivesAround, '2026-01-31')
  // The number is an estimate from a measured close time, so it never travels without the
  // assumption that produced it.
  assert.match(t.assumption, /per ledger close/)
})

const state = (): VaultStateView => ({
  owner: Keypair.random().publicKey(),
  operator: Keypair.random().publicKey(),
  token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  decimals: 7,
  dailyCapUsd: 25,
  autoApproveUsd: 5,
  spentTodayUsd: 0,
  balanceUsd: 1.5,
  frozen: false,
  allowlistEnabled: false,
  sessionKeyExpiry: 0,
})

test('a reachable vault reports its state, its ledger and how long it has left', () => {
  const r = vaultReport(
    stellar,
    VAULT,
    'https://example.test/contract',
    { reachable: true, ledger: 100, checkedAt: '2026-01-01T00:00:00.000Z', state: state(), liveUntilLedger: 100 + 15_360 },
    Date.parse('2026-01-01T00:00:00Z'),
  )
  assert.equal(r.network, 'testnet')
  assert.equal(r.contract, VAULT)
  assert.equal(r.live.reachable, true)
  assert.equal(r.live.ledger, 100)
  assert.ok(r.state)
  assert.ok(r.ttl)
  assert.equal(r.ttl?.remainingLedgers, 15_360)
})

test('an unreachable network is reported, never thrown, and carries no invented state', () => {
  // This endpoint's job is to say what is true right now, and "we could not reach it" is
  // true right now. Failing the whole response because one of two networks is slow tells a
  // reader nothing about the other one.
  const r = vaultReport(stellar, VAULT, 'https://example.test/contract', {
    reachable: false,
    checkedAt: '2026-01-01T00:00:00.000Z',
    reason: 'connect ETIMEDOUT',
  })
  assert.equal(r.live.reachable, false)
  assert.match(r.live.reason ?? '', /ETIMEDOUT/)
  assert.equal(r.state, undefined)
  assert.equal(r.ttl, undefined)
})

test('a vault with no live instance entry says so instead of reporting zero days left', () => {
  // Already archived, or never deployed here. Both are worth saying out loud: "0 days"
  // reads as a countdown that finished normally.
  const r = vaultReport(stellar, VAULT, 'https://example.test/contract', {
    reachable: true,
    ledger: 100,
    checkedAt: '2026-01-01T00:00:00.000Z',
    state: state(),
    liveUntilLedger: null,
  })
  assert.equal(r.ttl, undefined)
  assert.match(r.archived ?? '', /no live instance entry/)
})

test('the network label comes from the descriptor, so the two chains cannot be swapped', () => {
  const pubnet = CHAINS.find((c) => c.id === 'stellar')!
  const obs = { reachable: false as const, checkedAt: '2026-01-01T00:00:00.000Z', reason: 'x' }
  assert.equal(vaultReport(pubnet, VAULT, 'u', obs).network, 'pubnet')
  assert.equal(vaultReport(stellar, VAULT, 'u', obs).network, 'testnet')
})

test('an instance whose TTL has lapsed is reported ARCHIVED, never as a countdown that ended long ago', () => {
  // The RPC returns an archived entry with liveUntilLedgerSeq 0. That 0 used to reach
  // ledgerTtl, and the public vault view printed an archival date at the dawn of the ledger.
  const lapsed = vaultReport(stellar, VAULT, 'https://example.test/contract', {
    reachable: true,
    ledger: 100,
    checkedAt: '2026-01-01T00:00:00.000Z',
    state: state(),
    liveUntilLedger: 50,
  })
  assert.equal(lapsed.ttl, undefined)
  assert.match(lapsed.archived ?? '', /ARCHIVED/)
  const flagged = vaultReport(stellar, VAULT, 'https://example.test/contract', {
    reachable: true,
    ledger: 100,
    checkedAt: '2026-01-01T00:00:00.000Z',
    state: state(),
    liveUntilLedger: null,
    archived: true,
  })
  assert.equal(flagged.ttl, undefined)
  assert.match(flagged.archived ?? '', /ARCHIVED/)
})

test('a new vault owner is never guessed: explicit, then the wallet session, then the one linked wallet', () => {
  const explicit = Keypair.random().publicKey()
  const session = Keypair.random().publicKey()
  const linkedA = Keypair.random().publicKey()
  const linkedB = Keypair.random().publicKey()
  assert.deepEqual(chooseStellarVaultOwner({ ownerAddress: explicit, caller: session, linkedWallets: [linkedA] }), { ok: true, owner: explicit })
  assert.deepEqual(chooseStellarVaultOwner({ caller: session, linkedWallets: [linkedA, linkedB] }), { ok: true, owner: session })
  assert.deepEqual(chooseStellarVaultOwner({ caller: 'me@example.test', linkedWallets: [linkedA] }), { ok: true, owner: linkedA })
  // REFUSAL: several linked wallets and none named. This used to take the OLDEST link, and
  // the owner is permanent, so a guess here is a vault the caller may never control.
  const several = chooseStellarVaultOwner({ caller: 'me@example.test', linkedWallets: [linkedA, linkedB] })
  assert.equal(several.ok, false)
  if (!several.ok) {
    assert.deepEqual(several.linkedWallets, [linkedA, linkedB])
    assert.match(several.reason, /ownerAddress/)
  }
  // REFUSAL: a malformed ownerAddress is refused, not quietly replaced by another account.
  assert.equal(chooseStellarVaultOwner({ ownerAddress: explicit.slice(0, -1), caller: session, linkedWallets: [linkedA] }).ok, false)
  // REFUSAL: nothing to go on at all.
  assert.equal(chooseStellarVaultOwner({ caller: 'me@example.test', linkedWallets: [] }).ok, false)
})
