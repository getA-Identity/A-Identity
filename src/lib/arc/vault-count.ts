/**
 * Whether an owner's vault counts on /proof/arc, as the deploy flow and the vault's own page tell it.
 *
 * The server decides (POST /api/arc/vaults, mcp/src/arc-owner-vault-live.ts). This module only turns
 * its answer into what the page says, and decides when there is anything to ask. It imports nothing,
 * so a test can read it directly.
 */

/**
 * What the page shows. 'failed' is about the question and never about the vault. 'needs-end-date'
 * and 'no-hash' are why the page is not asking, and each says so without claiming what the server
 * would answer. With no hash the server can still find the vault on the chain by itself
 * (mcp/src/arc-vault-sweep.ts), so while it says it is looking the page sends nobody to a person.
 */
export type VaultCount =
  | { state: 'checking' }
  | { state: 'counted' }
  | { state: 'not-counted'; reasons: string[]; retryable: boolean }
  /** waitMs: how long a question asked again by itself must wait, when the usual delay would be wasted. */
  | { state: 'failed'; why: string; waitMs?: number }
  | { state: 'needs-end-date' }
  | { state: 'no-hash' }

/**
 * What the vault's agent key end date read as. Revoked is not a date that has passed: admission takes a
 * revoked key and refuses any other date in the past (keyIsRevoked in mcp/src/arc-owner-vault.ts), and
 * the sweep finds the vault from the revoke's own log, so the page asks nothing of a revoked key's owner.
 */
export type EndDate = 'none' | 'future' | 'passed' | 'revoked' | 'unknown'

/** What "Revoke now" writes. A test holds it to REVOKED_KEY_EXPIRY in mcp/src/arc-owner-vault.ts, because this module imports nothing. */
const REVOKED = 1n

export function endDateOf(sessionKeyExpiry: bigint, expired: boolean): EndDate {
  if (sessionKeyExpiry === 0n) return 'none'
  if (sessionKeyExpiry === REVOKED) return 'revoked'
  return expired ? 'passed' : 'future'
}

/**
 * The end date the setup's last screen may speak from: only a read of this setup's own vault (liveOf
 * in tx-rules.ts), and not one from before the expiry's own block, which can still show the 0 the
 * deploy left while the same box says the date is still being read.
 */
export function endDateFromRead(live: { sessionKeyExpiry: bigint; expired: boolean } | null, readBehind: boolean): EndDate {
  return live && !readBehind ? endDateOf(live.sessionKeyExpiry, live.expired) : 'unknown'
}

/** Whether the server's own search is running, as GET /api/arc/vaults said. Only that answer can say it is. */
export type SweepSays = 'reading' | 'looking' | 'not-looking' | 'unknown'

/** The words in the sweep block that mean no round is getting as far as the chain, or no round is ending. The rest are a read that failed, which it tries again. */
const NOT_LOOKING = new Set(['admission-not-ready', 'list-unreadable', 'round-failed', 'round-stalled'])

export function sweepSaysFrom(body: unknown): SweepSays {
  const sweep = (body as { sweep?: { on?: unknown; lastProblem?: unknown } } | null)?.sweep
  if (typeof sweep?.on !== 'boolean') return 'unknown'
  return sweep.on && !NOT_LOOKING.has(String(sweep.lastProblem)) ? 'looking' : 'not-looking'
}

const NOTHING_TO_SEND = 'You do not have to send anything to anyone: our server looks for vaults on the chain by itself'
const LOOK_AGAIN = 'Look again here in a little while. If it still says this tomorrow, tell the A-Identity team, because the check may have refused it.'
/** Only a browser that saw the deploy settle holds its hash, and the one reading this does not, even if it sent the deploy: a deploy replaced in the wallet or found at its address leaves none. So it can only be another one. */
const ANOTHER_BROWSER = "if another browser of yours saw this vault's deploy land, open this vault there: it can ask by itself. If none did, tell the A-Identity team."

/**
 * What follows "This vault is not counted on the proof page yet" when this browser holds no hash, so
 * the page cannot ask. Says why the vault is not counted where the page can read it, and says the
 * server is looking only when the server says so: without that nobody is on the way.
 */
export function noHashWords(endDate: EndDate, sweep: SweepSays): string {
  const reason = {
    none: ", because its agent key has no end date. Set one in the Session key box on this vault's page, with its Set the expiry button.",
    passed: ", because its agent key's end date has passed. Set a new one in the Session key box on this vault's page, with its Extend or shorten button.",
    revoked: '. Its agent key is revoked, and that does not stop a vault counting.',
    future: '.',
    unknown: '.',
  }[endDate]
  if (sweep === 'reading') return reason
  if (sweep === 'looking') {
    const then = {
      none: `${NOTHING_TO_SEND}, and it finds this one once it has an end date.`,
      passed: `${NOTHING_TO_SEND}, and it finds this one again within about an hour of the new end date.`,
      revoked: `${NOTHING_TO_SEND}, and it finds this one with its key revoked too. ${LOOK_AGAIN}`,
      future: `${NOTHING_TO_SEND}, and this one has the agent key end date it looks for. ${LOOK_AGAIN}`,
      unknown: `${NOTHING_TO_SEND}, and it finds this one while its agent key has an end date in the future, or is revoked.`,
    }[endDate]
    return `${reason} ${then}`
  }
  const opening = sweep === 'not-looking' ? 'Our server is not looking for vaults on the chain right now, so' : 'We could not find out whether our server is looking for vaults on the chain right now, so'
  return `${reason} ${opening} ${endDate === 'none' || endDate === 'passed' ? 'after that, ' : ''}${ANOTHER_BROWSER}`
}

/** What the server's own list said of a vault when the page last read it. Only an answer can say a vault is not on it. */
export type Listing = 'reading' | 'unreadable' | 'listed' | 'not-listed'

type Answer = { status?: string; reason?: string; retryable?: boolean; reasons?: { reason?: string }[] }

const NO_REASON = 'The check did not say why.'

/**
 * Past the route's 60 second window (rate-budget.ts; a test holds the two together), so a question
 * asked again after a 429 lands in a new one.
 */
export const PAST_RATE_WINDOW_MS = 65_000

/** The HTTP status and JSON body of POST /api/arc/vaults as what the page says. Anything unrecognized is a failure, never counted. */
export function vaultCountFromAnswer(httpStatus: number, body: unknown): VaultCount {
  const a = (body ?? {}) as Answer
  if (httpStatus === 200 && a.status === 'admitted') return { state: 'counted' }
  if (httpStatus === 200 && a.status === 'refused') {
    const reasons = (a.reasons ?? []).map((r) => r.reason).filter((r): r is string => Boolean(r))
    return { state: 'not-counted', reasons: reasons.length ? reasons : [NO_REASON], retryable: a.retryable === true }
  }
  // The limit can be shared with strangers behind the same proxy, so this does not say whose tries they were.
  if (httpStatus === 429) return { state: 'failed', why: 'Our server is taking too many of these checks right now.', waitMs: PAST_RATE_WINDOW_MS }
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

/**
 * The question the deploy flow puts: none before the agent key has its end date, one before the last
 * screen and one on it. A new stage is a new question, so a first one that fails does not use up the last screen's.
 */
export function setupStage(hash: string | null, step: string): string | null {
  return hash && readyToCount(step) ? `${hash}:${step === 'done' ? 'done' : 'before-done'}` : null
}

/**
 * The question the vault's own page puts: none while the key reads no end date, and a new one each
 * time the end date read changes, so an end date set on this page is asked about as soon as it reads
 * back. A date that has passed still asks: the server's answer says what to do, in its own words.
 */
export function vaultPageStage(hash: string | null, sessionKeyExpiry: bigint): string | null {
  return hash && sessionKeyExpiry !== 0n ? `${hash}:end-date:${sessionKeyExpiry}` : null
}

/** A settled deploy this browser saw, kept by vault so that forgetting a setup does not lose its hash. */
export type HeldDeploy = { network: string; vault: string; hash: string }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The hash to ask about a vault on screen: the setup's when it holds this vault, else what this
 * browser kept when a deploy settled. Null when this browser never saw one, which says nothing about
 * whether the vault counts.
 */
export function deployHashFor(testnet: boolean, network: string, vault: string, setup: (DeploySetup & { network: string }) | null, held: readonly HeldDeploy[]): string | null {
  if (testnet) return null
  if (setup?.vault && setup.network === network && same(setup.vault, vault)) {
    const hash = countableDeploy(false, setup)
    if (hash) return hash
  }
  return held.find((d) => d.network === network && same(d.vault, vault))?.hash ?? null
}

/**
 * The vault a link with no vault opens for someone whose browser deployed one: the setup's, else the
 * newest it saw settle. An uncounted vault is on no list, so without this its owner lands on ours
 * and the page never asks about theirs.
 */
export function vaultThisBrowserHolds(setup: { vault?: string | null; network: string } | null, held: readonly HeldDeploy[], network: string): string | null {
  if (setup?.vault && setup.network === network) return setup.vault
  return [...held].reverse().find((d) => d.network === network)?.vault ?? null
}

/** What a list the page already read says of one vault. A list that did not fully load says nothing. */
export function listingOf(known: { vaults: readonly { network: string; address: string; kind: string }[]; partial: string | null; ownerHeldRead?: boolean } | null, network: string, vault: string): Listing {
  if (!known?.ownerHeldRead) return 'reading'
  if (known.vaults.some((v) => v.kind === 'owner-held' && v.network === network && same(v.address, vault))) return 'listed'
  return known.partial ? 'unreadable' : 'not-listed'
}

/** What the page says, from the question it put (if it could) and the list it read. A yes from either stands. */
export function shownCount(hash: string | null, stage: string | null, asked: VaultCount | null, listing: Listing): VaultCount {
  if (listing === 'listed' || asked?.state === 'counted') return { state: 'counted' }
  if (hash) return stage === null ? { state: 'needs-end-date' } : (asked ?? { state: 'checking' })
  if (listing === 'not-listed') return { state: 'no-hash' }
  return listing === 'unreadable' ? { state: 'failed', why: 'Our server could not give its list of counted vaults just now.' } : { state: 'checking' }
}

/**
 * Whether to put the question for this stage now. One question at a time, and a stage reached while
 * one is out stays unasked, so it goes out when that one comes back: a first question that fails must
 * not use up the last screen's.
 */
export function shouldAsk(stage: string, count: VaultCount | null, asked: ReadonlySet<string>, sending: boolean): boolean {
  return !sending && count?.state !== 'counted' && !asked.has(stage)
}

/** Whether time alone could change the answer, so the page may ask once more by itself. A refusal that is a fact about the vault stays. */
export function askAgainByItself(count: VaultCount | null): boolean {
  return count?.state === 'failed' || (count?.state === 'not-counted' && count.retryable)
}

/**
 * The page's reads of its list, of which only the newest may answer: a slow older read must not
 * overwrite a newer one. begin() starts one and returns where its answers go, out() says whether the
 * newest has yet to say anything about owner-held vaults, and stop() drops whatever is still out.
 */
export function listReads<T>(deliver: (answer: T) => void): { begin: () => (answer: T) => void; out: () => boolean; stop: () => void } {
  let round = 0
  let waiting = false
  return {
    begin() {
      const mine = ++round
      waiting = true
      return (answer) => {
        if (mine !== round) return
        waiting = false
        deliver(answer)
      }
    },
    out: () => waiting,
    stop() {
      round++
      waiting = false
    },
  }
}
