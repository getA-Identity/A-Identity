/**
 * Which RPC host a read or a simulation runs on, as a pure loop with no runtime imports, so
 * mcp/src/frontend-arc-vault.test.ts can load it straight from src/ and drive it with fake hosts.
 *
 * Every host is asked its chain id once before anything else is asked of it, and a host that
 * answers for another chain counts as a host that failed: nothing it could say about a vault, a
 * balance or a simulated deploy describes the chain on screen. A host that cannot say which chain
 * it is on fails the same way.
 */

type Walked = { name?: unknown; code?: unknown; cause?: unknown; data?: unknown; signature?: unknown; reason?: unknown }

/**
 * True when a failure is the contract's own answer, not the host's: a revert, or no data back.
 *
 * viem builds its "contract reverted" error for RPC code 3 and ALSO for -32603, the code a host uses
 * for its own trouble ("state at block N is pruned"). So the error's type is not enough: a revert
 * counts only with code 3, with revert data, or with a message that says reverted. Anything else is
 * a host's fault and the next host is asked. Known by name, so this file needs no viem.
 */
export function isContractAnswer(e: unknown): boolean {
  let x = e as Walked | null | undefined
  for (let i = 0; i < 12 && x && typeof x === 'object'; i += 1) {
    if (x.code === 3) return true
    if (x.name === 'ContractFunctionZeroDataError' || x.name === 'AbiDecodingZeroDataError' || x.name === 'AbiDecodingDataSizeTooSmallError') return true
    if (x.name === 'ContractFunctionRevertedError' && (x.data || x.signature || (typeof x.reason === 'string' && /revert/i.test(x.reason)))) return true
    x = x.cause as Walked | null | undefined
  }
  return false
}

/**
 * What hosts that answered agree is absent, or null when they do not yet. One host saying there
 * is no code, or that a view reverted, may only be behind or broken, so it takes two saying the
 * same (or every host, on a chain with one). Until then the next host is asked, and hosts that
 * did not answer count for nothing.
 */
export function agreedAbsence<K extends string>(said: readonly { kind: K; reason: string }[], hostCount: number): { kind: K; reason: string } | null {
  const need = Math.min(2, hostCount)
  return said.find((s) => said.filter((o) => o.kind === s.kind).length >= need) ?? null
}

/** Every host failed: the hosts tried, in order, and the last failure. */
export class NoHostAnswered extends Error {
  readonly tried: string[]
  readonly last: unknown
  constructor(tried: string[], last: unknown) {
    super(`no host answered (${tried.join(', ')})`)
    this.name = 'NoHostAnswered'
    this.tried = tried
    this.last = last
  }
}

/**
 * Run `fn` on the hosts in order until one answers. `isFinal` says which errors from `fn` are a
 * verdict rather than a host's fault (a revert, a decision `fn` made itself): those are thrown at
 * once, because the next host would only give the same answer later.
 */
export async function onHosts<C, T>(
  hosts: readonly { host: string; client: C }[],
  x: { chainId: number; askChainId: (client: C) => Promise<number>; isFinal: (e: unknown) => boolean },
  fn: (client: C, host: string) => Promise<T>,
): Promise<{ value: T; host: string }> {
  const tried: string[] = []
  let last: unknown = null
  for (const { host, client } of hosts) {
    tried.push(host)
    let id: number
    try {
      id = await x.askChainId(client)
    } catch (e) {
      last = e
      continue
    }
    if (id !== x.chainId) {
      last = new Error(`${host} answered for chain ${id}, not ${x.chainId}`)
      continue
    }
    try {
      return { value: await fn(client, host), host }
    } catch (e) {
      if (x.isFinal(e)) throw e
      last = e
    }
  }
  throw new NoHostAnswered(tried, last)
}
