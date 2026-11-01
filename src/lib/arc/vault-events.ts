/**
 * A vault's recent events, read live from the registry's Arc RPCs with no wallet and no backend.
 * The rules (the windows, the union of hosts, what may be said about the range) are in
 * event-history.ts; this file gives them real hosts.
 */
import { BaseError, getAbiItem, getAddress } from 'viem'
import type { Chain } from '../chains'
import { AGENT_SPEND_POLICY_ABI } from '../contracts/agent-spend-policy'
import {
  WINDOW_PAUSE_MS,
  emptyHistory,
  pickHosts,
  readOlder,
  withBlockTimes,
  type EventHistory,
  type HostHead,
  type HostReader,
} from './event-history'
import { clientFor, hostOf, rpcUrls } from './vault-read'

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
