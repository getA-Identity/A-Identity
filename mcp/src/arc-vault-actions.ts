/**
 * What an owner did to a counted vault, read from the chain: Milestone 1 asks for a freeze and a
 * withdrawal signed by an owner wallet, with public hashes.
 *
 * For each vault it reads the FrozenSet and Withdrawn logs at that address from the deploy block
 * on (eth_getLogs with the address filter, at most 10,000 blocks per query, which is what the Arc
 * hosts allow: on 2026-11-02 rpc.mainnet and QuickNode refused a wider range and dRPC refused
 * every range we tried). Then it keeps a log only when its transaction's from is the vault's owner,
 * read from every host, because a null from one host is not an answer. The contract lets only the
 * owner call either function, so a log from another sender means the owner is a contract and some
 * other wallet signed: that is not an owner wallet's signature, and it is not published.
 *
 *   - A freeze is FrozenSet(true). Unfreezing is not a freeze.
 *   - A withdrawal is Withdrawn with an amount above 0. The contract also emits it for 0.
 *
 * Arc makes two blocks a second, so a vault a few days old is dozens of queries, and the public
 * hosts rate-limit a burst of them. A report request must stay fast, so the reader keeps what it
 * has read in memory and only ever reads forward: a request starts a refresh when the last one is
 * stale, waits a moment for it, and answers with what is known. The refresh goes on behind the
 * request, and the answer says how far it got. A host that fails hands over to the next, which
 * then stays first. If no host answers a window, the scan stops there, says so, and resumes from
 * that block next time; it never skips a window. A restart loses the cache and reads again.
 *
 * Nothing here is a count of anything but hashes it verified: an action whose sender could not be
 * read stays unpublished and is named as unread, and it is asked again on the next refresh.
 */
import { decodeAbiParameters, toEventSelector, toHex, type AbiEvent, type Hex } from 'viem'
import { agreeAcrossHosts, ADMISSION_CHAIN, type RpcReceipt, type RpcTransaction } from './arc-owner-vault.js'
import { everyHost, liveRpcHosts, shortRpcError, type RpcHost } from './arc-owner-vault-live.js'
import { getChainById } from './chains/registry.js'
import { AgentSpendPolicyAbi } from './contracts/AgentSpendPolicy.js'

const eventTopic = (name: string): Hex => toEventSelector((AgentSpendPolicyAbi as unknown as readonly AbiEvent[]).find((e) => e.type === 'event' && e.name === name) as AbiEvent)

export const FROZEN_SET_TOPIC = eventTopic('FrozenSet')
export const WITHDRAWN_TOPIC = eventTopic('Withdrawn')

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export type ActionVault = { address: string; owner: string; deployTx: string; deployBlock?: string }
export type ActionTx = { txHash: string; block: string }
export type ActionsReadState = {
  /** complete: every block up to scannedToBlock read, and every action found checked. reading: not there yet. unreadable: a read failed, said in reason. */
  state: 'complete' | 'reading' | 'unreadable'
  scannedToBlock: string | null
  reason?: string
}
export type VaultOwnerActions = { freezeTxs: ActionTx[]; withdrawTxs: ActionTx[]; read: ActionsReadState }

type RpcLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; removed?: boolean }
type Kind = 'freeze' | 'withdraw'

/** Which owner action a log is, or null when it is not one. */
export function actionOfLog(log: RpcLog, vault: string): Kind | null {
  if (log.removed || !same(log.address, vault)) return null
  try {
    if (log.topics?.[0] === FROZEN_SET_TOPIC) {
      const [frozen] = decodeAbiParameters([{ type: 'bool' }], log.data as Hex)
      return frozen ? 'freeze' : null
    }
    if (log.topics?.[0] === WITHDRAWN_TOPIC) {
      const [amount] = decodeAbiParameters([{ type: 'uint256' }], log.data as Hex)
      return amount > 0n ? 'withdraw' : null
    }
  } catch {
    return null
  }
  return null
}

type Cursor = {
  vault: ActionVault
  next: bigint | null
  /** The last block this vault's scan was asked to reach. */
  target: bigint | null
  freeze: Map<string, ActionTx>
  withdraw: Map<string, ActionTx>
  /** Actions found whose sender has not been read yet. */
  pending: Map<string, { kind: Kind; block: string }[]>
  error: string | null
}

export type OwnerActionReaderOptions = {
  hosts: readonly RpcHost[]
  now?: () => number
  /** How old a finished refresh may be before a request starts another. */
  ttlMs?: number
  /** How long a request waits for a refresh before answering with what is known. */
  waitMs?: number
  /** Blocks per eth_getLogs query, the block range counted inclusively. At most 10,000. */
  windowBlocks?: bigint
  /** Stops this far behind the head, so a host a little behind another cannot answer empty for blocks it has not seen. */
  lagBlocks?: bigint
}

export function createOwnerActionReader(opts: OwnerActionReaderOptions) {
  const { hosts } = opts
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? 30_000
  const waitMs = opts.waitMs ?? 2_500
  const windowBlocks = opts.windowBlocks ?? 10_000n
  const lagBlocks = opts.lagBlocks ?? 20n
  const cursors = new Map<string, Cursor>()
  let inFlight: Promise<void> | null = null
  let lastDone = -Infinity
  let lastHeadError: string | null = null
  let preferred = 0
  const tried = new Set<string>()

  /** The first host that answers, starting from the one that last did. Null and the reason when none does. */
  async function firstAnswer<T>(method: string, params: readonly unknown[]): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const problems: string[] = []
    for (let i = 0; i < hosts.length; i++) {
      const at = (preferred + i) % hosts.length
      const h = hosts[at]
      try {
        const value = (await h.request(method, params)) as T
        if (value === null || value === undefined) {
          problems.push(`${h.label}: no answer`)
          continue
        }
        preferred = at
        return { ok: true, value }
      } catch (e) {
        problems.push(`${h.label}: ${shortRpcError(e, hosts)}`)
      }
    }
    return { ok: false, reason: problems.join('; ') || 'no host is configured' }
  }

  async function deployBlockOf(c: Cursor): Promise<bigint | null> {
    if (c.vault.deployBlock && /^\d+$/.test(c.vault.deployBlock)) return BigInt(c.vault.deployBlock)
    const answers = await everyHost<RpcReceipt>(hosts, 'eth_getTransactionReceipt', [c.vault.deployTx])
    const receipt = agreeAcrossHosts(answers, (r) => `${r.blockHash} ${r.contractAddress}`.toLowerCase())
    if (receipt.conflict || !receipt.value) {
      c.error = receipt.conflict ? `the hosts disagree about the deploy receipt: ${receipt.conflict}` : "no host returned the vault's deploy receipt"
      return null
    }
    return BigInt(receipt.value.blockNumber)
  }

  /** Publish each pending action whose sender is the owner, drop it when the sender is anyone else, and keep it when no host could say. */
  async function settlePending(c: Cursor): Promise<void> {
    for (const [hash, actions] of [...c.pending]) {
      const answers = await everyHost<RpcTransaction>(hosts, 'eth_getTransactionByHash', [hash])
      const tx = agreeAcrossHosts(answers, (t) => `from ${t.from}`.toLowerCase())
      if (tx.conflict || !tx.value) continue
      c.pending.delete(hash)
      if (!same(tx.value.from, c.vault.owner)) continue
      for (const a of actions) (a.kind === 'freeze' ? c.freeze : c.withdraw).set(hash, { txHash: hash, block: a.block })
    }
  }

  async function scanVault(c: Cursor, target: bigint): Promise<void> {
    c.error = null
    c.target = target
    if (c.next === null) {
      c.next = await deployBlockOf(c)
      if (c.next === null) return
    }
    let from: bigint = c.next
    while (from <= target) {
      const end = from + windowBlocks - 1n
      const to = end < target ? end : target
      const logs = await firstAnswer<RpcLog[]>('eth_getLogs', [
        { address: c.vault.address, fromBlock: toHex(from), toBlock: toHex(to), topics: [[FROZEN_SET_TOPIC, WITHDRAWN_TOPIC]] },
      ])
      if (!logs.ok) {
        c.error = `no host answered for the blocks from ${from}: ${logs.reason}`
        break
      }
      for (const log of Array.isArray(logs.value) ? logs.value : []) {
        const kind = actionOfLog(log, c.vault.address)
        if (!kind) continue
        const hash = log.transactionHash.toLowerCase()
        const list = c.pending.get(hash) ?? []
        if (!list.some((a) => a.kind === kind)) list.push({ kind, block: BigInt(log.blockNumber).toString() })
        c.pending.set(hash, list)
      }
      from = to + 1n
      c.next = from
    }
    await settlePending(c)
  }

  async function refresh(vaults: readonly ActionVault[]): Promise<void> {
    const head = await firstAnswer<string>('eth_blockNumber', [])
    lastHeadError = head.ok ? null : head.reason
    if (head.ok) {
      const target = BigInt(head.value) - lagBlocks
      for (const v of vaults) {
        const key = v.address.toLowerCase()
        const c = cursors.get(key) ?? { vault: v, next: null, target: null, freeze: new Map(), withdraw: new Map(), pending: new Map(), error: null }
        c.vault = v
        cursors.set(key, c)
        try {
          await scanVault(c, target)
        } catch (e) {
          c.error = shortRpcError(e, hosts)
        }
      }
    }
    lastDone = now()
  }

  function snapshot(v: ActionVault): VaultOwnerActions {
    const c = cursors.get(v.address.toLowerCase())
    const scanned = c?.next != null ? c.next - 1n : null
    const scannedToBlock = scanned !== null && c?.target != null && scanned >= 0n ? scanned.toString() : null
    const read = (): ActionsReadState => {
      const unread = c ? [...c.pending.keys()] : []
      if (c?.error) return { state: 'unreadable', scannedToBlock, reason: c.error }
      if (!c && lastHeadError) return { state: 'unreadable', scannedToBlock: null, reason: `no host answered: ${lastHeadError}` }
      if (unread.length) return { state: 'unreadable', scannedToBlock, reason: `the sender of ${unread.length} transaction(s) could not be read, so they are not shown` }
      if (lastHeadError) return { state: 'unreadable', scannedToBlock, reason: `what follows block ${scannedToBlock ?? 'unknown'} could not be read: ${lastHeadError}` }
      if (c && c.next !== null && c.target !== null && c.next > c.target) return { state: 'complete', scannedToBlock }
      return { state: 'reading', scannedToBlock }
    }
    const list = (m?: Map<string, ActionTx>) => [...(m?.values() ?? [])].sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : 1))
    return { freezeTxs: list(c?.freeze), withdrawTxs: list(c?.withdraw), read: read() }
  }

  return {
    /** Each vault's actions as known now, by lowercase address. Never throws. */
    async read(vaults: readonly ActionVault[]): Promise<Map<string, VaultOwnerActions>> {
      if (vaults.length > 0) {
        // A vault not asked about yet is read at once. After that the TTL holds, also when a read
        // failed: the report route has no rate budget, so a request must not be able to cost a scan.
        const unseen = vaults.some((v) => !tried.has(v.address.toLowerCase()))
        if (!inFlight && (unseen || now() - lastDone >= ttlMs)) {
          for (const v of vaults) tried.add(v.address.toLowerCase())
          inFlight = refresh(vaults)
            .catch((e) => {
              lastHeadError = shortRpcError(e, hosts)
            })
            .finally(() => {
              inFlight = null
            })
        }
        if (inFlight) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            inFlight,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs)
            }),
          ])
          clearTimeout(timer)
        }
      }
      return new Map(vaults.map((v) => [v.address.toLowerCase(), snapshot(v)]))
    },
  }
}

export type OwnerActionReader = ReturnType<typeof createOwnerActionReader>

let liveReader: OwnerActionReader | null = null

/** The one reader the server keeps, on the registry's hosts. Each read gets a short timeout: the scan is what must not stall. */
export function liveOwnerActions(env: NodeJS.ProcessEnv = process.env): (vaults: readonly ActionVault[]) => Promise<Map<string, VaultOwnerActions>> {
  return async (vaults) => {
    if (!liveReader) {
      const chain = getChainById(ADMISSION_CHAIN)
      if (!chain) throw new Error(`the registry no longer has ${ADMISSION_CHAIN}`)
      liveReader = createOwnerActionReader({ hosts: liveRpcHosts(chain, env, { timeoutMs: 6_000, retryCount: 0 }) })
    }
    return liveReader.read(vaults)
  }
}
