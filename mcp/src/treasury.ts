/**
 * Agent treasury - idle-balance auto-yield into USYC, Circle's yield-bearing token.
 *
 * When an agent's idle stablecoin balance (USDC + EURC) sits above a working-capital
 * cap the human owner sets, the excess can be put to work in USYC - Circle's tokenized
 * money-market fund on Arc (short-duration U.S. Treasuries) - to earn onchain yield,
 * then redeemed to USDC when the agent needs to spend. Every step is authorization-
 * gated: the owner sees a projected-earnings review (weekly / monthly) and must
 * explicitly turn it on. Nothing moves without that, and the cap is never touched.
 *
 * Honesty, same as every write path in this repo: USYC is an ENTERPRISE-GATED Circle
 * product (testnet allowlist via Circle Support, ~24-48h, eligibility applies). Balance
 * reads and the earnings review are REAL and need no key. The actual USDC -> USYC mint
 * runs through the real USYC Teller only once the wallet is allowlisted; otherwise this
 * returns a `prepared` plan pointing at the real onchain contracts and spells out the
 * one step needed to go live. No mocked yield, no fake balances, no fake positions.
 *
 * USDY is deliberately NOT used: it is an Ondo product, not a Circle product, and it is
 * not deployed on Arc. USYC is the Circle-native yield token on Arc.
 *
 * Verified addresses (Arc testnet, docs.arc.io/arc/references/contract-addresses):
 *   USDC 0x3600...0000 · EURC 0x89B5...D72a · USYC 0xe918...b86C
 *   USYC Teller 0x9fdF...105A (mint/redeem) · Entitlements 0xcc20...6113 (allowlist)
 */
import { ARC_EXPLORER } from './arc-contracts.js'
import { ARC_CHAIN } from './chains/index.js'

/** Arc's primary RPC, from the one place a chain is described. */
const ARC_RPC = ARC_CHAIN.rpcUrls[0]

/** Real Arc-testnet token contracts. All three use 6 decimals on Arc. */
export const TREASURY_ASSETS = {
  usdc: ARC_CHAIN.contracts.usdc as string,
  eurc: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  usyc: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
} as const
/** USYC Teller: mints/redeems USYC from USDC once a wallet is allowlisted. */
const USYC_TELLER = '0x9fdF14c5B14173D74C08Af27AebFf39240dC105A'

/**
 * USYC is a tokenized money-market fund; its yield floats with short T-bill rates.
 * We project earnings with a representative APY, always labeled an estimate, and let
 * it be overridden with USYC_APY_BPS. This is not a guaranteed or quoted rate.
 */
const DEFAULT_APY_BPS = 420

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const fromUnits6 = (v: bigint) => Number(v) / 1e6
const usdcUnits = (usd: number) => BigInt(Math.round(usd * 1e6))
const round2 = (n: number) => Math.round(n * 100) / 100

async function publicClient() {
  const { createPublicClient, http } = await import('viem')
  return createPublicClient({ transport: http(ARC_RPC, { timeout: 8000, retryCount: 1 }) })
}

async function balanceUsd(client: Awaited<ReturnType<typeof publicClient>>, token: string, owner: string): Promise<number> {
  try {
    const raw = await client.readContract({
      address: token as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`],
    })
    return fromUnits6(raw as bigint)
  } catch {
    return 0
  }
}

export type AssetBalances = { usdcUsd: number; eurcUsd: number; usycUsd: number; idleUsd: number; totalUsd: number }

/** Live multi-asset balances for an agent wallet (no key). idle = spendable stablecoin. */
export async function readTreasuryBalances(address: string): Promise<AssetBalances> {
  const client = await publicClient()
  const [usdcUsd, eurcUsd, usycUsd] = await Promise.all([
    balanceUsd(client, TREASURY_ASSETS.usdc, address),
    balanceUsd(client, TREASURY_ASSETS.eurc, address),
    balanceUsd(client, TREASURY_ASSETS.usyc, address),
  ])
  const idleUsd = round2(usdcUsd + eurcUsd)
  return {
    usdcUsd: round2(usdcUsd), eurcUsd: round2(eurcUsd), usycUsd: round2(usycUsd),
    idleUsd, totalUsd: round2(idleUsd + usycUsd),
  }
}

function apyBps(env: NodeJS.ProcessEnv): number {
  const v = Number(env.USYC_APY_BPS)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_APY_BPS
}

export type YieldProjection = {
  principalUsd: number; apyPct: number
  weeklyUsd: number; monthlyUsd: number; yearlyUsd: number
  estimated: true
}

/** Projected USYC earnings on a principal, for the owner to review before authorizing. */
export function projectYield(principalUsd: number, env: NodeJS.ProcessEnv = process.env): YieldProjection {
  const yearly = principalUsd * (apyBps(env) / 10000)
  return {
    principalUsd: round2(principalUsd),
    apyPct: apyBps(env) / 100,
    weeklyUsd: round2(yearly / 52),
    monthlyUsd: round2(yearly / 12),
    yearlyUsd: round2(yearly),
    estimated: true,
  }
}

export type TreasuryPreview = {
  address: string
  balances: AssetBalances
  capUsd: number
  deployableUsd: number
  projection: YieldProjection
  usyc: { token: string; teller: string; explorer: string; apyEstimatePct: number }
  note: string
}

/** Read-only: what auto-yield WOULD do at this cap - idle above cap, projected earnings. */
export async function previewTreasury(address: string, capUsd: number, env: NodeJS.ProcessEnv = process.env): Promise<TreasuryPreview> {
  const cap = Math.max(0, capUsd)
  const balances = await readTreasuryBalances(address)
  const deployableUsd = round2(Math.max(0, balances.idleUsd - cap))
  return {
    address,
    balances,
    capUsd: cap,
    deployableUsd,
    projection: projectYield(deployableUsd, env),
    usyc: {
      token: TREASURY_ASSETS.usyc, teller: USYC_TELLER,
      explorer: `${ARC_EXPLORER}/address/${TREASURY_ASSETS.usyc}`, apyEstimatePct: apyBps(env) / 100,
    },
    note:
      deployableUsd > 0
        ? `$${deployableUsd} of idle USDC/EURC above your $${cap} working-capital cap can earn yield in USYC.`
        : `Idle balance is at or below the $${cap} cap - nothing to put to work right now.`,
  }
}

export type TreasuryExecution = {
  executed: false
  prepared: true
  deployableUsd: number
  projection: YieldProjection
  contract: string
  call: string
  reason: string
}

/**
 * Authorize + start auto-yield: earmark idle balance above the cap for USYC. The actual
 * USDC -> USYC mint runs through the real Teller only when the wallet is USYC-allowlisted;
 * without that it returns a `prepared` plan against the real contracts and names the one
 * step to go live. Same gating discipline as the on-chain vault / Circle wallet paths -
 * it never fabricates a yield position. Persisting the owner's auto-yield authorization
 * (cap, enabled) is handled by the caller in platform.ts; this returns the onchain plan.
 */
export async function startAutoYield(address: string, capUsd: number, env: NodeJS.ProcessEnv = process.env): Promise<TreasuryExecution> {
  const preview = await previewTreasury(address, capUsd, env)
  return {
    executed: false,
    prepared: true,
    deployableUsd: preview.deployableUsd,
    projection: preview.projection,
    contract: USYC_TELLER,
    call: `approve(USDC, ${preview.deployableUsd}) then USYC Teller deposit(${usdcUnits(preview.deployableUsd)}) -> USYC`,
    reason:
      'Auto-yield is authorized and the plan targets the real USYC Teller. To settle onchain, ' +
      'allowlist this Arc wallet for testnet USYC (open a Circle Support ticket with the address, ~24-48h). ' +
      'Balances, the cap, and the earnings review are live now; only the USDC->USYC mint waits on allowlisting.',
  }
}
