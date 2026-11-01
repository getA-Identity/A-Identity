/**
 * What a transaction this page handed to a wallet became, and where a vault setup stands,
 * decided from facts the network modules gather, as pure functions.
 *
 * Type-only imports plus vault-rules.ts (which has none), named with its .ts extension, on
 * purpose: mcp/src/frontend-arc-vault.test.ts loads this file straight from src/ through Node's
 * type stripping and feeds it fake receipts, nonces and read-backs. receipt.ts gathers the facts
 * from every RPC and asks this file what they mean. The rules:
 *
 *   - One host's null decides nothing: while no host has a receipt, a transaction is pending.
 *   - A receipt without every expected event is landed-but-not-as-expected, never settled.
 *   - A read-back is taken at the receipt's own block. A read older than the receipt, or one
 *     that failed, never makes anything 'unexpected': it only means asking again.
 *   - This hash's own nonce used by another transaction, with still no receipt for this hash
 *     after a short watch, is a final 'replaced'. Nothing waits forever on a transaction that
 *     can no longer land, and nothing holds the owner's controls behind it.
 *   - No funding is offered before the vault's key is bounded in time, and the vault's live
 *     state wins over a record that only says pending.
 */
import type { SetupState, TxRecord } from './pending'
import type { VaultSnapshot } from './vault-read'
import { FEE_FLOOR_WEI, sameAddress } from './vault-rules.ts'

// --- what a receipt must carry ---

export type VaultEventName = 'SessionKeyExpirySet' | 'FrozenSet' | 'PolicyUpdated' | 'OperatorSet' | 'Withdrawn'

/** One thing a settled receipt must contain. Addresses compare case-insensitively. */
export type Expectation =
  | { kind: 'event'; address: string; eventName: VaultEventName; args: Record<string, string | bigint | boolean> }
  | { kind: 'transfer'; token: string; from: string; to: string; value: bigint }

/** One log decoded against the vault's or the token's ABI: who emitted it, which event, its arguments. */
export type DecodedLog = { address: string; eventName: string; args: Readonly<Record<string, unknown>> }

function argEquals(a: unknown, b: string | bigint | boolean): boolean {
  if (typeof b === 'string') return typeof a === 'string' && sameAddress(a, b)
  return a === b
}

/** Which expectations the decoded logs do NOT meet, as plain descriptions. Empty means all met. */
export function missingFrom(logs: readonly DecodedLog[], expect: readonly Expectation[]): string[] {
  const missing: string[] = []
  for (const x of expect) {
    if (x.kind === 'event') {
      const hit = logs.some(
        (l) => l.eventName === x.eventName && sameAddress(l.address, x.address) && Object.entries(x.args).every(([k, v]) => argEquals(l.args[k], v)),
      )
      if (!hit) missing.push(`a ${x.eventName} event from the vault with the values sent`)
    } else {
      const hit = logs.some(
        (l) =>
          l.eventName === 'Transfer' &&
          sameAddress(l.address, x.token) &&
          argEquals(l.args.from, x.from) &&
          argEquals(l.args.to, x.to) &&
          l.args.value === x.value,
      )
      if (!hit) missing.push('a USDC Transfer of the exact amount between the expected addresses')
    }
  }
  return missing
}

// --- asking every host ---

export type FirstFound<T> = { found: true; value: T; index: number; answered: number; total: number } | { found: false; answered: number; total: number }

/**
 * Every host asked at once, and the first one that has the answer decides. A host saying "not
 * found", or not answering at all, decides nothing: it only counts toward how many were asked
 * (`answered` counts the hosts that said found or not found). So this resolves 'found' as soon
 * as any host has it, whatever the others are still doing, and 'not found' only once every host
 * has had its say. On Arc one host returning null for a receipt that exists is routine.
 */
export function firstFound<T>(asks: readonly Promise<T>[], isNotFound: (e: unknown) => boolean): Promise<FirstFound<T>> {
  const total = asks.length
  return new Promise((resolve) => {
    if (total === 0) {
      resolve({ found: false, answered: 0, total })
      return
    }
    let settled = 0
    let answered = 0
    let done = false
    asks.forEach((ask, index) => {
      ask.then(
        (value) => {
          settled += 1
          answered += 1
          if (done) return
          done = true
          resolve({ found: true, value, index, answered, total })
        },
        (e) => {
          settled += 1
          if (isNotFound(e)) answered += 1
          if (!done && settled === total) {
            done = true
            resolve({ found: false, answered, total })
          }
        },
      )
    })
  })
}

// --- a receipt that a host returned ---

/** A receipt, reduced to what a decision needs. The caller checksums contractAddress. */
export type Landed = { success: boolean; block: bigint; feeWei: bigint; host: string; contractAddress: string | null }

/** The vault's state read back at a block, for the writes whose effect can be read back. */
export type ReadBack = { ok: true; block: bigint; sessionKeyExpiry: bigint; balance: bigint } | { ok: false; reason: string }

/**
 * A vault read back against what a deploy asked for: it is exactly that, it is something else,
 * there is no code at the address, or the read itself failed.
 */
export type DeployBack = { status: 'ok' | 'mismatch' | 'no_code' | 'unreadable'; why: string | null }

/**
 * How many read-backs are tried after a receipt arrives. A deploy then falls back to a read at
 * the latest block (receipt.ts); any other write settles on its receipt's events alone, saying so.
 */
export const READ_BACK_TRIES = 6

/** True when the write's effect is read back from the vault before it counts as settled. */
export function needsReadBack(r: TxRecord): boolean {
  if (!r.vault) return false
  if (r.action === 'expiry' || r.action === 'extend' || r.action === 'revoke') return r.expiry !== undefined
  if (r.action === 'fund') return r.amount !== undefined
  return false
}

/** What a landed transaction became, from its receipt, the events it is missing and its read-back. */
export function decideLanded(
  record: TxRecord,
  rc: Landed,
  x: { missing?: readonly string[]; readBack?: ReadBack | null; deploy?: DeployBack | null },
): TxRecord {
  const tries = (record.readBackTries ?? 0) + 1
  const base: TxRecord = { ...record, block: rc.block, feeWei: rc.feeWei, host: rc.host, nonceUsedAt: undefined }
  if (!rc.success) return { ...base, outcome: 'reverted', note: undefined }

  if (record.action === 'deploy') {
    const created = rc.contractAddress
    if (!created) return { ...base, outcome: 'unexpected', note: 'The receipt names no contract address, so no vault was created.' }
    if (!record.deployArgs)
      return { ...base, outcome: 'unexpected', contractAddress: created, note: 'This page lost what the vault was meant to read back as.' }
    const back = x.deploy
    if (!back || back.status === 'no_code' || back.status === 'unreadable')
      return {
        ...base,
        contractAddress: created,
        outcome: 'pending',
        readBackTries: tries,
        note: 'The receipt is in; reading the new vault back before calling it deployed.',
      }
    if (back.status === 'mismatch')
      return {
        ...base,
        contractAddress: created,
        vault: created,
        outcome: 'unexpected',
        note: `A contract was created but it does not read back as asked: ${back.why ?? 'its values differ'}.`,
      }
    return { ...base, contractAddress: created, vault: created, outcome: 'settled', note: undefined }
  }

  const missing = x.missing ?? []
  if (missing.length)
    return { ...base, outcome: 'unexpected', logsMatched: false, note: `It landed, but the receipt does not carry ${missing.join(', or ')}.` }

  if (needsReadBack(record)) {
    const r = x.readBack
    if (!r || !r.ok || r.block < rc.block) {
      if (tries >= READ_BACK_TRIES)
        return {
          ...base,
          outcome: 'settled',
          logsMatched: true,
          readBackTries: tries,
          note: `The receipt carries the expected event. The vault could not be read back at block ${rc.block} on any RPC, so this rests on the receipt alone.`,
        }
      return {
        ...base,
        outcome: 'pending',
        logsMatched: true,
        readBackTries: tries,
        note: 'The receipt carries the expected event; reading the vault back at its block before calling it settled.',
      }
    }
    if (record.expiry !== undefined && r.sessionKeyExpiry !== record.expiry)
      return {
        ...base,
        outcome: 'unexpected',
        logsMatched: true,
        note: `The event is there, but at block ${r.block} sessionKeyExpiry reads ${r.sessionKeyExpiry}, not ${record.expiry}.`,
      }
    if (record.amount !== undefined && r.balance < record.amount)
      return {
        ...base,
        outcome: 'unexpected',
        logsMatched: true,
        note: `The transfer is there, but at block ${r.block} the vault's balance reads ${r.balance} units, under the ${record.amount} sent.`,
      }
  }
  return { ...base, outcome: 'settled', logsMatched: true, note: undefined }
}

// --- no receipt on any host ---

/** How long this hash's used nonce is watched, with no receipt for the hash, before it counts as replaced. */
export const REPLACED_AFTER_MS = 20_000

/** What one check found while no host had a receipt. Every field is optional: a check reads only some. */
export type Unseen = {
  now: number
  /** The transaction itself, when a host returned it on this check. */
  tx?: { maxFeePerGas: bigint | null; gasPrice: bigint | null; nonce: number; from: string } | null
  /** The sender's mined nonce ('latest'), when read on this check. */
  latestNonce?: number | null
  /** A deploy: what the address its nonce creates reads back as, when read on this check. */
  createdAt?: { address: string; back: DeployBack } | null
}

/** The nonce whose use tells this hash was replaced: the one the chain says this hash carries, never a guess. */
export function watchedNonce(r: TxRecord): number | undefined {
  return r.sent?.nonce
}

/** The nonce a deploy's address comes from: the one the chain says it carries, else the one read when it was prepared. */
export function deployNonce(r: TxRecord): number | undefined {
  return r.sent?.nonce ?? r.nonce
}

/** One check of a transaction no host has a receipt for. Pending unless the facts make it final. */
export function decideUnseen(record: TxRecord, f: Unseen): TxRecord {
  let next = record
  if (f.tx) {
    const fee = f.tx.maxFeePerGas ?? f.tx.gasPrice
    next = {
      ...next,
      sent: { maxFeePerGas: f.tx.maxFeePerGas, gasPrice: f.tx.gasPrice, nonce: f.tx.nonce, belowFloor: fee !== null && fee < FEE_FLOOR_WEI, from: f.tx.from },
    }
  }

  // A vault reading back exactly as asked at the address this nonce creates IS the setup's
  // vault, whichever hash created it: a wallet's speed-up keeps the nonce, so it keeps the address.
  if (record.action === 'deploy' && f.createdAt && f.createdAt.back.status === 'ok')
    return {
      ...next,
      outcome: 'replaced',
      vault: f.createdAt.address,
      contractAddress: f.createdAt.address,
      nonceUsedAt: undefined,
      note: 'No RPC has a receipt for this hash, but a vault that reads back exactly as asked now exists at the address this nonce creates: your wallet sent a replacement (a speed-up) that landed.',
    }

  // Only the nonce the chain says this hash carries can show it was replaced. A nonce the page
  // read while preparing may have gone to another transaction the wallet had queued first.
  const nonce = watchedNonce(next)
  const used = nonce !== undefined && typeof f.latestNonce === 'number' && f.latestNonce > nonce
  if (used && !next.nonceUsedAt)
    return {
      ...next,
      nonceUsedAt: new Date(f.now).toISOString(),
      note: "This transaction's nonce has been used, but no RPC has a receipt for this hash. If your wallet sped it up or cancelled it, the replacement is what landed. Watching a few more seconds before calling it replaced. Do not sign it again.",
    }

  if (next.nonceUsedAt && f.now - Date.parse(next.nonceUsedAt) >= REPLACED_AFTER_MS) {
    if (record.action !== 'deploy')
      return {
        ...next,
        outcome: 'replaced',
        note: "Its nonce was used by another transaction (a speed-up or a cancel in your wallet) and no RPC has a receipt for this hash, so this hash can no longer land. The vault's state, read again, shows what happened. Check your wallet's activity before signing anything again.",
      }
    // A deploy is final only once the address its nonce creates has actually been read.
    const at = f.createdAt
    if (at && (at.back.status === 'no_code' || at.back.status === 'mismatch'))
      return {
        ...next,
        outcome: 'replaced',
        note: `Its nonce was used by another transaction, and ${at.address}, the address that nonce creates, ${
          at.back.status === 'no_code' ? 'holds no contract' : `does not read back as asked (${at.back.why ?? 'its values differ'})`
        }. No vault came out of this hash. Check your wallet's activity before deploying again.`,
      }
  }
  return next
}

/** The person stopped tracking a transaction no RPC has a receipt for. It may still land. */
export function untracked(r: TxRecord): TxRecord {
  return {
    ...r,
    outcome: 'untracked',
    note: "You stopped tracking this transaction with no receipt seen on any RPC. If it is still in your wallet's queue it can land later: check your wallet's activity and the explorer before signing anything again.",
  }
}

/** Track an untracked transaction again, from where it was. */
export function retracked(r: TxRecord): TxRecord {
  return { ...r, outcome: 'pending', note: undefined, nonceUsedAt: undefined }
}

// --- the vault setup ---

export type SetupStep = 'form' | 'review' | 'sending' | 'deploying' | 'deploy-failed' | 'expiry' | 'expiry-pending' | 'fund' | 'fund-pending' | 'done'

/** The snapshot, only when it is of this setup's vault on this setup's network. */
function liveOf(s: SetupState, snapshot: VaultSnapshot | null): VaultSnapshot | null {
  return snapshot && s.vault && sameAddress(snapshot.address, s.vault) && snapshot.network === s.network ? snapshot : null
}

/** The expiry is set: the live vault says so, or a settled write did and no later read says otherwise. */
export function expirySet(s: SetupState, snapshot: VaultSnapshot | null): boolean {
  const live = liveOf(s, snapshot)
  const tx = s.expiryTx
  const settled = tx?.outcome === 'settled'
  if (!live) return settled
  if (live.sessionKeyExpiry !== 0n) return true
  // A read from before the write's own block cannot overrule its receipt and read-back.
  return settled && tx?.block !== undefined && live.block < tx.block
}

/** A funding whose receipt carried the exact USDC Transfer: done, whatever a later balance reads. */
export function fundingLanded(r: TxRecord | undefined): boolean {
  return Boolean(r && (r.outcome === 'settled' || (r.outcome === 'unexpected' && r.logsMatched === true)))
}

/**
 * A funding that left for a wallet and whose fate this page cannot see: replaced by another
 * transaction or no longer tracked. A second funding is offered only after the person confirms.
 */
export function fundingUnresolved(r: TxRecord | undefined): boolean {
  return Boolean(r && (r.outcome === 'replaced' || r.outcome === 'untracked'))
}

/**
 * Where the setup stands. The order is the promise: deploy, then bound the key in time, then
 * fund, and nothing is offered out of that order. The live vault, once read, wins over a record
 * that is only pending, so a dropped transaction cannot hold the setup where it is.
 */
export function setupStep(s: SetupState | null, prepared: boolean, snapshot: VaultSnapshot | null): SetupStep {
  if (!s) return prepared ? 'review' : 'form'
  if (!s.vault) {
    if (!s.deploy) return s.intent ? 'sending' : prepared ? 'review' : 'form'
    if (s.deploy.outcome === 'pending') return 'deploying'
    return 'deploy-failed'
  }
  if (!expirySet(s, snapshot)) return s.expiryTx?.outcome === 'pending' ? 'expiry-pending' : 'expiry'
  if (s.funding <= 0n || s.fundSkipped) return 'done'
  const live = liveOf(s, snapshot)
  if (fundingLanded(s.fundTx) || (live !== null && live.balance >= s.funding)) return 'done'
  if (s.fundTx?.outcome === 'pending') return 'fund-pending'
  return 'fund'
}

/** A record written into the setup; a deploy that settled or was replaced into a vault names the vault. */
export function withRecord(s: SetupState, field: 'deploy' | 'expiryTx' | 'fundTx', r: TxRecord): SetupState {
  const next: SetupState = { ...s, [field]: r }
  if (field === 'deploy' && r.vault && (r.outcome === 'settled' || r.outcome === 'replaced')) next.vault = r.vault
  return next
}

/** The address a deploy from this setup would create, when it is known: where to look before deploying again. */
export function predictedVault(s: SetupState): string | null {
  return s.vault ?? s.deploy?.predicted ?? s.intent?.predicted ?? null
}

/**
 * What the vault page must warn about for a setup this browser holds, or null:
 *   - 'sending': the wallet was asked to deploy and no hash ever came back,
 *   - 'deploying': the deploy has a hash and no receipt yet,
 *   - 'untracked': the person stopped tracking the deploy, which can still land,
 *   - 'unbounded': the vault exists and no expiry has been seen to land.
 * A deploy that reverted, or whose nonce went to another transaction, made no vault: no alert.
 */
export function setupAlert(s: SetupState | null, snapshot: VaultSnapshot | null): 'sending' | 'deploying' | 'untracked' | 'unbounded' | null {
  if (!s) return null
  if (!s.vault) {
    if (!s.deploy) return s.intent ? 'sending' : null
    if (s.deploy.outcome === 'pending') return 'deploying'
    return s.deploy.outcome === 'untracked' ? 'untracked' : null
  }
  return expirySet(s, snapshot) ? null : 'unbounded'
}

/**
 * Where a deploy with no vault yet may still create one, and what that vault must read back as:
 * the wallet was asked and no hash came back, or the person stopped tracking the hash. Null when
 * there is nothing to look for (no deploy in flight, or one that is final without a vault).
 */
export function vaultToLookFor(s: SetupState | null): { predicted: string; deployArgs: NonNullable<TxRecord['deployArgs']> } | null {
  if (!s || s.vault) return null
  if (!s.deploy) return s.intent ? { predicted: s.intent.predicted, deployArgs: s.intent.deployArgs } : null
  if (s.deploy.outcome !== 'untracked') return null
  const predicted = s.deploy.predicted ?? s.intent?.predicted
  const deployArgs = s.deploy.deployArgs ?? s.intent?.deployArgs
  return predicted && deployArgs ? { predicted, deployArgs } : null
}
