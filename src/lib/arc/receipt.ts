/**
 * What a submitted transaction became, read from the chain and decided by tx-rules.ts.
 *
 * Settled means all of: a receipt with status success, every event the write was expected to
 * emit (decoded from the vault's or the USDC contract's own logs), and for the writes whose
 * effect can be read back (a deploy, a session key, a funding) the read-back agreeing, read at
 * the receipt's own block. A receipt without the expected event is shown as
 * landed-but-not-as-expected and never counted.
 *
 * While no host has a receipt, the transaction is pending, and that is all it is: one host's
 * null decides nothing on Arc. Every few checks the transaction itself is read, to show the fee
 * the wallet really sent (a maxFeePerGas under 20 gwei is dropped by Arc without a receipt) and
 * to notice its nonce being used by another hash. That, watched for a few seconds more with
 * still no receipt for this hash, is final: the hash was replaced and can no longer land.
 *
 * A transaction Arc dropped under its floor never shows up in that read, so neither its fee nor
 * its nonce can be read back. For that case decideUnseen says so after 30 seconds, and the nonce
 * read while preparing stands in for the one the chain would have named.
 */
import { getAddress, getContractAddress, isAddress, type Hex } from 'viem'
import type { Chain } from '../chains'
import type { DeployArgs, TxRecord } from './pending'
import { READ_BACK_TRIES, decideLanded, decideUnseen, deployNonce, guessedNonce, needsReadBack, type DeployBack, type ReadBack, type Unseen } from './tx-rules'
import { missingFromReceipt, pollReceipt, readNonce, readTransaction, readVault } from './vault-read'
import { sameAddress } from './vault-rules'

/** How often a pending transaction is asked about, and for how long before the page stops asking on its own. */
export const POLL_FAST_MS = 1500
export const POLL_SLOW_MS = 5000
export const FAST_FOR_MS = 30_000
export const POLL_FOR_MS = 3 * 60_000
/** Every this many checks, the transaction and its nonce are read as well as the receipt. */
const DEEP_EVERY = 6

export type Advance = { record: TxRecord; answered: number; total: number }

/**
 * What a deployed vault reads back as against what the setup asked, at `blockNumber` when given
 * (the receipt's block) or at the latest block.
 */
export async function deployReadback(chain: Chain, address: string, args: DeployArgs, at: { blockNumber?: bigint; preferHost?: string } = {}): Promise<DeployBack> {
  const r = await readVault(chain, address, at)
  if (!r.ok) return { status: r.failure.kind === 'no_contract' ? 'no_code' : r.failure.kind === 'not_a_vault' ? 'mismatch' : 'unreadable', why: r.failure.reason }
  const v = r.data
  const wrong: string[] = []
  if (!v.knownBuild) wrong.push('its code is not the build this page deploys')
  if (!sameAddress(v.owner, args.owner)) wrong.push(`owner reads ${v.owner}`)
  if (!sameAddress(v.operator, args.operator)) wrong.push(`operator reads ${v.operator}`)
  if (!sameAddress(v.usdc, args.usdc)) wrong.push(`usdc reads ${v.usdc}`)
  if (v.dailyCap !== args.dailyCap) wrong.push(`dailyCap reads ${v.dailyCap}`)
  if (v.autoApproveMax !== args.autoApproveMax) wrong.push(`autoApproveMax reads ${v.autoApproveMax}`)
  return wrong.length ? { status: 'mismatch', why: wrong.join('; ') } : { status: 'ok', why: null }
}

/** The vault's expiry and balance at the receipt's block, asked first of the host that returned the receipt. */
async function readBackAt(chain: Chain, vault: string, blockNumber: bigint, host: string): Promise<ReadBack> {
  const r = await readVault(chain, vault, { blockNumber, preferHost: host })
  return r.ok ? { ok: true, block: r.data.block, sessionKeyExpiry: r.data.sessionKeyExpiry, balance: r.data.balance } : { ok: false, reason: r.failure.reason }
}

/** One check of a pending transaction. Returns the record unchanged (but for notes) while nothing is known. */
export async function advance(chain: Chain, record: TxRecord, tick: number, now: number = Date.now()): Promise<Advance> {
  const poll = await pollReceipt(chain, record.hash)
  if (poll.found) {
    const rc = poll.receipt
    const created = rc.contractAddress && isAddress(rc.contractAddress) ? getAddress(rc.contractAddress) : null
    const landed = { success: rc.status === 'success', block: rc.blockNumber, feeWei: rc.gasUsed * (rc.effectiveGasPrice ?? 0n), host: poll.host, contractAddress: created }
    const facts: Parameters<typeof decideLanded>[2] = {}
    if (landed.success && record.action === 'deploy') {
      // At the receipt's block first; once that has failed READ_BACK_TRIES times (a host that
      // no longer serves state that old), at the latest block.
      if (created && record.deployArgs)
        facts.deploy = await deployReadback(
          chain,
          created,
          record.deployArgs,
          (record.readBackTries ?? 0) < READ_BACK_TRIES ? { blockNumber: rc.blockNumber, preferHost: poll.host } : {},
        )
    } else if (landed.success) {
      facts.missing = missingFromReceipt(rc, record.expect)
      if (!facts.missing.length && needsReadBack(record) && record.vault) facts.readBack = await readBackAt(chain, record.vault, rc.blockNumber, poll.host)
    }
    return { record: decideLanded(record, landed, facts), answered: poll.answered, total: poll.total }
  }

  // No receipt on any host. Every few checks, look at the transaction itself and its nonce; once
  // the nonce is seen used, on every check, so the watch before 'replaced' is a matter of seconds.
  const f: Unseen = { now }
  const watching = Boolean(record.nonceUsedAt)
  if (watching || tick % DEEP_EVERY === 0 || (!record.sent && tick < 10)) {
    f.tx = await readTransaction(chain, record.hash as Hex)
    const nonce = f.tx?.nonce ?? record.sent?.nonce ?? guessedNonce(record)
    // A hash first seen during a watch that began on a guess: its real nonce needs reading now.
    if (nonce !== undefined && (!watching || (f.tx && !record.sent))) f.latestNonce = await readNonce(chain, record.from, 'latest')
    // A deploy: the address its nonce creates, read once that nonce is used. A speed-up keeps the
    // nonce, so it keeps the address. With no transaction seen yet, the nonce read while preparing
    // is tried too: only a vault that reads back exactly as asked counts.
    const dn = f.tx?.nonce ?? deployNonce(record)
    if (record.action === 'deploy' && record.deployArgs && dn !== undefined) {
      const mined = typeof f.latestNonce === 'number' ? f.latestNonce : watching ? Number.MAX_SAFE_INTEGER : await readNonce(chain, record.from, 'latest')
      if (mined !== null && mined > dn) {
        const address = getContractAddress({ from: getAddress(record.from), nonce: BigInt(dn) })
        f.createdAt = { address, back: await deployReadback(chain, address, record.deployArgs) }
      }
    }
  }
  return { record: decideUnseen(record, f), answered: poll.answered, total: poll.total }
}

/** The transaction fee in USDC wei as a short decimal, for a receipt line. */
export function feeLine(wei: bigint | undefined, decimals: number): string | null {
  if (wei === undefined) return null
  const s = wei.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '').slice(0, 6)
  return `${whole}${frac ? `.${frac}` : ''} USDC`
}
