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
    // No reason at all means revert data came back that did not decode: still the contract's.
    if (x.name === 'ContractFunctionRevertedError') return Boolean(x.data || x.signature || typeof x.reason !== 'string' || /revert/i.test(x.reason))
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

/** Every host failed: the hosts tried, in order, the last failure, and each host's own failure. */
export class NoHostAnswered extends Error {
  readonly tried: string[]
  readonly last: unknown
  readonly failures: readonly { host: string; error: unknown }[]
  constructor(tried: string[], last: unknown, failures: readonly { host: string; error: unknown }[] = []) {
    super(`no host answered (${tried.join(', ')})`)
    this.name = 'NoHostAnswered'
    this.tried = tried
    this.last = last
    this.failures = failures
  }
}

type FetchWalked = { name?: unknown; status?: unknown; message?: unknown; cause?: unknown }

/**
 * True when no HTTP answer from the host reached this page: the browser refused to send the request
 * or could not finish it. viem raises HttpRequestError with no status for that (with fetch's
 * TypeError as its cause), and with a status when the page could read the host's answer, a 429 rate
 * limit included. A timeout is not this: the request went out and the host was slow.
 *
 * Brave Shields, an ad or tracker blocker, a VPN or a filtering DNS all end a request this way, and
 * so does a lost connection. So can an error page a host's proxy sends without the header that lets
 * this page read it. This is what was seen, not proof of why: when every host fails like this at
 * once, the likeliest cause is on this side, and "wait a minute" is not the advice. Known by name, so
 * this file needs no viem.
 */
export function neverAnswered(e: unknown): boolean {
  let x = e as FetchWalked | null | undefined
  for (let i = 0; i < 12 && x && typeof x === 'object'; i += 1) {
    if (x.name === 'TimeoutError') return false
    if (x.name === 'HttpRequestError') return x.status === undefined || x.status === null
    if (x.name === 'TypeError' && typeof x.message === 'string' && /fetch|network|load failed/i.test(x.message)) return true
    x = x.cause as FetchWalked | null | undefined
  }
  return false
}

/** True when there was at least one failure and none of them got an HTTP answer. */
export function noneAnswered(failures: readonly { error: unknown }[]): boolean {
  return failures.length > 0 && failures.every((f) => neverAnswered(f.error))
}

type WalletWalked = { code?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown }

/**
 * True when a wallet said no to a read instead of failing it: this site is not authorized (EIP-1193
 * 4100), the person closed a window the wallet opened for it (4001), or the wallet is locked. Asking
 * again would only open that window again, so such a wallet is not asked for reads until it or its
 * account changes. Walks the cause chain, since viem wraps the wallet's own error. Known by code and
 * words, so this file needs no viem.
 */
export function walletSaidNo(e: unknown): boolean {
  let x = e as WalletWalked | null | undefined
  for (let i = 0; i < 12 && x && typeof x === 'object'; i += 1) {
    if (x.code === 4100 || x.code === 4001) return true
    for (const m of [x.message, x.shortMessage, x.details]) if (typeof m === 'string' && /unauthori[sz]ed|not (?:been )?authori[sz]ed|\blocked\b/i.test(m)) return true
    x = x.cause as WalletWalked | null | undefined
  }
  return false
}

/**
 * Run `fn` on the hosts in order until one answers. `isFinal` says which errors from `fn` are a
 * verdict rather than a host's fault (a revert, a decision `fn` made itself): those are thrown at
 * once, because the next host would only give the same answer later. The answer carries the failures
 * of the hosts asked before it, so the caller can tell a blocked browser from a busy network.
 */
export async function onHosts<C, T>(
  hosts: readonly { host: string; client: C }[],
  x: { chainId: number; askChainId: (client: C) => Promise<number>; isFinal: (e: unknown) => boolean },
  fn: (client: C, host: string) => Promise<T>,
): Promise<{ value: T; host: string; failures: readonly { host: string; error: unknown }[] }> {
  const tried: string[] = []
  const failures: { host: string; error: unknown }[] = []
  let last: unknown = null
  for (const { host, client } of hosts) {
    tried.push(host)
    let id: number
    try {
      id = await x.askChainId(client)
    } catch (e) {
      last = e
      failures.push({ host, error: e })
      continue
    }
    if (id !== x.chainId) {
      last = new Error(`${host} answered for chain ${id}, not ${x.chainId}`)
      failures.push({ host, error: last })
      continue
    }
    try {
      return { value: await fn(client, host), host, failures }
    } catch (e) {
      if (x.isFinal(e)) throw e
      last = e
      failures.push({ host, error: e })
    }
  }
  throw new NoHostAnswered(tried, last, failures)
}
