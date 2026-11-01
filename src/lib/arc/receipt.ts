/**
 * What a submitted transaction became, decided from the chain alone.
 *
 * Settled means all of: a receipt with status success, every event the write was expected to
 * emit (decoded from the vault's or the USDC contract's own logs), and for the writes whose
 * effect can be read back (a deploy, a session key, a funding) the read-back agreeing. A
 * receipt without the expected event is shown as landed-but-not-as-expected and never counted.
 *
 * While no host has a receipt, the transaction is pending, and that is all it is: one host's
 * null decides nothing on Arc. Every few checks the transaction itself is read, to show the fee
 * the wallet really sent (a maxFeePerGas under 20 gwei is dropped by Arc without a receipt) and
 * to notice its nonce being used by another hash, which means the wallet replaced it.
 */
import { getAddress, getContractAddress, isAddress, type Hex } from 'viem'
import type { Chain } from '../chains'
import type { TxRecord } from './pending'
import { missingFromReceipt, pollReceipt, readNonce, readTransaction, readVault } from './vault-read'
import { FEE_FLOOR_WEI, sameAddress } from './vault-rules'

/** How often a pending transaction is asked about, and for how long before the page stops asking on its own. */
export const POLL_FAST_MS = 1500
export const POLL_SLOW_MS = 5000
export const FAST_FOR_MS = 30_000
export const POLL_FOR_MS = 3 * 60_000
/** Every this many checks, the transaction and its nonce are read as well as the receipt. */
const DEEP_EVERY = 6

export type Advance = { record: TxRecord; answered: number; total: number }

/** Why a deployed vault does not read back as the setup asked, or null when it does. */
async function deployReadback(chain: Chain, address: string, args: NonNullable<TxRecord['deployArgs']>): Promise<{ ok: boolean; why: string | null; retry: boolean }> {
  const r = await readVault(chain, address)
  if (!r.ok) return { ok: false, why: r.failure.reason, retry: r.failure.kind === 'unreachable' || r.failure.kind === 'no_contract' }
  const v = r.data
  const wrong: string[] = []
  if (!v.knownBuild) wrong.push('its code is not the build this page deploys')
  if (!sameAddress(v.owner, args.owner)) wrong.push(`owner reads ${v.owner}`)
  if (!sameAddress(v.operator, args.operator)) wrong.push(`operator reads ${v.operator}`)
  if (!sameAddress(v.usdc, args.usdc)) wrong.push(`usdc reads ${v.usdc}`)
  if (v.dailyCap !== args.dailyCap) wrong.push(`dailyCap reads ${v.dailyCap}`)
  if (v.autoApproveMax !== args.autoApproveMax) wrong.push(`autoApproveMax reads ${v.autoApproveMax}`)
  return wrong.length ? { ok: false, why: wrong.join('; '), retry: false } : { ok: true, why: null, retry: false }
}

/** One check of a pending transaction. Returns the record unchanged (but for notes) while nothing is known. */
export async function advance(chain: Chain, record: TxRecord, tick: number): Promise<Advance> {
  const poll = await pollReceipt(chain, record.hash)
  if (poll.found) {
    const rc = poll.receipt
    const base: TxRecord = {
      ...record,
      block: rc.blockNumber,
      feeWei: rc.gasUsed * (rc.effectiveGasPrice ?? 0n),
      host: poll.host,
    }
    if (rc.status !== 'success') return { record: { ...base, outcome: 'reverted', note: undefined }, answered: poll.answered, total: poll.total }

    if (record.action === 'deploy') {
      const created = rc.contractAddress && isAddress(rc.contractAddress) ? getAddress(rc.contractAddress) : null
      if (!created) return { record: { ...base, outcome: 'unexpected', note: 'The receipt names no contract address, so no vault was created.' }, answered: poll.answered, total: poll.total }
      if (!record.deployArgs) return { record: { ...base, outcome: 'unexpected', contractAddress: created, note: 'This page lost what the vault was meant to read back as.' }, answered: poll.answered, total: poll.total }
      const back = await deployReadback(chain, created, record.deployArgs)
      if (back.retry)
        return { record: { ...base, contractAddress: created, outcome: 'pending', note: 'The receipt is in; reading the new vault back before calling it deployed.' }, answered: poll.answered, total: poll.total }
      if (!back.ok)
        return { record: { ...base, contractAddress: created, vault: created, outcome: 'unexpected', note: `A contract was created but it does not read back as asked: ${back.why}.` }, answered: poll.answered, total: poll.total }
      return { record: { ...base, contractAddress: created, vault: created, outcome: 'settled', note: undefined }, answered: poll.answered, total: poll.total }
    }

    const missing = missingFromReceipt(rc, record.expect)
    if (missing.length)
      return { record: { ...base, outcome: 'unexpected', note: `It landed, but the receipt does not carry ${missing.join(', or ')}.` }, answered: poll.answered, total: poll.total }

    if ((record.action === 'expiry' || record.action === 'extend' || record.action === 'revoke' || record.action === 'fund') && record.vault) {
      const r = await readVault(chain, record.vault)
      if (!r.ok)
        return { record: { ...base, outcome: 'pending', note: 'The receipt carries the expected event; reading the vault back before calling it settled.' }, answered: poll.answered, total: poll.total }
      if (record.expiry !== undefined && r.data.sessionKeyExpiry !== record.expiry)
        return { record: { ...base, outcome: 'unexpected', note: `The event is there, but sessionKeyExpiry now reads ${r.data.sessionKeyExpiry}, not ${record.expiry}.` }, answered: poll.answered, total: poll.total }
      if (record.amount !== undefined && r.data.balance < record.amount)
        return { record: { ...base, outcome: 'unexpected', note: `The transfer is there, but the vault's balance reads ${r.data.balance} units, under the ${record.amount} sent.` }, answered: poll.answered, total: poll.total }
    }
    return { record: { ...base, outcome: 'settled', note: undefined }, answered: poll.answered, total: poll.total }
  }

  // Nothing yet. Every few checks, look at the transaction itself.
  let next: TxRecord = record
  // Until the transaction itself has been seen, read it on every early check: the fee the
  // wallet really sent is worth knowing in seconds, not after the next deep check.
  if (tick % DEEP_EVERY === 0 || (!record.sent && tick < 10)) {
    const sent = await readTransaction(chain, record.hash as Hex)
    if (sent) {
      const fee = sent.maxFeePerGas ?? sent.gasPrice
      next = {
        ...next,
        sent: {
          maxFeePerGas: sent.maxFeePerGas,
          gasPrice: sent.gasPrice,
          nonce: sent.nonce,
          belowFloor: fee !== null && fee < FEE_FLOOR_WEI,
          from: sent.from,
        },
      }
    }
    const nonce = next.sent?.nonce
    if (nonce !== undefined) {
      const mined = await readNonce(chain, record.from, 'latest')
      if (mined !== null && mined > nonce) {
        // That nonce is used. Either this hash landed and no host will show its receipt yet,
        // or the wallet replaced it. A deploy can tell which: its address survives a speed-up.
        if (record.action === 'deploy' && record.deployArgs) {
          const at = getContractAddress({ from: getAddress(record.from), nonce: BigInt(nonce) })
          const back = await deployReadback(chain, at, record.deployArgs)
          if (back.ok)
            return {
              record: {
                ...next,
                outcome: 'replaced',
                vault: at,
                contractAddress: at,
                note: 'No host has a receipt for this hash, but a vault that reads back exactly as asked now exists at the address this nonce creates: your wallet sent a replacement (a speed-up) that landed.',
              },
              answered: poll.answered,
              total: poll.total,
            }
        }
        next = {
          ...next,
          note: 'This transaction\'s nonce has been used, but no host has a receipt for this hash yet. If your wallet sped it up or cancelled it, the replacement is what landed: check your wallet\'s activity and the explorer. Do not sign it again.',
        }
      }
    }
  }
  return { record: next, answered: poll.answered, total: poll.total }
}

/** The transaction fee in USDC wei as a short decimal, for a receipt line. */
export function feeLine(wei: bigint | undefined, decimals: number): string | null {
  if (wei === undefined) return null
  const s = wei.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '').slice(0, 6)
  return `${whole}${frac ? `.${frac}` : ''} USDC`
}
