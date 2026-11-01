/**
 * Which RPC host a read or a simulation runs on, as a pure loop with no runtime imports, so
 * mcp/src/frontend-arc-vault.test.ts can load it straight from src/ and drive it with fake hosts.
 *
 * Every host is asked its chain id once before anything else is asked of it, and a host that
 * answers for another chain counts as a host that failed: nothing it could say about a vault, a
 * balance or a simulated deploy describes the chain on screen. A host that cannot say which chain
 * it is on fails the same way.
 */

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
