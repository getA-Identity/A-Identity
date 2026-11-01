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
 * steps 1 and 2 the page shows a loud banner, and the setup is saved in this browser after
 * every hash, so a reload or a closed tab resumes exactly where it stopped. A-Identity signs
 * none of it; each step is simulated as the owner, then signed in the owner's wallet, and each
 * counts only once its receipt carries what it should.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { track } from '../../../lib/analytics'
import { loadSetup, saveSetup, type SetupState, type TxRecord } from '../../../lib/arc/pending'
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
  prepareDeploy,
  prepareOwnerCall,
  preparedStale,
  sendPrepared,
  type PreparedTx,
} from '../../../lib/arc/vault-write'
import { Button } from '../../ui/button'
import { Chip, Mono } from '../stellar/bits'
import FailureNotice from './FailureNotice'
import FundForm from './FundForm'
import PreparedView from './PreparedView'
import TxReceipt from './TxReceipt'
import type { ArcWalletState } from './useArcWallet'
import { recordOf, useArcTx } from './useArcTx'

const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring'

type Step = 'form' | 'review' | 'deploying' | 'deploy-failed' | 'expiry' | 'expiry-pending' | 'fund' | 'fund-pending' | 'done'

const failedOutcome = (r?: TxRecord) => r?.outcome === 'reverted' || r?.outcome === 'unexpected'

function stepOf(s: SetupState | null, prepared: boolean, snapshot: VaultSnapshot | null): Step {
  if (!s || !s.deploy) return prepared ? 'review' : 'form'
  if (s.deploy.outcome === 'pending') return 'deploying'
  if (!s.vault) return 'deploy-failed'
  if (s.expiryTx?.outcome === 'pending') return 'expiry-pending'
  // Landed as expected here, or set by any other means (the vault page's own control): the
  // vault's live expiry decides either way once it has been read.
  const expirySet = Boolean(s.expiryTx && !failedOutcome(s.expiryTx)) || (snapshot !== null && snapshot.sessionKeyExpiry !== 0n)
  if (!expirySet) return 'expiry'
  if (s.fundTx?.outcome === 'pending') return 'fund-pending'
  const funded = s.fundTx && !failedOutcome(s.fundTx)
  if (s.funding > 0n && !s.fundSkipped && !funded) return 'fund'
  return 'done'
}

const STEPS: { key: string; label: string }[] = [
  { key: 'deploy', label: '1. Deploy, owned by you' },
  { key: 'expiry', label: "2. Bound the agent's key in time" },
  { key: 'fund', label: '3. Fund it' },
]

export default function DeployFlow({
  chain: pageChain,
  onChainChange,
  wallet,
  onOpenVault,
  onClose,
}: {
  chain: Chain
  onChainChange: (caip2: string) => void
  wallet: ArcWalletState
  onOpenVault: (network: string, address: string) => void
  onClose: () => void
}) {
  const [setup, setSetupState] = useState<SetupState | null>(() => loadSetup())
  const chain = (setup && arcChainFor(setup.network)) || pageChain
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
  const { busy, step: txStep, failure, setFailure, run } = useArcTx()

  const setSetup = useCallback((next: SetupState | null) => {
    setSetupState(next)
    saveSetup(next)
  }, [])

  const step = stepOf(setup, prepared !== null, snapshot)
  const account = wallet.account
  const provider = wallet.wallet?.provider ?? null
  const ownerMismatch = Boolean(setup && account && !sameAddress(account, setup.owner))

  // The vault, read back whenever the setup has one and is between steps.
  const readBack = useCallback(async () => {
    if (!setup?.vault) return
    const r = await readVault(chain, setup.vault)
    if (r.ok) {
      setSnapshot(r.data)
      setSnapshotNote(null)
    } else {
      setSnapshotNote(`The vault could not be read just now (${r.failure.reason}). Its state is shown once a read succeeds.`)
    }
  }, [chain, setup?.vault])

  useEffect(() => {
    if (step === 'expiry' || step === 'fund' || step === 'done') void readBack()
  }, [step, readBack])

  const updateRecord = useCallback(
    (field: 'deploy' | 'expiryTx' | 'fundTx', r: TxRecord) => {
      setSetupState((prev) => {
        if (!prev) return prev
        const next: SetupState = { ...prev, [field]: r }
        if (field === 'deploy' && r.vault && (r.outcome === 'settled' || r.outcome === 'replaced')) next.vault = r.vault
        saveSetup(next)
        return next
      })
    },
    [],
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

  const review = (e: FormEvent) => {
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
    void run('prepare', async (onStep) => {
      onStep('checking')
      const facts = await readUsdcFacts(chain)
      if (!facts.ok) throw new TxStop({ code: 'refused', message: facts.reason })
      onStep('simulating')
      const p = await prepareDeploy(chain, input)
      setPrepared(p)
      return p
    })
  }

  const confirmDeploy = () => {
    if (!prepared || !provider || !account || !usdc || parsed.c === null || parsed.a === null || parsed.f === null) return
    const input = { owner: account, operator: operator.trim(), dailyCap: parsed.c, autoApproveMax: parsed.a, funding: parsed.f }
    void run('deploy', async (onStep) => {
      let p = prepared
      if (preparedStale(p)) {
        onStep('simulating')
        p = await prepareDeploy(chain, input)
      }
      const hash = await sendPrepared(provider, p, onStep)
      const record: TxRecord = {
        ...recordOf(p, hash, null),
        deployArgs: { owner: p.from, operator: input.operator, usdc: usdc.address, dailyCap: input.dailyCap, autoApproveMax: input.autoApproveMax },
      }
      setSetup({
        v: 1,
        network: chain.caip2,
        owner: p.from,
        operator: input.operator,
        dailyCap: input.dailyCap,
        autoApproveMax: input.autoApproveMax,
        sessionSeconds: seconds,
        funding: input.funding,
        startedAt: new Date().toISOString(),
        deploy: record,
      })
      setPrepared(null)
      track('arc_vault_deploy', { network: networkWord(chain), outcome: 'submitted' })
      return hash
    })
  }

  const setExpiry = () => {
    if (!setup || !snapshot || !provider) return
    void run('expiry', async (onStep) => {
      onStep('simulating')
      const p = await prepareOwnerCall(chain, snapshot, { fn: 'extend', seconds: setup.sessionSeconds })
      const hash = await sendPrepared(provider, p, onStep)
      const record: TxRecord = { ...recordOf(p, hash, snapshot.address), action: 'expiry' }
      setSetup({ ...setup, expiryTx: record })
      track('arc_vault_owner_action', { network: networkWord(chain), action: 'expiry', outcome: 'submitted' })
      return hash
    })
  }

  const forget = () => {
    setSetup(null)
    setPrepared(null)
    setSnapshot(null)
    setFailure(null)
  }

  const stepIndex = step === 'form' || step === 'review' || step === 'deploying' || step === 'deploy-failed' ? 0 : step === 'expiry' || step === 'expiry-pending' ? 1 : step === 'done' ? 3 : 2
  const label = busy ? `${txStep ? STEP_LABEL[txStep] : 'Working'}...` : null

  return (
    <section aria-label="Deploy a vault you own" className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Deploy a vault you own</h2>
          <p className="mt-1 max-w-2xl text-xs text-foreground/70">
            Your wallet deploys an AgentSpendPolicy vault with your account as its owner, then bounds the agent's key in time, then funds it.
            Three transactions, each signed by you. A-Identity holds no key and signs nothing on this page.
          </p>
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

      {!chain.testnet ? (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
          <span className="font-semibold text-foreground">{networkName(chain)}: real USDC.</span> AgentSpendPolicy has had internal security
          reviews and an automated scan, not an external audit. Keep to dust amounts: the defaults are a 1 USDC daily cap and a 0.25 USDC
          ceiling on purpose.
        </p>
      ) : (
        <p className="rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground/75">
          <span className="font-semibold text-foreground">{networkName(chain)}: rehearsal.</span> Test USDC only (faucet.circle.com). A vault here
          is not an Arc Mainnet vault and does not count for anything.
        </p>
      )}

      {ownerMismatch && setup && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          This setup belongs to <Mono>{setup.owner}</Mono>, but your wallet is on <Mono>{account}</Mono>. Pick the owner account in your wallet
          to continue; nothing is sent from any other account.
        </p>
      )}

      {/* Step 1: the form, then the review. */}
      {step === 'form' && (
        <form onSubmit={review} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="deploy-network" className="text-[11px] font-semibold text-foreground/65">
              Network
            </label>
            <select id="deploy-network" value={chain.caip2} onChange={(e) => onChainChange(e.target.value)} className={INPUT}>
              {ARC_CHAINS.map((c) => (
                <option key={c.caip2} value={c.caip2}>
                  {c.testnet ? 'Arc testnet: test USDC, for a rehearsal' : 'Arc Mainnet: real USDC (the default)'}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <div className="text-[11px] font-semibold text-foreground/65">Owner</div>
            <div className="mt-1 text-sm text-foreground">
              {account ? (
                <>
                  <Mono>{account}</Mono> <span className="text-xs text-foreground/60">(your connected account: the only key that can freeze, change the limits, withdraw or replace the operator)</span>
                </>
              ) : (
                <span className="text-foreground/70">Connect your wallet above. The connected account becomes the owner.</span>
              )}
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="deploy-operator" className="text-[11px] font-semibold text-foreground/65">
              Operator: the agent's own key, which can call pay() within the limits and nothing else
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
          </div>
          <div>
            <label htmlFor="deploy-cap" className="text-[11px] font-semibold text-foreground/65">
              Daily cap (USDC, above 0)
            </label>
            <input id="deploy-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label htmlFor="deploy-ceiling" className="text-[11px] font-semibold text-foreground/65">
              Largest payment without you (USDC, above 0)
            </label>
            <input id="deploy-ceiling" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label htmlFor="deploy-session" className="text-[11px] font-semibold text-foreground/65">
              The agent's key is valid for (from the chain's time at step 2)
            </label>
            <select id="deploy-session" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className={INPUT}>
              {SESSION_CHOICES.map((c) => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="deploy-funding" className="text-[11px] font-semibold text-foreground/65">
              Fund with (USDC, sent at step 3; 0 to fund later)
            </label>
            <input id="deploy-funding" inputMode="decimal" value={funding} onChange={(e) => setFunding(e.target.value)} className={INPUT} />
          </div>
          {parsed.c !== null && parsed.a !== null && parsed.c > 0n && parsed.a > 0n && capsWarning(parsed.c, parsed.a) && (
            <p className="text-xs text-foreground/75 sm:col-span-2">{capsWarning(parsed.c, parsed.a)}</p>
          )}
          {parsed.f !== null && aboveSoftWarn(parsed.f, decimals) && (
            <p className="text-xs font-semibold text-warn sm:col-span-2">
              More than 10 USDC. The caps limit what the agent can spend per day, not what the vault holds; fund only what you are ready to
              lose to a bug in an unaudited contract.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy !== null}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {label ?? 'Review the deploy'}
            </Button>
            <span className="text-xs text-foreground/60">Review reads USDC's own decimals, simulates the deploy and checks your gas. Nothing is signed yet.</span>
          </div>
        </form>
      )}

      {step === 'review' && prepared && (
        <div className="space-y-3">
          <PreparedView p={prepared} decimals={decimals} title="Review: deploy your vault (transaction 1 of 3)" />
          <div className="rounded-xl border border-border bg-background/60 p-4 text-xs text-foreground/80">
            <div className="font-semibold text-foreground">Then, after the deploy lands:</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Transaction 2: setSessionKeyExpiry to the chain's time plus {SESSION_CHOICES.find((c) => c.seconds === seconds)?.label ?? `${seconds} seconds`}.
                Until it lands, the agent's key has no time bound, and the page says so.
              </li>
              <li>
                Transaction 3: {parsed.f && parsed.f > 0n ? `a ${formatUnitsExact(parsed.f, decimals)} USDC transfer from your account into the vault.` : 'none: you chose to fund later.'}
              </li>
              <li>Each is about 0.001 USDC of network fee at today's prices; your balance was checked to cover all three plus the funding.</li>
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={confirmDeploy} disabled={busy !== null || ownerMismatch}>
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

      {/* Step 1, in flight or stopped. */}
      {setup?.deploy && (step === 'deploying' || step === 'deploy-failed') && (
        <TxReceipt record={setup.deploy} chain={chain} onUpdate={(r) => updateRecord('deploy', r)} onSettled={(r) => onFinal('deploy', r)} />
      )}
      {step === 'deploy-failed' && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-foreground/75">No vault came out of this deploy, so there is nothing to bound or fund. Start again when ready.</p>
          <Button size="sm" variant="outline" onClick={forget}>
            Start again
          </Button>
        </div>
      )}

      {/* Step 2. The loud part: the vault exists and its key has no time bound until this lands. */}
      {setup?.vault && (step === 'expiry' || step === 'expiry-pending') && (
        <div className="space-y-3">
          {setup.deploy && <TxReceipt record={setup.deploy} chain={chain} onUpdate={(r) => updateRecord('deploy', r)} />}
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/[0.08] p-4 text-sm">
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0">
                <div className="font-semibold text-foreground">Your vault exists, but its agent key has no time bound yet.</div>
                <div className="mt-1 text-foreground/80">
                  Vault <Mono>{setup.vault}</Mono>. Until transaction 2 lands, the operator can pay inside the caps with no end date. Set the
                  expiry now; nothing is funded before it.
                </div>
              </div>
            </div>
          </div>
          {setup.expiryTx && (
            <TxReceipt record={setup.expiryTx} chain={chain} onUpdate={(r) => updateRecord('expiryTx', r)} onSettled={(r) => onFinal('expiryTx', r)} />
          )}
          {step === 'expiry' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={setExpiry} disabled={busy !== null || !snapshot || ownerMismatch || !provider}>
                {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {label ??
                  `Set it now: valid for ${SESSION_CHOICES.find((c) => c.seconds === setup.sessionSeconds)?.label ?? `${setup.sessionSeconds} seconds`}`}
              </Button>
              {!snapshot && <span className="text-xs text-foreground/60">{snapshotNote ?? 'Reading the new vault back...'}</span>}
              {!provider && <span className="text-xs text-foreground/60">Connect the owner wallet above to sign it.</span>}
            </div>
          )}
        </div>
      )}

      {/* Step 3. */}
      {setup?.vault && (step === 'fund' || step === 'fund-pending') && (
        <div className="space-y-3">
          {setup.expiryTx && <TxReceipt record={setup.expiryTx} chain={chain} onUpdate={(r) => updateRecord('expiryTx', r)} />}
          {setup.fundTx && (
            <TxReceipt record={setup.fundTx} chain={chain} onUpdate={(r) => updateRecord('fundTx', r)} onSettled={(r) => onFinal('fundTx', r)} />
          )}
          {step === 'fund' && snapshot && provider && account && !ownerMismatch && (
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <h3 className="text-sm font-semibold text-foreground">Transaction 3 of 3: fund the vault</h3>
              <p className="mt-1 text-xs text-foreground/70">
                A USDC transfer from your account to <Mono>{setup.vault}</Mono>. The vault's key is bounded in time now, so this is the safe
                moment to fund it.
              </p>
              <div className="mt-3">
                <FundForm
                  chain={chain}
                  vault={snapshot}
                  provider={provider}
                  account={account}
                  held={false}
                  initial={formatUnitsExact(setup.funding, decimals)}
                  onSubmitted={(r) => setSetup({ ...setup, fundTx: { ...r, action: 'fund' } })}
                />
              </div>
              <button
                type="button"
                onClick={() => setSetup({ ...setup, fundSkipped: true })}
                className="mt-3 text-xs font-semibold text-accent underline underline-offset-2"
              >
                Skip funding for now
              </button>
            </div>
          )}
          {step === 'fund' && !snapshot && <p className="text-xs text-foreground/60">{snapshotNote ?? 'Reading the vault back...'}</p>}
        </div>
      )}

      {setup?.vault && step === 'done' && (
        <div className="space-y-3">
          {setup.fundTx && <TxReceipt record={setup.fundTx} chain={chain} onUpdate={(r) => updateRecord('fundTx', r)} />}
          <div className="rounded-2xl border border-ok/30 bg-ok/[0.06] p-4 text-sm">
            <div className="font-semibold text-foreground">Your vault is set up.</div>
            <div className="mt-1 text-foreground/80">
              <Mono>{setup.vault}</Mono> on {networkName(chain)}, owned by <Mono>{setup.owner}</Mono>
              {snapshot ? (
                <>
                  , session key {snapshot.sessionKeyExpiry === 0n ? <Chip tone="danger">no time bound</Chip> : 'bounded in time'}, balance{' '}
                  {formatUnitsExact(snapshot.balance, decimals)} USDC.
                </>
              ) : (
                '.'
              )}
              {setup.fundSkipped && ' Funding was skipped: send USDC to the vault from its page when ready.'}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => onOpenVault(chain.caip2, setup.vault as string)}>
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
      {failure && <FailureNotice failure={failure} />}

      {setup && step !== 'done' && step !== 'deploy-failed' && (
        <p className="text-[11px] text-foreground/55">
          This setup is saved in this browser after every hash, so a reload resumes it.{' '}
          {!setup.vault && (
            <>
              Forgetting it does not cancel anything already in your wallet.{' '}
              <button type="button" onClick={forget} className="font-semibold text-accent underline underline-offset-2">
                Forget it
              </button>
            </>
          )}
        </p>
      )}
    </section>
  )
}
