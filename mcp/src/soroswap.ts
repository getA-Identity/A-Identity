/**
 * Soroswap, read only: what a swap WOULD return, simulated against the live router.
 *
 * WHY THIS IS A READ AND NOTHING ELSE. An agent whose vault holds the wrong asset cannot
 * pay a USDC invoice, and the honest first step is to say what converting would cost
 * rather than to convert. Swapping from inside `AgentSpendPolicy` would mean a new
 * entrypoint, a new wasm and a third vault deployment, because the contract has no upgrade
 * path by design. None of that is in this file. Everything here is a simulation: it costs
 * nothing, signs nothing, moves nothing, and needs no key.
 *
 * WHY NOT THE HOSTED API. Soroswap publishes a quote API at api.soroswap.finance, and it
 * requires an `sk_` key that must not reach a browser. The router answers the same question
 * on chain for free, so the critical path has no third-party uptime in it and no secret to
 * leak. The trade is that we get one pool's price rather than an aggregated route; that
 * limitation is returned in `caveats` rather than left for a reader to discover.
 *
 * NOT FOLDED INTO chains/stellar/adapter.ts on purpose. That adapter is the vault's, and
 * its reads are the twelve the vault answers. This is a third party's router. Keeping them
 * apart means a change to how we read Soroswap cannot alter how we read our own contract.
 *
 * HONEST STATUS. A quote is LIVE, because it is simulated against the router now, and it is
 * still only a quote: no route is reserved, nothing is bound to it, and on testnet the pool
 * price is whatever a faucet-funded liquidity provider left behind rather than a market
 * rate. Both facts ride along with every answer.
 */
import { Account, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from './chains/types.js'
import { READ_ONLY_SOURCE } from './chains/stellar/adapter.js'
import { networkPassphrase, sorobanServer, stellarSignerAddress } from './chains/stellar/client.js'
import { isContractId } from './chains/stellar/strkey.js'

/** The router method we call, and the only one. Named once so a typo is one place. */
export const AMOUNTS_OUT = 'router_get_amounts_out'

/** What every answer carries, whether or not a quote came back. */
export const SOROSWAP_CAVEATS = [
  'A quote, not a reservation. Nothing is bound to this price and no route is held.',
  'One pool, not an aggregated route: this reads the router directly rather than the hosted aggregator API, so a cheaper multi-hop path may exist.',
  'Soroswap is a third party. We did not deploy the router, the factory or the pool, and we do not vouch for them.',
] as const

/** The extra caveat testnet earns, because a testnet pool price is not a price. */
export const TESTNET_CAVEAT =
  'Stellar testnet. The pool holds faucet money, so the rate reflects whatever a liquidity provider left behind and is not a market rate.'

export type SoroswapQuote =
  | { available: false; reason: string }
  | {
      available: true
      /** Live, because the router answered now. Still a quote; see `kind`. */
      status: 'live'
      kind: 'quote'
      network: string
      router: string
      /** Read out of the router at call time, never stored. */
      factory: string | null
      pair: string | null
      sell: { asset: string; amount: string }
      buy: { asset: string; amount: string }
      readAt: string
      caveats: string[]
    }

export interface SoroswapDeps {
  server?: (env: NodeJS.ProcessEnv) => Pick<rpc.Server, 'simulateTransaction'>
  now?: () => Date
}

/** The router this chain knows about, or null where none is recorded. */
export function soroswapRouter(chain: ChainDescriptor): string | null {
  return chain.contracts?.soroswap?.router ?? null
}

/** A simulated read on a contract that is not ours. Throws only on a broken simulation. */
async function view(
  chain: ChainDescriptor,
  contract: string,
  method: string,
  args: xdr.ScVal[],
  env: NodeJS.ProcessEnv,
  deps: SoroswapDeps,
): Promise<unknown> {
  const server = deps.server ? deps.server(env) : sorobanServer(chain, env)
  // The simulator builds a footprint; it never checks that the source account exists. So a
  // read needs no key and no funded account, which is why the all-zero address is the
  // honest source here rather than someone's real one.
  const source = stellarSignerAddress(chain, env) ?? READ_ONLY_SOURCE
  const tx = new TransactionBuilder(new Account(source, '0'), {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(chain),
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
  if (!sim.result) throw new Error(`${method}: simulation returned no result`)
  return scValToNative(sim.result.retval)
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * JSON for a value that may hold a BigInt, which `scValToNative` returns for every i128.
 *
 * Plain JSON.stringify THROWS on a BigInt, so quoting a malformed answer back at the caller
 * used to turn a clean refusal into an exception: the error path failed harder than the
 * thing it was reporting. A unit test pins that, because it is only reachable when the
 * router answers something we did not expect, which a live check never does.
 */
function describe(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * What `sellAmount` of `sellAsset` would return in `buyAsset`, right now.
 *
 * Amounts are base units as strings, because these are i128 on chain and a JavaScript
 * number cannot hold one. Refuses rather than guesses on every input it cannot check, and
 * returns a labeled unavailable rather than throwing when the chain records no router,
 * which is the same shape every other missing-credential path in this codebase takes.
 */
export async function soroswapQuote(input: {
  chain: ChainDescriptor
  sellAsset: string
  buyAsset: string
  sellAmount: string
  env?: NodeJS.ProcessEnv
  deps?: SoroswapDeps
}): Promise<SoroswapQuote> {
  const { chain, sellAsset, buyAsset, sellAmount } = input
  const env = input.env ?? process.env
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())

  const router = soroswapRouter(chain)
  if (!router) {
    return { available: false, reason: `${chain.id} records no Soroswap router, so there is nothing to quote against` }
  }
  if (!isContractId(sellAsset) || !isContractId(buyAsset)) {
    return { available: false, reason: 'sellAsset and buyAsset must both be Soroban contract ids (a SAC, not a classic asset string)' }
  }
  if (sellAsset === buyAsset) {
    return { available: false, reason: 'sellAsset and buyAsset are the same contract, so there is no swap to quote' }
  }
  let amount: bigint
  try {
    amount = BigInt(sellAmount)
  } catch {
    return { available: false, reason: `sellAmount ${sellAmount} is not an integer number of base units` }
  }
  if (amount <= 0n) return { available: false, reason: 'sellAmount must be above zero' }

  const path = nativeToScVal([sellAsset, buyAsset].map((a) => nativeToScVal(a, { type: 'address' })))
  let amounts: unknown
  try {
    amounts = await view(chain, router, AMOUNTS_OUT, [nativeToScVal(amount, { type: 'i128' }), path], env, deps)
  } catch (e) {
    // A pool that does not exist is the common case and it is not an outage, so it reads as
    // unavailable with the router's own words rather than as a failure of ours.
    return { available: false, reason: `the router could not quote this pair: ${msg(e)}` }
  }
  if (!Array.isArray(amounts) || amounts.length < 2) {
    return { available: false, reason: `${AMOUNTS_OUT} returned ${describe(amounts)}, which is not a two-leg amounts array` }
  }
  const out = String(amounts[amounts.length - 1])
  // A quote of nothing is not a quote. The router answers 0 honestly when the input is
  // smaller than the pool can price at its current reserves, and returning that as an
  // available quote would put a confident "you receive 0" in front of someone, which reads
  // as a broken integration rather than as an amount below the pool's resolution.
  if (!/^[0-9]+$/.test(out) || BigInt(out) <= 0n) {
    return {
      available: false,
      reason: `${sellAmount} base units is below what this pool can price: ${AMOUNTS_OUT} returned ${out}`,
    }
  }

  // Derived, never stored: if the router ever repoints, these follow it in the same breath.
  const derived = async (method: string, args: xdr.ScVal[]): Promise<string | null> => {
    try {
      const v = await view(chain, router, method, args, env, deps)
      return typeof v === 'string' && isContractId(v) ? v : null
    } catch {
      return null
    }
  }
  const [factory, pair] = await Promise.all([
    derived('get_factory', []),
    derived('router_pair_for', [nativeToScVal(sellAsset, { type: 'address' }), nativeToScVal(buyAsset, { type: 'address' })]),
  ])

  return {
    available: true,
    status: 'live',
    kind: 'quote',
    network: chain.caip2,
    router,
    factory,
    pair,
    sell: { asset: sellAsset, amount: amount.toString() },
    buy: { asset: buyAsset, amount: out },
    readAt: now().toISOString(),
    caveats: [...SOROSWAP_CAVEATS, ...(chain.caip2.endsWith(':testnet') ? [TESTNET_CAVEAT] : [])],
  }
}
