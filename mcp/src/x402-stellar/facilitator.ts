/**
 * Our own x402 facilitator for Stellar.
 *
 * The EVM version of this file (`x402-3009/facilitator.ts`) exists because Robinhood Chain
 * had no facilitator from anyone. Stellar is different, and the difference has to be said
 * out loud rather than implied by our shipping one: OpenZeppelin Channels got there first
 * and is a real, working Stellar x402 facilitator. We are not filling a gap here. We are
 * declining to make our own settlement depend on somebody else's service, which is the same
 * decision every other chain in this product already reflects.
 *
 * So the claim this file supports is narrow and checkable:
 *
 *   A-Identity runs its own facilitator on every chain it settles on, Stellar included.
 *   On Stellar, OpenZeppelin Channels is available as a fallback. On every chain, settled
 *   means we read the transfer ourselves.
 *
 * Not "the only one", not "the first". Those would both be false.
 *
 * ## The boundary, published rather than discovered
 *
 * - `/verify` and `/supported` are OPEN. Verification reads and signs nothing.
 * - `/settle` is ALLOWLISTED by payTo, because settling means we pay the network fee. An
 *   open settle endpoint is an XLM faucet with our name on it. The switch is configuration.
 *
 * ## What /supported may advertise
 *
 * Only a network whose rail is configured AND whose broadcaster is actually ready. The EVM
 * facilitator refuses to advertise a kind whose token domain it cannot prove, for the
 * reason that a buyer sent to sign something unsettleable is worse off than one told no.
 * The Stellar analogue of "cannot prove the domain" is "nothing here can broadcast", and it
 * is reported under `unavailable` with the reason, never as a kind.
 *
 * Pure, like its sibling: handlers take a body and return {httpStatus, body}. The route file
 * is a thin adapter, so all of this is testable without a server.
 */
import { CHAINS, getChain, getChainById, type ChainDescriptor } from '../chains/index.js'
import { networkPassphrase } from '../chains/stellar/client.js'
import { isAccountId, isContractId } from '../chains/stellar/strkey.js'
import {
  ozFacilitatorUrl,
  stellarRailLimits,
  stellarRailNetworks,
  stellarRailStatus,
  stellarRailToken,
} from './rail.js'
import { settleStellarPayment, verifyStellarPayment } from './settle.js'
import type { StellarRequirements, StellarSettleCode, StellarSettleDeps } from './settle.js'

type Handled = { httpStatus: number; body: Record<string, unknown> }

/**
 * Resolve the network a request names.
 *
 * Accepts a registry slug (`stellar-testnet`) or a CAIP-2 id (`stellar:testnet`), both
 * unambiguous against the registry, and then REFUSES anything that is not a Stellar chain.
 * That last check is not pedantry: without it, a request naming `celo` would resolve to a
 * real descriptor and get carried into code that would try to build a Soroban RPC client
 * out of it.
 */
export function resolveStellarNetwork(name: unknown): ChainDescriptor | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const raw = name.trim()
  const chain = getChain(raw) ?? getChainById(raw) ?? null
  return chain?.ecosystem === 'stellar' ? chain : null
}

/** Every Stellar chain declaring a soroban-auth settlement token. Derived, never listed. */
export function stellarFacilitatorChains(env: NodeJS.ProcessEnv = process.env): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'stellar' && Boolean(stellarRailToken(c, env)))
}

export type StellarSupportedKind = {
  x402Version: 1 | 2
  scheme: 'exact'
  network: string
  asset: string
  assetSymbol: string
  decimals: number
  extra: Record<string, unknown>
  minAmountRequired: string
  maxAmountRequired: string
}

/**
 * GET /api/x402/stellar/facilitator/supported
 *
 * `extra` carries what a buyer needs in order to SIGN, which on Soroban is a different set
 * of things from EIP-712. There is no domain separator to publish because the protocol
 * fixes the preimage; what a signer actually needs is the network passphrase (it is inside
 * the preimage, so getting it wrong produces a signature valid on no network at all), the
 * contract and function being authorized, and who will broadcast.
 */
export function stellarSupported(env: NodeJS.ProcessEnv = process.env): Handled {
  const kinds: StellarSupportedKind[] = []
  const unavailable: { network: string; reason: string }[] = []

  for (const chain of stellarFacilitatorChains(env)) {
    const status = stellarRailStatus(env, chain.caip2)
    if (!status.configured || !status.token || !status.payTo) {
      unavailable.push({ network: chain.caip2, reason: status.reason ?? 'this rail is not configured' })
      continue
    }
    const limits = stellarRailLimits(status, env)
    const shared = {
      scheme: 'exact' as const,
      asset: status.token.address,
      assetSymbol: status.token.symbol,
      decimals: status.token.decimals,
      extra: {
        authorization: 'soroban-auth',
        contract: status.token.address,
        function: 'transfer',
        args: ['from (your G... account)', `to (${status.payTo})`, 'amount (i128 base units)'],
        // The reason there is no domainSeparator field here, said rather than left as a
        // hole a reader has to interpret.
        networkPassphrase: networkPassphrase(chain),
        domainProving: 'not applicable: Soroban fixes the authorization preimage in the protocol, so there is no per-token domain to prove',
        payTo: status.payTo,
        broadcaster: status.broadcaster,
        expiryHeadroomLedgers: limits.expiryHeadroomLedgers,
      },
      minAmountRequired: limits.minValue.toString(),
      maxAmountRequired: limits.maxValue.toString(),
    }
    // Both wire shapes, the same as our EVM facilitator publishes: v2 keys on CAIP-2, v1
    // on the registry slug, because an off-the-shelf client may send either.
    kinds.push({ x402Version: 2, network: chain.caip2, ...shared })
    kinds.push({ x402Version: 1, network: chain.id, ...shared })
  }

  const first = stellarRailStatus(env)
  return {
    httpStatus: 200,
    body: {
      kinds,
      ...(unavailable.length ? { unavailable } : {}),
      facilitator: {
        operator: 'A-Identity',
        selfHosted: true,
        vm: 'soroban',
        settle: {
          open: first.publicSettle,
          note: first.publicSettle
            ? 'Settlement is open: any payTo may be settled for.'
            : 'We assemble the transaction and pay the network fee, so /settle is limited to allowlisted payTo accounts. /verify and /supported are open to everyone.',
        },
        // Said plainly, because shipping a facilitator on a chain that already has one
        // reads as a claim to be first unless the sentence is there.
        priorArt: {
          note: 'OpenZeppelin Channels is an existing Stellar x402 facilitator and predates this one. We run our own so our settlement does not depend on a third party, and Channels stays available here as a fallback broadcaster.',
          // Per network, because the endpoint differs per network. Hardcoding the pubnet
          // chain here published the mainnet Channels URL to a rail that only runs on
          // testnet, which is a working link to the wrong place: worse than no link.
          fallbackUrl: Object.fromEntries(
            stellarFacilitatorChains(env).map((c) => [c.caip2, ozFacilitatorUrl(c, env)]),
          ),
        },
        confirmation:
          'Whoever broadcasts, settled means we read the transfer event ourselves and matched it to the authorization nonce. A broadcaster reporting success is an input to that check, never a substitute.',
        endpoints: {
          verify: '/api/x402/stellar/facilitator/verify',
          settle: '/api/x402/stellar/facilitator/settle',
          supported: '/api/x402/stellar/facilitator/supported',
        },
        networks: stellarRailNetworks(env),
      },
    },
  }
}

type FacilitatorRequest = {
  paymentPayload?: unknown
  paymentRequirements?: unknown
  x402Version?: number
}

function readRequest(
  body: unknown,
): { ok: true; chain: ChainDescriptor; requirements: StellarRequirements; payload: unknown } | { ok: false; reason: string; code: string } {
  const b = (body ?? {}) as FacilitatorRequest
  const req = b.paymentRequirements as Record<string, unknown> | undefined
  const payload = b.paymentPayload as Record<string, unknown> | undefined
  if (!req || !payload) {
    return { ok: false, code: 'malformed_payload', reason: 'body needs { paymentPayload, paymentRequirements }' }
  }
  const chain = resolveStellarNetwork(req.network ?? (payload as { network?: unknown }).network)
  if (!chain) {
    return {
      ok: false,
      code: 'unsupported_network',
      reason: `unknown Stellar network '${String(req.network ?? '')}': use a registry slug like stellar-testnet or a CAIP-2 id like stellar:testnet`,
    }
  }
  const asset = String(req.asset ?? '')
  const payTo = String(req.payTo ?? '')
  // Shape-checked here rather than deeper in, and checked as the RIGHT shapes: a SEP-41
  // contract is a C... StrKey and a payee is a G... account. Accepting either for either
  // is the confusion that puts a transfer on an issuer instead of a token.
  if (!isContractId(asset)) {
    return { ok: false, code: 'malformed_payload', reason: 'paymentRequirements.asset must be a Soroban contract id (C...)' }
  }
  if (!isAccountId(payTo)) {
    return { ok: false, code: 'malformed_payload', reason: 'paymentRequirements.payTo must be a Stellar account id (G...)' }
  }
  // The payload's own network, when it carries one, must agree. A payload signed for one
  // network wrapped in requirements naming another is not a mismatch we should resolve by
  // picking a side; the signature check would catch it, and catching it here says why.
  const payloadNetwork = (payload as { network?: unknown }).network
  if (typeof payloadNetwork === 'string' && payloadNetwork.trim()) {
    const pn = resolveStellarNetwork(payloadNetwork)
    if (pn && pn.caip2 !== chain.caip2) {
      return {
        ok: false,
        code: 'unsupported_network',
        reason: `the payload names ${pn.caip2} and the requirements name ${chain.caip2}`,
      }
    }
  }
  return {
    ok: true,
    chain,
    payload,
    requirements: {
      network: chain.caip2,
      asset,
      payTo,
      maxAmountRequired: String(req.maxAmountRequired ?? '0'),
      resource: String(req.resource ?? '/api/x402/stellar/facilitator/settle'),
    },
  }
}

/** POST /api/x402/stellar/facilitator/verify. Read-only, open, never broadcasts. */
export async function stellarVerify(body: unknown, deps: StellarSettleDeps = {}): Promise<Handled> {
  const env = deps.env ?? process.env
  const parsed = readRequest(body)
  if (!parsed.ok) return { httpStatus: 400, body: { isValid: false, invalidReason: parsed.reason, code: parsed.code } }

  const token = stellarRailToken(parsed.chain, env)
  if (!token) {
    return {
      httpStatus: 400,
      body: {
        isValid: false,
        code: 'unsupported_network',
        invalidReason: `${parsed.chain.id} declares no soroban-auth settlement token`,
        network: parsed.chain.caip2,
      },
    }
  }
  const status = stellarRailStatus(env, parsed.chain.caip2)
  const result = await verifyStellarPayment({
    chain: parsed.chain,
    token,
    requirements: parsed.requirements,
    payload: parsed.payload,
    limits: stellarRailLimits({ ...status, token }, env),
    deps,
  })
  return result.isValid
    ? { httpStatus: 200, body: { isValid: true, payer: result.auth.payer, network: parsed.chain.caip2 } }
    : {
        httpStatus: 200,
        body: { isValid: false, invalidReason: result.invalidReason, code: result.code, network: parsed.chain.caip2 },
      }
}

/**
 * POST /api/x402/stellar/facilitator/settle. We assemble, we pay the fee, we broadcast.
 *
 * Allowlisted by payTo, which turns "anyone can make us spend XLM" into "anyone can send US
 * money and make us spend XLM". That is why the other guards here get to be economic (a
 * minimum value, a fee ceiling, a daily budget) rather than adversarial.
 */
export async function stellarSettle(body: unknown, deps: StellarSettleDeps = {}): Promise<Handled> {
  const env = deps.env ?? process.env
  const parsed = readRequest(body)
  if (!parsed.ok) return { httpStatus: 400, body: { success: false, errorReason: parsed.reason, code: parsed.code } }

  const status = stellarRailStatus(env, parsed.chain.caip2)
  if (!status.configured) {
    return {
      httpStatus: 501,
      body: {
        success: false,
        code: 'not_configured',
        errorReason: status.reason ?? 'the Stellar rail is not configured on this network',
        network: parsed.chain.caip2,
      },
    }
  }

  // Exact comparison. A StrKey is case-significant base32, so the EVM habit of lowercasing
  // both sides would make every entry on this list match nothing.
  const allowed =
    status.publicSettle || parsed.requirements.payTo === status.payTo || status.allowedPayTo.includes(parsed.requirements.payTo)
  if (!allowed) {
    return {
      httpStatus: 403,
      body: {
        success: false,
        code: 'payto_not_allowlisted',
        errorReason: 'settle is allowlisted because we assemble the transaction and pay the network fee',
        note: '/verify and /supported are open to everyone. Ask for settle access if you are building on Stellar.',
        network: parsed.chain.caip2,
      },
    }
  }

  const token = stellarRailToken(parsed.chain, env)
  if (!token) {
    return {
      httpStatus: 400,
      body: {
        success: false,
        code: 'unsupported_network',
        errorReason: `${parsed.chain.id} declares no soroban-auth settlement token`,
        network: parsed.chain.caip2,
      },
    }
  }

  const result = await settleStellarPayment({
    chain: parsed.chain,
    token,
    requirements: parsed.requirements,
    payload: parsed.payload,
    limits: stellarRailLimits({ ...status, token }, env),
    deps: {
      ...deps,
      meta: {
        tool: 'facilitator',
        baseUsd: 0,
        ...(parsed.requirements.payTo === status.payTo ? {} : { facilitatedFor: parsed.requirements.payTo }),
      },
    },
  })
  if (result.success) return { httpStatus: 200, body: { ...result, network: parsed.chain.caip2 } }
  return { httpStatus: settleHttpStatus(result), body: { ...result, network: parsed.chain.caip2 } }
}

/**
 * Which HTTP status a failed settlement deserves.
 *
 * Exported and pure because this mapping is a real decision, not plumbing, and it is worth
 * testing over every code rather than over the two or three a stubbed network can reach.
 * The distinction it carries is the same one the codes carry:
 *
 *   503  come back later. The budget resets; nothing about this payment was wrong.
 *   501  this was never going to work here. No broadcaster is a configuration fact.
 *   202  broadcast, not confirmed. Decided neither way, and 502 would say it failed.
 *   502  it failed, and the body says why.
 *
 * The 202 is the one that matters. Everything upstream of it is careful not to call an
 * unconfirmed payment a refusal, and a 502 here would undo all of that in one integer.
 */
export function settleHttpStatus(result: { code: StellarSettleCode; ambiguous?: boolean }): number {
  if (result.code === 'fee_budget_exhausted') return 503
  if (result.code === 'no_broadcaster') return 501
  if (result.ambiguous) return 202
  return 502
}
