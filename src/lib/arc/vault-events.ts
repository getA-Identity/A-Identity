/**
 * A vault's recent events, read live from the registry's Arc RPCs with no wallet and no backend.
 * The rules (the windows, the union of hosts, what may be said about the range) are in
 * event-history.ts; this file gives them real hosts. Runtime imports are named with their .ts
 * extension, so the suite in mcp/src loads this file straight from src/.
 */
import { BaseError, getAbiItem, getAddress } from 'viem'
import type { Chain } from '../chains'
import { AGENT_SPEND_POLICY_ABI } from '../contracts/agent-spend-policy.ts'
import {
  WINDOW_PAUSE_MS,
  emptyHistory,
  covered,
  pickHosts,
  readDownTo,
  readOlder,
  withBlockTimes,
  type EventHistory,
  type HostHead,
  type HostReader,
} from './event-history.ts'
import type { PaidEvent } from './handoff-rules'
import { clientFor, hostOf, rpcUrls } from './vault-read.ts'

/** The three events, named by the generated ABI, so a contract that renamed one fails the build. */
const VAULT_EVENTS = [
  getAbiItem({ abi: AGENT_SPEND_POLICY_ABI, name: 'Paid' }),
  getAbiItem({ abi: AGENT_SPEND_POLICY_ABI, name: 'FrozenSet' }),
  getAbiItem({ abi: AGENT_SPEND_POLICY_ABI, name: 'Withdrawn' }),
]

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, WINDOW_PAUSE_MS))

function readerFor(chain: Chain, url: string, vault: `0x${string}`): HostReader {
  const client = clientFor(chain, url)
  return {
    host: hostOf(url),
    logs: async (from, to) => {
      const logs = await client.getLogs({ address: vault, events: VAULT_EVENTS, fromBlock: from, toBlock: to })
      return logs.map((l) => ({
        address: l.address,
        eventName: l.eventName,
        args: l.args as Record<string, unknown>,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        removed: l.removed,
      }))
    },
    blockTime: async (block) => (await client.getBlock({ blockNumber: block })).timestamp,
  }
}

/** Every host's chain id and head, once, at the start of a read. */
async function readHeads(chain: Chain): Promise<HostHead[]> {
  return Promise.all(
    rpcUrls(chain).map(async (url): Promise<HostHead> => {
      const client = clientFor(chain, url)
      try {
        const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })])
        return { host: hostOf(url), chainId, block }
      } catch (e) {
        return { host: hostOf(url), chainId: null, block: null, reason: e instanceof BaseError ? e.shortMessage : String(e) }
      }
    }),
  )
}

const paidOf = (h: EventHistory): PaidEvent[] => h.events.flatMap((e) => (e.kind === 'Paid' ? [{ to: e.to, amount: e.amount, byOwner: e.byOwner, block: e.block, txHash: e.txHash }] : []))

/**
 * The vault's Paid events from `from` up to the chain's head, as far down as the read got. The range is
 * contiguous from the head, and `from` in the answer is where it really starts: a window no host answered
 * is not "no payment", so whoever asks has to compare that with the block they need, and `short` says why
 * it stopped. A check inside the range is answered, and one below it is not. Nothing was read at all: a
 * failure. `onProgress` gets what is known so far, so a fresh flow does not wait for an old one's read.
 */
export async function readPaidSince(
  chain: Chain,
  vault: string,
  from: bigint,
  o: { onProgress?: (read: { from: bigint; through: bigint; paid: PaidEvent[] }) => void } = {},
): Promise<{ ok: true; paid: PaidEvent[]; from: bigint; through: bigint; short: string | null } | { ok: false; reason: string }> {
  const address = getAddress(vault)
  const picked = pickHosts(await readHeads(chain), chain.chainId as number)
  if (picked.top === null) return { ok: false, reason: 'no network node answered for this chain' }
  if (picked.top < from) return { ok: true, paid: [], from, through: picked.top, short: null }
  const urls = rpcUrls(chain).filter((u) => picked.usable.includes(hostOf(u)))
  const h = await readDownTo(emptyHistory(address, picked.top), from, {
    readers: urls.map((u) => readerFor(chain, u, address)),
    pause,
    onProgress: (now) => {
      const range = covered(now)
      if (range) o.onProgress?.({ from: range.from, through: range.to, paid: paidOf(now) })
    },
  })
  const range = covered(h)
  if (!range) return { ok: false, reason: h.failed?.reason ?? 'no window could be read' }
  const short = h.failed?.reason ?? (range.from > from ? 'the read stopped before it reached the block it needed' : null)
  return { ok: true, paid: paidOf(h), from: range.from, through: range.to, short }
}

/**
 * Read a vault's events: from the newest block down, or, with `older`, on below what that read
 * covered. Never rejects: a read that got nowhere comes back saying so.
 */
export async function readVaultEvents(
  chain: Chain,
  vault: string,
  opts: { older?: EventHistory; aborted?: () => boolean; onProgress?: (h: EventHistory) => void } = {},
): Promise<EventHistory> {
  const address = getAddress(vault)
  const picked = pickHosts(await readHeads(chain), chain.chainId as number)
  const urls = rpcUrls(chain).filter((u) => picked.usable.includes(hostOf(u)))
  if (picked.top === null) {
    const base = opts.older ?? emptyHistory(address, null)
    return { ...base, skipped: picked.skipped, failed: { range: null, reason: 'no RPC answered for this chain' } }
  }
  const readers = urls.map((u) => readerFor(chain, u, address))
  // A history with no window read has no range to continue below, so the read starts at the newest block.
  const base: EventHistory = { ...(opts.older?.windows.length ? opts.older : emptyHistory(address, picked.top)), skipped: picked.skipped }
  const read = await readOlder(base, { readers, pause, aborted: opts.aborted, onProgress: opts.onProgress })
  return withBlockTimes(read, { readers, pause, aborted: opts.aborted })
}
