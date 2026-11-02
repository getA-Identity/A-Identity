/**
 * Whether a vault deployed from this page counts on /proof/arc, as the deploy page tells its owner.
 *
 * The server decides (POST /api/arc/vaults, mcp/src/arc-owner-vault-live.ts). This module only turns
 * its answer into what the page says, and decides when there is anything to ask. It imports nothing,
 * so a test can read it directly.
 */

/** What the page shows. 'failed' is about the question and never about the vault. */
export type VaultCount =
  | { state: 'checking' }
  | { state: 'counted' }
  | { state: 'not-counted'; reasons: string[]; retryable: boolean }
  | { state: 'failed'; why: string }

type Answer = { status?: string; reason?: string; retryable?: boolean; reasons?: { reason?: string }[] }

const NO_REASON = 'The check did not say why.'

/** The HTTP status and JSON body of POST /api/arc/vaults as what the page says. Anything unrecognized is a failure, never counted. */
export function vaultCountFromAnswer(httpStatus: number, body: unknown): VaultCount {
  const a = (body ?? {}) as Answer
  if (httpStatus === 200 && a.status === 'admitted') return { state: 'counted' }
  if (httpStatus === 200 && a.status === 'refused') {
    const reasons = (a.reasons ?? []).map((r) => r.reason).filter((r): r is string => Boolean(r))
    return { state: 'not-counted', reasons: reasons.length ? reasons : [NO_REASON], retryable: a.retryable === true }
  }
  if (httpStatus === 429) return { state: 'failed', why: 'Too many tries from this connection in the last minute.' }
  if (a.status === 'unavailable') return { state: 'failed', why: 'Our server could not finish the check just now.' }
  return { state: 'failed', why: 'Our server did not give an answer.' }
}

type DeploySetup = { vault?: string | null; deploy?: { hash: string; outcome: string } | null }

/**
 * The deploy hash to ask about: only on mainnet, and only a deploy this page saw settle. A vault found
 * at its address without a receipt, or a replaced hash, names no transaction the server could check.
 */
export function countableDeploy(testnet: boolean, setup: DeploySetup | null): string | null {
  if (testnet || !setup?.vault || setup.deploy?.outcome !== 'settled') return null
  return setup.deploy.hash
}

/**
 * The steps at which the vault's agent key has its end date. Admission requires one, and the deploy
 * alone leaves it at 0, so a post at the moment the deploy settles would always be refused.
 */
export function readyToCount(step: string): boolean {
  return step === 'fund' || step === 'fund-pending' || step === 'done'
}
