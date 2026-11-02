/**
 * Deploy a vault you own, from your own wallet, in three transactions:
 *
 *   1. deploy AgentSpendPolicy with owner = the connected account and the operator the owner
 *      pastes (never preset: whose key the agent uses is the owner's decision),
 *   2. setSessionKeyExpiry(chain time + the lifetime chosen), signed by the owner, so the
 *      operator's authority is bounded in time before the vault holds anything,
 *   3. fund it with a USDC transfer.
 *
 * Funding comes last on purpose: money never sits in a vault whose key is unbounded. Between
 * steps 1 and 2 the page shows a loud banner. The setup is saved in this browser right BEFORE the
 * wallet is asked to deploy (with the address the deploy should create) and again after every
 * hash, so a reload, a closed tab or a phone wallet that approves late resumes where it stopped.
 * A-Identity signs none of it; each step is simulated as the owner, then signed in the owner's
 * wallet, and each counts only once its receipt carries what it should. Where the setup stands is
 * decided by setupStep (tx-rules.ts), where the live vault wins over a record that is only pending.
 * A deploy whose receipt names a contract is never called no vault, even when that contract does not
 * read back as asked: it stays in the setup with its banner and a link to its page.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { track } from '../../../lib/analytics'
import { AGENT_KEY_CAN, AGENT_KEY_CANNOT, CALL_FEE_ABOUT, CONFIRMATIONS, FEES_LINE, IF_A_STEP_FAILS, OWNER_KEY_LINE, REVIEW_LINE, WALLET_GONE, WHAT_IS_A_VAULT, WRONG_ACCOUNT } from '../../../lib/arc/deploy-copy'
import { loadSetup, type SetupState, type TxRecord } from '../../../lib/arc/pending'
import { FUND_RISK } from '../../../lib/arc/ours'
import { deployReadback } from '../../../lib/arc/receipt'
import { deployEnd, fundingUnresolved, liveOf, predictedVault, setupDrift, setupStep, vaultToLookFor, withRecord } from '../../../lib/arc/tx-rules'
import {
  ARC_CHAINS,
  arcChainFor,
  networkName,
  networkWord,
  readUsdcFacts,
  readVault,
  usdcOf,
  type VaultSnapshot,
} from '../../../lib/arc/vault-read'
import {
  DEFAULT_AUTO_APPROVE,
  DEFAULT_DAILY_CAP,
  DEFAULT_FUNDING,
  DEFAULT_SESSION_SECONDS,
  SESSION_CHOICES,
  aboveSoftWarn,
  capsRefusal,
  capsWarning,
  formatUnitsExact,
  operatorRefusal,
  parseUnitsExact,
  sameAddress,
  sessionSecondsRefusal,
} from '../../../lib/arc/vault-rules'
import {
  STEP_LABEL,
  TxStop,
  failureOf,
  prepareDeploy,
  prepareOwnerCall,
  preparedStale,
  sendPrepared,
  type PreparedTx,
  type TxStep,
} from '../../../lib/arc/vault-write'
import { Button } from '../../ui/button'
import { Chip, Mono } from '../stellar/bits'
import FailureNotice from './FailureNotice'
import FundForm from './FundForm'
import PreparedView from './PreparedView'
import TxReceipt from './TxReceipt'
import type { ArcSetupStore } from './useArcSetup'
import type { ArcWalletState } from './useArcWallet'
import { recordOf, useArcTx } from './useArcTx'

const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

/** While a step waits on the chain (a pending expiry or funding), the vault is read again this often. */
const REREAD_MS = 10_000
/** While a deploy has no hash, the address it should create is looked at this often. */
const LOOK_MS = 15_000
/** How long a wallet that has not answered is waited on before the page says what else it is doing. */
const WALLET_SLOW_MS = 30_000
/** After a failure with the setup kept: the failure's own "try again" is not on offer here. */
const SENDING_NEXT =
  "Check your wallet's activity. If this page finds the vault at its address it carries on from there. If your wallet shows nothing was sent, use the start again button below."

const STEPS: { key: string; label: string }[] = CONFIRMATIONS.map((c, i) => ({ key: String(i), label: `${i + 1}. ${c.title}` }))

/** Why nothing can be signed right now, and what to do. Shown wherever a step needs the wallet. */
function WalletGap({ wrongAccount }: { wrongAccount?: boolean }) {
  return (
    <p role="alert" className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground">
      {wrongAccount ? WRONG_ACCOUNT : WALLET_GONE}
    </p>
  )
}

export default function DeployFlow({
  chain: pageChain,
  onChainChange,
  wallet,
  store,
  onOpenVault,
  onClose,
}: {
  chain: Chain
  onChainChange: (caip2: string) => void
  wallet: ArcWalletState
  /** The browser's one setup slot, shared with the vault page and every tab. */
  store: ArcSetupStore
  onOpenVault: (network: string, address: string) => void
  onClose: () => void
}) {
  const { setup, patch: storePatch, start: storeStart, forget: storeForget } = store
  const setupChain = setup ? arcChainFor(setup.network) : null
  const chain = setupChain ?? pageChain
  const usdc = usdcOf(chain)
  const decimals = usdc?.decimals ?? 6
  const [operator, setOperator] = useState('')
  const [cap, setCap] = useState(DEFAULT_DAILY_CAP)
  const [ceiling, setCeiling] = useState(DEFAULT_AUTO_APPROVE)
  const [seconds, setSeconds] = useState(DEFAULT_SESSION_SECONDS)
  const [funding, setFunding] = useState(DEFAULT_FUNDING)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedTx | null>(null)
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null)
  const [looked, setLooked] = useState<{ at: string; found: boolean; why: string | null } | null>(null)
  const [refundConfirmed, setRefundConfirmed] = useState(false)
  const { busy, step: txStep, failure, setFailure, run, release } = useArcTx()
  // A wallet that never answers: its promise can stay open for good, so the wait says so.
  const [walletSlow, setWalletSlow] = useState(false)

  // A review is only ever of the network now shown: one prepared on another network (the select
  // changed, or the link did) is dropped rather than signed under this network's banner.
  const review = prepared && prepared.chain.caip2 === chain.caip2 ? prepared : null
  useEffect(() => {
    if (prepared && prepared.chain.caip2 !== chain.caip2) setPrepared(null)
  }, [prepared, chain.caip2])

  const step = setupStep(setup, review !== null, snapshot)
  const account = wallet.account
  const provider = wallet.wallet?.provider ?? null
  const walletGone = !provider || !account
  const ownerMismatch = Boolean(setup && account && !sameAddress(account, setup.owner))
  const startedAt = setup?.startedAt ?? null
  // Only ever the current setup's own vault: a read of a vault another tab has since moved on from
  // must not be what an expiry or a funding is built from.
  const liveVault = setup ? liveOf(setup, snapshot) : null
  // How a deploy ended with no vault to continue with. A contract its receipt named is kept in the
  // setup, and is never offered a clean slate: it belongs to the owner and has no expiry yet.
  const ended = deployEnd(setup)
  const created = ended?.kind === 'contract' ? ended.address : null

  const patch = useCallback(
    (change: (s: SetupState) => SetupState) => {
      if (startedAt) storePatch(startedAt, change)
    },
    [storePatch, startedAt],
  )

  // A setup is known by its startedAt. Whatever was read for the last one is not about this one.
  useEffect(() => {
    setSnapshot(null)
    setSnapshotNote(null)
    setRefundConfirmed(false)
  }, [startedAt])

  /**
   * The setup on screen, checked against what the browser holds right now. Null when they agree.
   * A disagreement is said here, not by the form: catching this tab up unmounts that form.
   */
  const driftNow = useCallback(() => {
    const drift = setupDrift(setup, loadSetup(), snapshot)
    if (drift) {
      setInvalid(drift)
      // Catch this tab up even if the other tab's storage event has not arrived.
      if (startedAt) storePatch(startedAt, (s) => s)
    }
    return drift
  }, [setup, snapshot, startedAt, storePatch])

  // A wallet that came back makes "your wallet is not connected" untrue.
  useEffect(() => {
    if (!walletGone) setInvalid((v) => (v === WALLET_GONE ? null : v))
  }, [walletGone])

  // The vault, read back whenever the setup has one and is between steps.
  const readAddress = setup?.vault ?? created
  const readBack = useCallback(async () => {
    if (!readAddress) return
    const r = await readVault(chain, readAddress)
    if (r.ok) {
      setSnapshot(r.data)
      setSnapshotNote(null)
    } else {
      setSnapshotNote(`The vault could not be read just now (${r.failure.reason}). Its state is shown once a read succeeds.`)
    }
  }, [chain, readAddress])

  useEffect(() => {
    if (step !== 'expiry' && step !== 'expiry-pending' && step !== 'fund' && step !== 'fund-pending' && step !== 'done' && !created) return
    void readBack()
    // A pending step is decided by the chain as much as by its receipt: a transaction that will
    // never land must not hold the setup, and a value set by any other means counts.
    if (step !== 'expiry-pending' && step !== 'fund-pending') return
    const t = setInterval(() => void readBack(), REREAD_MS)
    return () => clearInterval(t)
  }, [step, created, readBack])

  // A deploy with no hash back, or one no longer tracked, can still create the vault: look for it
  // where it should be, and take it only if it reads back exactly as this setup asked.
  const target = useMemo(() => vaultToLookFor(setup), [setup])
  const lookForVault = useCallback(async () => {
    if (!target) return
    const back = await deployReadback(chain, target.predicted, target.deployArgs)
    setLooked({ at: new Date().toISOString(), found: back.status === 'ok', why: back.why })
    if (back.status === 'ok') {
      patch((s) => (vaultToLookFor(s)?.predicted === target.predicted ? { ...s, vault: target.predicted } : s))
      // The wallet's promise may never settle (a phone browser suspended while the wallet app was
      // open), and the vault is here, so the page moves on rather than wait on it.
      release('deploy')
      setPrepared(null)
      track('arc_vault_deploy', { network: networkWord(chain), outcome: 'found_without_receipt' })
    }
  }, [chain, patch, target, release])

  // From the moment the wallet is asked: `target` exists only once the setup holds that intent, and
  // the hash may never come back to this page while the vault lands.
  useEffect(() => {
    if (!target) return
    void lookForVault()
    const t = setInterval(() => void lookForVault(), LOOK_MS)
    return () => clearInterval(t)
  }, [target, lookForVault])

  useEffect(() => {
    setWalletSlow(false)
    if (busy !== 'deploy' || !target) return
    const t = setTimeout(() => setWalletSlow(true), WALLET_SLOW_MS)
    return () => clearTimeout(t)
  }, [busy, target])

  const updateRecord = useCallback(
    (field: 'deploy' | 'expiryTx' | 'fundTx', r: TxRecord) => patch((s) => withRecord(s, field, r)),
    [patch],
  )

  const onFinal = useCallback(
    (field: 'deploy' | 'expiryTx' | 'fundTx', r: TxRecord) => {
      if (field === 'deploy') track('arc_vault_deploy', { network: networkWord(chain), outcome: r.outcome })
      else track('arc_vault_owner_action', { network: networkWord(chain), action: field === 'expiryTx' ? 'expiry' : 'fund', outcome: r.outcome })
      void readBack()
    },
    [chain, readBack],
  )

  const parsed = useMemo(() => {
    const c = parseUnitsExact(cap, decimals)
    const a = parseUnitsExact(ceiling, decimals)
    const f = funding.trim() === '' ? 0n : parseUnitsExact(funding, decimals)
    return { c, a, f }
  }, [cap, ceiling, funding, decimals])

  const submitReview = (e: FormEvent) => {
    e.preventDefault()
    setFailure(null)
    if (!account || !provider) {
      setInvalid('Connect your wallet in the strip above first: the connected account becomes the vault owner.')
      return
    }
    if (!usdc) {
      setInvalid(`${chain.name} has no USDC in the registry.`)
      return
    }
    const bad =
      operatorRefusal(operator, { owner: account, usdc: usdc.address }) ??
      capsRefusal(parsed.c, parsed.a, decimals) ??
      sessionSecondsRefusal(seconds) ??
      (parsed.f === null ? `Enter the funding as an amount with at most ${decimals} decimal places, or 0 to fund later.` : null)
    if (bad || parsed.c === null || parsed.a === null || parsed.f === null) {
      setInvalid(bad ?? 'Check the form.')
      return
    }
    setInvalid(null)
    const input = { owner: account, operator: operator.trim(), dailyCap: parsed.c, autoApproveMax: parsed.a, funding: parsed.f }
    const on = chain
    void run('prepare', async (onStep) => {
      onStep('checking')
      const facts = await readUsdcFacts(on)
      if (!facts.ok) throw new TxStop({ code: 'refused', message: facts.reason })
      onStep('simulating')
      const p = await prepareDeploy(on, input)
      setPrepared(p)
      return p
    })
  }

  const confirmDeploy = () => {
    if (!review) return
    if (!provider || !account) {
      setInvalid(WALLET_GONE)
      return
    }
    if (parsed.c === null || parsed.a === null || parsed.f === null) {
      setPrepared(null)
      setInvalid('The amounts in the form are no longer valid. Check them, then review the deploy again.')
      return
    }
    // The owner is the one the review showed. A wallet that changed account since then gets the
    // review again rather than a deploy for an owner nobody looked at.
    if (!sameAddress(account, review.from)) {
      setPrepared(null)
      setInvalid(`Your wallet's account changed since the review (it was ${review.from}). Review the deploy again.`)
      return
    }
    // One setup per browser: a second one is never started over an unfinished one (another tab's included).
    if (setup) {
      setInvalid('This browser already holds a vault setup. Finish it, or forget it below, before deploying another vault.')
      return
    }
    // Everything about the deploy comes from the review, its network above all: the page's
    // network select may have moved since, and a deploy is tracked on the network it was sent to.
    const on = review.chain
    const onUsdc = usdcOf(on)
    if (!onUsdc) {
      setInvalid(`${on.name} has no USDC in the registry, so no vault is deployed there.`)
      return
    }
    setInvalid(null)
    const input = { owner: review.from, operator: operator.trim(), dailyCap: parsed.c, autoApproveMax: parsed.a, funding: parsed.f }
    const deployArgs = { owner: review.from, operator: input.operator, usdc: onUsdc.address, dailyCap: input.dailyCap, autoApproveMax: input.autoApproveMax }
    void run('deploy', async (onStep) => {
      let p = review
      if (preparedStale(p)) {
        onStep('simulating')
        p = await prepareDeploy(on, input)
      }
      if (p.nonce === undefined || !p.predicted) throw new TxStop({ code: 'refused', message: 'The prepared deploy has no predicted address. Nothing was sent; review it again.' })
      const now = new Date().toISOString()
      const base: SetupState = {
        v: 1,
        network: on.caip2,
        owner: p.from,
        operator: input.operator,
        dailyCap: input.dailyCap,
        autoApproveMax: input.autoApproveMax,
        sessionSeconds: seconds,
        funding: input.funding,
        startedAt: now,
        intent: { from: p.from, nonce: p.nonce, predicted: p.predicted, deployArgs, at: now },
      }
      // Saved right before the wallet is asked, so a hash that never comes back still leaves the
      // address to look at. Refused (and nothing sent) if another tab started a setup meanwhile.
      let handedOff = false
      const handOff = (s: TxStep) => {
        if (s === 'wallet') {
          if (!storeStart(base))
            throw new TxStop({ code: 'refused', message: 'Another vault setup was started in this browser. Nothing was sent; finish or forget that one first.' })
          handedOff = true
        }
        onStep(s)
      }
      let hash: Awaited<ReturnType<typeof sendPrepared>>
      try {
        hash = await sendPrepared(provider, p, handOff)
      } catch (e) {
        // Declined in the wallet: nothing was sent, so nothing is kept. Any other stop after the
        // hand-off keeps the setup: the wallet may still send it, and the page looks for the vault.
        if (handedOff && failureOf(e).code === 'rejected') storeForget(base.startedAt)
        throw e
      }
      const record: TxRecord = { ...recordOf(p, hash, null), deployArgs }
      // The hash is what must never be lost: if the slot no longer holds this setup (forgotten in
      // another tab while the wallet was open), it is started again with the hash in it.
      if (!storePatch(base.startedAt, (s) => ({ ...s, deploy: record }))) storeStart({ ...base, deploy: record })
      setPrepared(null)
      track('arc_vault_deploy', { network: networkWord(on), outcome: 'submitted' })
      return hash
    })
  }

  const setExpiry = () => {
    if (!setup) return
    if (!provider) {
      setInvalid(WALLET_GONE)
      return
    }
    setFailure(null)
    // Read the slot before anything is prepared: this tab may be showing a setup that has moved on.
    if (driftNow() || !liveVault) return
    setInvalid(null)
    const vault = liveVault
    void run('expiry', async (onStep) => {
      onStep('simulating')
      const p = await prepareOwnerCall(chain, vault, { fn: 'extend', seconds: setup.sessionSeconds })
      // Preparing takes a moment, and the other tab keeps running.
      if (driftNow()) return null
      const hash = await sendPrepared(provider, p, onStep)
      const record: TxRecord = { ...recordOf(p, hash, vault.address), action: 'expiry' }
      patch((s) => ({ ...s, expiryTx: record }))
      track('arc_vault_owner_action', { network: networkWord(chain), action: 'expiry', outcome: 'submitted' })
      return hash
    })
  }

  const forget = () => {
    if (startedAt) storeForget(startedAt)
    setPrepared(null)
    setSnapshot(null)
    setLooked(null)
    setRefundConfirmed(false)
    setFailure(null)
    setInvalid(null)
  }

  const stepIndex =
    step === 'form' || step === 'review' || step === 'sending' || step === 'deploying' || step === 'deploy-failed'
      ? 0
      : step === 'expiry' || step === 'expiry-pending'
        ? 1
        : step === 'done'
          ? 3
          : 2
  const label = busy ? `${txStep ? STEP_LABEL[txStep] : 'Working'}...` : null
  const predicted = setup ? predictedVault(setup) : null

  return (
    <section aria-label="Deploy a vault you own" className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Deploy a vault you own</h2>
          <p className="mt-1 max-w-2xl text-sm text-foreground/75">{WHAT_IS_A_VAULT}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to vaults
        </Button>
      </div>

      <ol className="grid gap-1.5 sm:grid-cols-3" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
              i < stepIndex ? 'border-ok/30 bg-ok/[0.06] text-foreground' : i === stepIndex ? 'border-accent bg-accent/[0.06] text-foreground' : 'border-border text-foreground/55'
            }`}
            aria-current={i === stepIndex ? 'step' : undefined}
          >
            {i < stepIndex && <CheckCircle2 size={12} className="mr-1 inline text-ok" aria-hidden="true" />}
            {s.label}
          </li>
        ))}
      </ol>

      {setup && !setupChain && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          The setup saved in this browser names the network "{setup.network}", which this page does not know. Forget it below to start again.
        </p>
      )}

      {!chain.testnet ? (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
          <span className="font-semibold text-foreground">{networkName(chain)}: real USDC.</span> {REVIEW_LINE} Start small: the defaults are a 1
          USDC daily limit and a 0.25 USDC largest payment on purpose.
        </p>
      ) : (
        <p className="rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground/75">
          <span className="font-semibold text-foreground">{networkName(chain)}: a practice run.</span> It uses free test USDC, from
          faucet.circle.com, so nothing here costs real money. A vault here is not an Arc Mainnet vault and does not count for anything. {REVIEW_LINE}
        </p>
      )}

      {(step === 'form' || step === 'review') && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-background/60 p-4 text-xs text-foreground/80">
            <h3 className="text-sm font-semibold text-foreground">Your wallet will ask you to confirm up to three times</h3>
            <ol className="mt-2 space-y-2">
              {CONFIRMATIONS.map((c, i) => (
                <li key={c.title}>
                  <span className="font-semibold text-foreground">
                    {i + 1}. {c.title}.
                  </span>{' '}
                  {c.does} <span className="font-semibold text-foreground">{c.cost}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2">{FEES_LINE}</p>
          </div>
          <div className="rounded-xl border border-border bg-background/60 p-4 text-xs text-foreground/80">
            <h3 className="text-sm font-semibold text-foreground">Who holds which key</h3>
            <p className="mt-2">
              <span className="font-semibold text-foreground">You: </span>
              {OWNER_KEY_LINE}
            </p>
            <p className="mt-2">
              <span className="font-semibold text-foreground">Your agent: </span>
              {AGENT_KEY_CAN} {AGENT_KEY_CANNOT}
            </p>
          </div>
        </div>
      )}

      {ownerMismatch && setup && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          This setup belongs to <Mono>{setup.owner}</Mono>, but your wallet is on <Mono>{account}</Mono>. Pick the owner account in your wallet
          to continue; nothing is sent from any other account.
        </p>
      )}

      {/* Step 1: the form, then the review. */}
      {step === 'form' && (
        <form onSubmit={submitReview} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="deploy-network" className="text-[11px] font-semibold text-foreground/65">
              Network
            </label>
            <select
              id="deploy-network"
              value={chain.caip2}
              onChange={(e) => onChainChange(e.target.value)}
              disabled={busy !== null}
              className={INPUT}
            >
              {ARC_CHAINS.map((c) => (
                <option key={c.caip2} value={c.caip2}>
                  {c.testnet ? 'Arc testnet: free test USDC, for a practice run' : 'Arc Mainnet: real USDC (the default)'}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <div className="text-[11px] font-semibold text-foreground/65">Owner</div>
            <div className="mt-1 text-sm text-foreground">
              {account ? (
                <>
                  <Mono>{account}</Mono> <span className="text-xs text-foreground/60">(your connected account: the only one that can freeze the vault, change its limits, take USDC out or replace the agent key)</span>
                </>
              ) : (
                <span className="text-foreground/70">Connect your wallet at the top of this page. The account you connect becomes the owner.</span>
              )}
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="deploy-operator" className="text-[11px] font-semibold text-foreground/65">
              Agent key address (the contract calls it the operator)
            </label>
            <input
              id="deploy-operator"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="0x... (paste the agent's address; it must not be your owner account)"
              className={`${INPUT} font-mono text-xs`}
            />
            <p className="mt-1 text-[11px] text-foreground/60">Get this from whoever runs your agent. It is an address, not a secret. Never paste a private key here.</p>
          </div>
          <div>
            <label htmlFor="deploy-cap" className="text-[11px] font-semibold text-foreground/65">
              Daily limit (USDC, above 0)
            </label>
            <input id="deploy-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className={INPUT} />
            <p className="mt-1 text-[11px] text-foreground/60">The most the agent can spend in one day. The day resets at 00:00 UTC.</p>
          </div>
          <div>
            <label htmlFor="deploy-ceiling" className="text-[11px] font-semibold text-foreground/65">
              Largest single payment (USDC, above 0)
            </label>
            <input id="deploy-ceiling" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} className={INPUT} />
            <p className="mt-1 text-[11px] text-foreground/60">The contract refuses any agent payment above this. You can still pay more yourself.</p>
          </div>
          <div>
            <label htmlFor="deploy-session" className="text-[11px] font-semibold text-foreground/65">
              The agent's key ends after (counted from step 2)
            </label>
            <select id="deploy-session" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className={INPUT}>
              {SESSION_CHOICES.map((c) => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-foreground/60">You can extend it or end it early later, from the vault's page.</p>
          </div>
          <div>
            <label htmlFor="deploy-funding" className="text-[11px] font-semibold text-foreground/65">
              USDC to put in at step 3 (0 to add it later)
            </label>
            <input id="deploy-funding" inputMode="decimal" value={funding} onChange={(e) => setFunding(e.target.value)} className={INPUT} />
            <p className="mt-1 text-[11px] text-foreground/60">Only you can take it back out. Your agent can spend it within your limits.</p>
          </div>
          {parsed.c !== null && parsed.a !== null && parsed.c > 0n && parsed.a > 0n && capsWarning(parsed.c, parsed.a) && (
            <p className="text-xs text-foreground/75 sm:col-span-2">{capsWarning(parsed.c, parsed.a)}</p>
          )}
          {parsed.f !== null && aboveSoftWarn(parsed.f, decimals) && (
            <p className="text-xs font-semibold text-warn sm:col-span-2">
              More than 10 USDC. The limits cap what the agent can spend per day, not what the vault holds. Put in only what you are ready to
              lose to a bug in a contract with no outside audit.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy !== null}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {label ?? 'Review the deploy'}
            </Button>
            <span className="text-xs text-foreground/60">This does a free practice run of the deploy and checks you have enough USDC for the fees. Nothing is signed or sent.</span>
          </div>
        </form>
      )}

      {step === 'review' && review && (
        <div className="space-y-3">
          <PreparedView p={review} decimals={decimals} title="Review: create your vault (confirmation 1 of 3)" />
          <div className="rounded-xl border border-border bg-background/60 p-4 text-xs text-foreground/80">
            <div className="font-semibold text-foreground">Then, once your vault exists:</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Confirmation 2: the agent's key ends {SESSION_CHOICES.find((c) => c.seconds === seconds)?.label ?? `${seconds} seconds`} after this step lands.
                Until it lands, the agent's key has no time bound, and the page says so.
              </li>
              <li>
                Confirmation 3: {parsed.f && parsed.f > 0n ? `${formatUnitsExact(parsed.f, decimals)} USDC goes from your account into the vault.` : 'none, because you chose to add USDC later.'}
              </li>
              <li>
                Each of those costs {CALL_FEE_ABOUT} in network fees while Arc's fee is at its usual level. Your balance was checked to cover all
                three, plus the USDC you put in.
              </li>
            </ul>
          </div>
          {walletGone && <WalletGap />}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={confirmDeploy} disabled={busy !== null || ownerMismatch || walletGone}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {label ?? 'Deploy from my wallet'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPrepared(null)
                setFailure(null)
              }}
              disabled={busy !== null}
            >
              <ArrowLeft size={14} aria-hidden="true" /> Edit
            </Button>
          </div>
        </div>
      )}

      {/* Step 1, handed to the wallet with no hash back yet. */}
      {step === 'sending' && setup?.intent && (
        <div role="status" className="rounded-2xl border border-warn/30 bg-warn/10 p-4 text-sm text-foreground">
          {busy === 'deploy' ? (
            <>
              <div className="flex items-center gap-2 font-semibold">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Waiting for you to confirm in your wallet.
              </div>
              {walletSlow && (
                <>
                  <div className="mt-1 text-xs text-foreground/80">
                    A phone wallet can send it and never tell this page. This page looks for your vault at <Mono>{setup.intent.predicted}</Mono> every{' '}
                    {LOOK_MS / 1000} seconds and carries on when it is there. Reloading this page is safe: the setup is kept in this browser.
                    {looked && !looked.found && ` Last look at ${new Date(looked.at).toLocaleTimeString()}: no vault there yet${looked.why ? ` (${looked.why})` : ''}.`}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void lookForVault()}>
                      Look again now
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="font-semibold">Your wallet was asked to create this vault, and this page has not heard back.</div>
              <div className="mt-1 text-xs text-foreground/80">
                If your wallet sent it (a phone wallet can approve after this tab closed), the vault appears at <Mono>{setup.intent.predicted}</Mono>,
                the address your account's next transaction creates, and this page picks it up from there. It looks every {LOOK_MS / 1000} seconds.
                {looked && !looked.found && ` Last look at ${new Date(looked.at).toLocaleTimeString()}: no vault there yet${looked.why ? ` (${looked.why})` : ''}.`}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void lookForVault()}>
                  Look again now
                </Button>
                <Button size="sm" variant="outline" onClick={forget}>
                  My wallet shows nothing was sent: start again
                </Button>
              </div>
              <div className="mt-2 text-xs text-foreground/70">
                Use that only if your wallet's activity shows no such transaction, pending included. One still in its queue can land later and create a vault
                whose key has no time bound.
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 1, in flight or stopped. */}
      {setup?.deploy && (step === 'deploying' || step === 'deploy-failed') && (
        <TxReceipt record={setup.deploy} onUpdate={(r) => updateRecord('deploy', r)} onSettled={(r) => onFinal('deploy', r)} />
      )}
      {step === 'deploy-failed' && setup?.deploy && created && (
        <div className="space-y-2">
          {snapshot && sameAddress(snapshot.address, created) && snapshot.sessionKeyExpiry !== 0n ? (
            <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
              <span className="font-semibold text-foreground">A contract came out of this deploy, and it reads a session key expiry.</span> Contract{' '}
              <Mono>{created}</Mono>. It could not be confirmed as what this setup asked, so the setup stops here. Its page shows what it really is.
            </p>
          ) : (
            <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/[0.08] p-4 text-sm">
              <div className="flex items-start gap-2">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="font-semibold text-foreground">A contract came out of this deploy, and its agent key has no time bound yet.</div>
                  <div className="mt-1 text-foreground/80">
                    Contract <Mono>{created}</Mono>. It could not be confirmed as what this setup asked, so the setup stops here and funds nothing. Its
                    page shows what it really is: if it runs this page's build and you own it, set an expiry there, and send it no USDC before you
                    have looked.
                  </div>
                  {snapshotNote && <div className="mt-1 text-xs text-foreground/70">{snapshotNote}</div>}
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => onOpenVault(setup.network, created)}>
              Open its vault page
            </Button>
            <Button size="sm" variant="outline" onClick={forget}>
              Forget this setup
            </Button>
          </div>
          <p className="text-[11px] text-foreground/55">Forgetting the setup leaves the contract on chain, and this browser stops warning about it.</p>
        </div>
      )}
      {step === 'deploy-failed' && setup?.deploy && !created && (
        <div className="space-y-2">
          {ended?.kind === 'untracked' ? (
            <p className="text-xs text-foreground/80">
              This page stopped tracking the deploy without seeing a receipt. If it lands later, it creates a vault
              {predicted ? (
                <>
                  {' '}
                  at <Mono>{predicted}</Mono>
                </>
              ) : null}{' '}
              whose agent key has no time bound until you set one. While this view is open it looks there every {LOOK_MS / 1000} seconds, and
              picks the vault up at step 2 if it appears. Look at that address before you deploy again.
            </p>
          ) : ended?.kind === 'replaced' ? (
            <p className="text-xs text-foreground/80">
              This transaction can no longer land, and no vault that reads back as asked came from it. This page cannot tell what replaced it:
              check your wallet's activity before you deploy again.
            </p>
          ) : (
            <p className="text-xs text-foreground/75">No vault came out of this deploy, so there is nothing to bound or fund. Start again when ready.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(ended?.kind === 'untracked' || ended?.kind === 'replaced') && predicted && (
              <Button size="sm" variant="outline" onClick={() => onOpenVault(setup.network, predicted)}>
                Look at that address
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={forget}>
              Start again
            </Button>
          </div>
        </div>
      )}

      {/* Step 2. The loud part: the vault exists and its key has no time bound until this lands. */}
      {setup?.vault && (step === 'expiry' || step === 'expiry-pending') && (
        <div className="space-y-3">
          {setup.deploy && <TxReceipt record={setup.deploy} onUpdate={(r) => updateRecord('deploy', r)} />}
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/[0.08] p-4 text-sm">
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0">
                <div className="font-semibold text-foreground">Your vault exists, but its agent key has no time bound yet.</div>
                <div className="mt-1 text-foreground/80">
                  Vault <Mono>{setup.vault}</Mono>. Until confirmation 2 lands, the agent's key can pay within your limits with no end date. Set the
                  end date now. No USDC goes in before it. This moves no USDC and costs {CALL_FEE_ABOUT} in network fees.
                </div>
              </div>
            </div>
          </div>
          {setup.expiryTx && (
            <TxReceipt record={setup.expiryTx} onUpdate={(r) => updateRecord('expiryTx', r)} onSettled={(r) => onFinal('expiryTx', r)} />
          )}
          {step === 'expiry-pending' && (
            <p className="text-xs text-foreground/65">
              The vault is read again every {REREAD_MS / 1000} seconds as well: once its expiry reads set, this step is done, whatever the receipt
              above says.
            </p>
          )}
          {step === 'expiry' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={setExpiry} disabled={busy !== null || !liveVault || ownerMismatch || walletGone}>
                {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {label ??
                  `Set it now: valid for ${SESSION_CHOICES.find((c) => c.seconds === setup.sessionSeconds)?.label ?? `${setup.sessionSeconds} seconds`}`}
              </Button>
              {!liveVault && <span className="text-xs text-foreground/60">{snapshotNote ?? 'Reading the new vault back...'}</span>}
              {(walletGone || ownerMismatch) && <div className="w-full"><WalletGap wrongAccount={!walletGone} /></div>}
            </div>
          )}
        </div>
      )}

      {/* Step 3. */}
      {setup?.vault && (step === 'fund' || step === 'fund-pending') && (
        <div className="space-y-3">
          {setup.expiryTx && <TxReceipt record={setup.expiryTx} onUpdate={(r) => updateRecord('expiryTx', r)} />}
          {setup.fundTx && (
            <TxReceipt record={setup.fundTx} onUpdate={(r) => updateRecord('fundTx', r)} onSettled={(r) => onFinal('fundTx', r)} />
          )}
          {step === 'fund-pending' && (
            <p className="text-xs text-foreground/65">
              The vault is read again every {REREAD_MS / 1000} seconds as well: once its balance holds the funding, this step is done, whatever
              the receipt above says.
            </p>
          )}
          {step === 'fund' && fundingUnresolved(setup.fundTx) && !refundConfirmed && (
            <div role="alert" className="rounded-xl border border-warn/30 bg-warn/10 p-4 text-xs text-foreground/85">
              <div className="font-semibold text-foreground">This page does not know what happened to the first USDC transfer.</div>
              <div className="mt-1">
                {setup.fundTx?.outcome === 'replaced' || setup.fundTx?.likelyReplaced
                  ? 'Your wallet appears to have sent another transaction in its place: if that was a speed-up, the USDC may already be in the vault.'
                  : 'You stopped tracking it with no receipt seen: it may still land.'}{' '}
                The vault reads {liveVault ? `${formatUnitsExact(liveVault.balance, decimals)} USDC` : 'as not yet read'}. Check your wallet's activity
                before sending USDC again.
              </div>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setRefundConfirmed(true)}>
                I checked: send USDC again
              </Button>
            </div>
          )}
          {step === 'fund' && liveVault && provider && account && !ownerMismatch && (!fundingUnresolved(setup.fundTx) || refundConfirmed) && (
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <h3 className="text-sm font-semibold text-foreground">Confirmation 3 of 3: put USDC in the vault</h3>
              <p className="mt-1 text-xs text-foreground/70">
                This sends USDC from your account to <Mono>{setup.vault}</Mono>, plus a network fee of {CALL_FEE_ABOUT}. The agent's key has an end
                date now. {FUND_RISK} {REVIEW_LINE}
              </p>
              <div className="mt-3">
                <FundForm
                  key={`${setup.startedAt}:${setup.vault}`}
                  chain={chain}
                  vault={liveVault}
                  provider={provider}
                  account={account}
                  held={false}
                  initial={formatUnitsExact(setup.funding, decimals)}
                  stillCurrent={() => !driftNow()}
                  onSubmitted={(r) => {
                    setRefundConfirmed(false)
                    patch((s) => ({ ...s, fundTx: { ...r, action: 'fund' } }))
                  }}
                />
              </div>
            </div>
          )}
          {step === 'fund' && (walletGone || ownerMismatch) && <WalletGap wrongAccount={!walletGone} />}
          {step === 'fund' && !liveVault && <p className="text-xs text-foreground/60">{snapshotNote ?? 'Reading the vault back...'}</p>}
          {/* Needs no wallet and sends nothing, so it stays on offer whatever else is missing. */}
          {step === 'fund' && (
            <button
              type="button"
              onClick={() => patch((s) => ({ ...s, fundSkipped: true }))}
              className="text-xs font-semibold text-accent underline underline-offset-2"
            >
              Skip this for now: add USDC later from the vault's page
            </button>
          )}
        </div>
      )}

      {setup?.vault && step === 'done' && (
        <div className="space-y-3">
          {setup.fundTx && <TxReceipt record={setup.fundTx} onUpdate={(r) => updateRecord('fundTx', r)} />}
          <div className="rounded-2xl border border-ok/30 bg-ok/[0.06] p-4 text-sm">
            <div className="font-semibold text-foreground">Your vault is set up.</div>
            <div className="mt-1 text-foreground/80">
              <Mono>{setup.vault}</Mono> on {networkName(chain)}, owned by <Mono>{setup.owner}</Mono>
              {liveVault ? (
                <>
                  , agent key {liveVault.sessionKeyExpiry === 0n ? <Chip tone="danger">no time bound</Chip> : 'with an end date'}, balance{' '}
                  {formatUnitsExact(liveVault.balance, decimals)} USDC.
                </>
              ) : (
                '.'
              )}
              {setup.fundSkipped && ' You skipped putting USDC in: send it to the vault from its page when ready.'}
            </div>
            <div className="mt-1 text-foreground/80">
              Next, give your agent this vault's address. You can freeze the vault, change its limits or take USDC out at any time from its page.
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => onOpenVault(setup.network, setup.vault as string)}>
                Open the vault
              </Button>
              <Button size="sm" variant="outline" onClick={forget}>
                Set up another vault
              </Button>
            </div>
          </div>
        </div>
      )}

      {invalid && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && <FailureNotice failure={failure} next={step === 'sending' ? SENDING_NEXT : undefined} />}

      <details className="rounded-xl border border-border bg-background/60 p-3 text-xs text-foreground/80">
        <summary className="cursor-pointer font-semibold text-foreground">What to do if a step fails</summary>
        <ul className="mt-2 space-y-1.5">
          {IF_A_STEP_FAILS.map((f) => (
            <li key={f.when}>
              <span className="font-semibold text-foreground">{f.when}: </span>
              {f.then}
            </li>
          ))}
        </ul>
      </details>

      {setup && step !== 'done' && step !== 'deploy-failed' && (
        <p className="text-[11px] text-foreground/55">
          This setup is saved in this browser and shared by its tabs, so a reload resumes it. Forgetting it cancels nothing in your wallet
          {predicted ? (
            <>
              {' '}and leaves anything already on chain where it is
              {setup.vault ? (
                <>
                  : the vault at <Mono>{predicted}</Mono> stays, and if its key has no time bound, set one from its page
                </>
              ) : (
                <>
                  : a deploy still in your wallet's queue can land later and create a vault at <Mono>{predicted}</Mono> whose key has no time bound
                </>
              )}
            </>
          ) : null}
          .{' '}
          <button type="button" onClick={forget} disabled={busy !== null} className="font-semibold text-accent underline underline-offset-2 disabled:opacity-50">
            Forget this setup
          </button>
        </p>
      )}
    </section>
  )
}
