import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, Fingerprint, Loader2, ShieldCheck } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, reveal, revealAt } from '../components/ui/section'
import { usePageMeta } from '../lib/head'
import {
  PASSKEY_STEP_LABEL,
  SMART_ACCOUNT_KIT_VERSION,
  addressUrl,
  contractUrl,
  createPasskeyAccount,
  deployPendingPasskey,
  disconnectPasskey,
  hasPasskeySession,
  ownerSetAllowed,
  ownerSetPolicy,
  passkeyErrorMessage,
  passkeysSupported,
  restorePasskeyAccount,
  signInWithPasskey,
  txUrl,
  type ChainWrite,
  type PasskeyAccount,
  type PasskeyStep,
} from '../lib/stellar/passkey'
import {
  agentPay,
  deployPasskeyVault,
  planAllowlist,
  readPasskeyStatus,
  sponsorReadiness,
  type AgentPay,
  type AllowlistPlan,
  type Decision,
  type SeedResult,
} from '../lib/stellar/passkey-api'

/**
 * /stellar: the passkey vault demo, end to end, on Stellar testnet.
 *
 * Five cards in the order the 90-second demo runs them, each doing the thing rather than
 * describing it: a passkey becomes an OpenZeppelin smart account, that account owns a
 * fresh spend vault and signs its limit, the risk engine answers ALLOW / WARN / DENY and
 * the passkey signs the one write that verdict implies, then the agent is refused paying
 * an untrusted payee and settles paying a trusted one.
 *
 * Every step ends in a link. The one step with no hash of its own says so out loud: a
 * payment the vault refuses is rejected in simulation, so nothing reaches a ledger, and
 * the page links a recorded on-chain refusal of the same kind instead of inventing one.
 *
 * Testnet everywhere, labeled everywhere. The kit is imported lazily inside
 * lib/stellar/passkey.ts, so nothing here reaches WebAuthn or the Stellar SDK until a
 * visitor asks, and the prerender snapshot is the idle state of this page.
 */

/** A testnet account with a USDC trustline that earlier releases paid. */
const TRUSTED_PAYEE = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
/** The account the vault refused, both in simulation and on the ledger below. */
const UNTRUSTED_PAYEE = 'GDSEJCFLEBVEJ5GGDNCPRPKCRFH64CIHA3H3C3ILO5C5VTQMTSLUHQ7N'

/**
 * A pay() the vault refused ON the ledger, recorded 2026-09-19. A refusal normally fails
 * in simulation and never reaches a ledger, so this is the artifact that shows what the
 * refusal looks like on chain: the owner revoked the payee while the agent's transaction
 * was in flight, so it landed and reverted with PayeeNotAllowed.
 */
const RECORDED_REFUSAL = '22b33018c807946df066365bde2a72293372bf7768ab96688acb623c290357a0'

const DEFAULTS = { dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: 3, payUsd: 0.5 }

type Receipt = { key: string; label: string; txHash: string; explorerUrl: string }

type Status = 'locked' | 'ready' | 'busy' | 'done' | 'stopped'

/** A whole number of dollars reads bare ($5); anything with cents keeps them ($0.50). */
const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id)

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted' | 'accent'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-ok/10 text-ok'
      : tone === 'warn'
        ? 'bg-warn/10 text-warn'
        : tone === 'danger'
          ? 'bg-danger/10 text-danger'
          : tone === 'accent'
            ? 'bg-accent/10 text-accent'
            : 'bg-foreground/[0.06] text-foreground/60'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${cls}`}>
      {children}
    </span>
  )
}

function TxLink({ hash, url, label = 'transaction' }: { hash: string; url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-accent underline-offset-2 hover:underline"
    >
      <span className="truncate">
        {label} {hash.slice(0, 10)}
      </span>
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

/** One address, readable on a phone: never wider than its card, always linked. */
function Address({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</div>
      <a
        href={addressUrl(value)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 block break-all font-mono text-xs text-accent underline-offset-2 hover:underline"
      >
        {value}
      </a>
    </div>
  )
}

const BTN =
  'inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100'
const BTN_QUIET =
  'inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground/75 transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50'
const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent'
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-foreground/45'

function StepCard({
  index,
  title,
  lede,
  status,
  chip,
  children,
}: {
  index: number
  title: string
  lede: string
  status: Status
  chip?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <motion.section
      {...revealAt(Math.min(index - 1, 3))}
      className={`rounded-2xl border bg-card p-5 transition-colors sm:p-6 ${
        status === 'done' ? 'border-ok/35' : status === 'stopped' ? 'border-warn/35' : status === 'locked' ? 'border-border' : 'border-accent/35'
      }`}
      aria-current={status === 'ready' || status === 'busy' ? 'step' : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tabular-nums text-foreground/30">{index}</span>
          <h2 className="text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            {title}
          </h2>
        </div>
        {chip}
      </div>
      <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-foreground/65">{lede}</p>
      <div className={status === 'locked' ? 'pointer-events-none mt-4 opacity-45' : 'mt-4'}>{children}</div>
    </motion.section>
  )
}

/** The outcome of one chain write, in the vocabulary the rest of the product uses. */
function WriteResult({ write, what }: { write: ChainWrite; what: string }) {
  if (write.outcome === 'settled') {
    return (
      <p className="text-xs text-foreground/65">
        {what} settled{write.ledger ? ` in ledger ${write.ledger}` : ''}. <TxLink hash={write.txHash} url={write.explorerUrl} />
      </p>
    )
  }
  if (write.outcome === 'prepared') {
    return (
      <p className="text-xs text-warn">
        Fee sponsor not configured on this deployment; nothing was submitted. {write.reason}
      </p>
    )
  }
  if (write.outcome === 'refused') {
    return <p className="text-xs text-warn">{write.reason}</p>
  }
  return (
    <p className="text-xs text-danger">
      {write.reason}
      {write.txHash ? <> <TxLink hash={write.txHash} url={txUrl(write.txHash)} /></> : null}
    </p>
  )
}

const DECISION_TONE: Record<Decision, 'ok' | 'warn' | 'danger'> = { ALLOW: 'ok', WARN: 'warn', DENY: 'danger' }

export default function Stellar() {
  usePageMeta({
    title: 'A passkey that owns a spend vault on Stellar | A-Identity',
    description:
      'Run the whole thing on Stellar testnet: a passkey becomes an OpenZeppelin smart account, that account owns an AgentSpendPolicy vault and signs its limit, the risk engine answers ALLOW, WARN or DENY, and the vault refuses the payment it should. Every step links its transaction.',
    canonical: 'https://a-identity.xyz/stellar',
  })

  // Who is signing, and what the passkey controls.
  const [account, setAccount] = useState<PasskeyAccount | null>(null)
  const [pending, setPending] = useState<{ credentialId: string } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [supported, setSupported] = useState(true)
  const [sponsor, setSponsor] = useState<{ ready: boolean | null; product?: string }>({ ready: null })

  // The vault and its policy.
  const [dailyCap, setDailyCap] = useState(String(DEFAULTS.dailyCapUsd))
  const [ceiling, setCeiling] = useState(String(DEFAULTS.autoApproveUsd))
  const [vault, setVault] = useState<{ contract: string; explorerUrl: string } | null>(null)
  const [seed, setSeed] = useState<SeedResult | null>(null)
  const [policyWrite, setPolicyWrite] = useState<ChainWrite | null>(null)

  // The trust check and the write it implies.
  const [payee, setPayee] = useState(TRUSTED_PAYEE)
  const [agentId, setAgentId] = useState('')
  const [plan, setPlan] = useState<(AllowlistPlan & { payee: string }) | null>(null)
  const [allowWrite, setAllowWrite] = useState<ChainWrite | null>(null)
  const [allowedPayee, setAllowedPayee] = useState<string | null>(null)

  // The two payments.
  const [refusal, setRefusal] = useState<AgentPay | null>(null)
  const [payment, setPayment] = useState<AgentPay | null>(null)

  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<PasskeyStep | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const addReceipt = useCallback((r: Receipt) => {
    setReceipts((prev) => (prev.some((p) => p.txHash === r.txHash) ? prev : [...prev, r]))
  }, [])

  const fail = (card: string, message: string) => setErrors((e) => ({ ...e, [card]: message }))

  /** Every action goes through here, so exactly one is in flight and each says where it is. */
  const run = useCallback(async (card: string, fn: () => Promise<void>) => {
    setBusy(card)
    setErrors((e) => ({ ...e, [card]: '' }))
    try {
      await fn()
    } catch (e) {
      setErrors((err) => ({ ...err, [card]: passkeyErrorMessage(e) }))
    } finally {
      setBusy(null)
      setStep(null)
    }
  }, [])

  // On load: say whether this browser can do passkeys at all, read how the deployment is
  // configured, and silently restore a returning visitor's smart account. The kit is only
  // imported when there is a session to restore, so a first visit downloads none of it.
  useEffect(() => {
    setSupported(passkeysSupported())
    let alive = true
    void readPasskeyStatus().then((s) => {
      if (alive) setSponsor(sponsorReadiness(s))
    })
    if (!hasPasskeySession()) return () => {
      alive = false
    }
    setRestoring(true)
    void restorePasskeyAccount()
      .then((a) => {
        if (alive && a) setAccount(a)
      })
      .catch(() => {
        /* a stale session is not an error worth showing: the sign-in button is right there */
      })
      .finally(() => {
        if (alive) setRestoring(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const label = (card: string, idle: string) => (busy === card ? `${step ? PASSKEY_STEP_LABEL[step] : 'Working'}...` : idle)
  const spin = (card: string) => busy === card && <Loader2 size={15} className="animate-spin" />

  // ── 1. the passkey and its smart account ────────────────────────────────────────
  const createAccount = () =>
    run('account', async () => {
      const r = await createPasskeyAccount('Stellar testnet demo', setStep)
      if (r.ok) {
        setAccount(r.account)
        setPending(null)
        addReceipt({ key: 'account', label: 'Smart account deployed', txHash: r.write.txHash, explorerUrl: r.write.explorerUrl })
        return
      }
      setPending({ credentialId: r.credentialId })
      fail('account', writeMessage(r.write, 'The smart account was not deployed'))
    })

  const retryDeploy = () =>
    run('account', async () => {
      if (!pending) return
      const r = await deployPendingPasskey(pending.credentialId, setStep)
      if (r.ok) {
        setAccount(r.account)
        setPending(null)
        addReceipt({ key: 'account', label: 'Smart account deployed', txHash: r.write.txHash, explorerUrl: r.write.explorerUrl })
        return
      }
      fail('account', writeMessage(r.write, 'The smart account was not deployed'))
    })

  const signIn = () =>
    run('account', async () => {
      setStep('passkey')
      setAccount(await signInWithPasskey())
      setPending(null)
    })

  const signOut = () =>
    run('account', async () => {
      await disconnectPasskey()
      setAccount(null)
      setPending(null)
    })

  // ── 2. the vault, and its limit signed by the passkey ───────────────────────────
  const deployVault = () =>
    run('vault', async () => {
      if (!account) return
      const r = await deployPasskeyVault({
        owner: account.contractId,
        dailyCapUsd: Number(dailyCap),
        autoApproveUsd: Number(ceiling),
        seedUsd: DEFAULTS.seedUsd,
      })
      if (r.outcome !== 'settled') {
        fail('vault', r.outcome === 'prepared' ? `${r.reason} Nothing was submitted.` : r.reason)
        return
      }
      setVault({ contract: r.vault, explorerUrl: r.vaultUrl || contractUrl(r.vault) })
      addReceipt({ key: 'vault', label: 'Vault deployed', txHash: r.txHash, explorerUrl: r.explorerUrl })
      // The seed is a separate transaction and it is allowed not to happen. An empty
      // vault is exactly why step 5 would fail, so a skipped seed is said, not hidden.
      if (r.seed?.txHash) {
        addReceipt({
          key: 'seed',
          label: `Vault funded with ${money(r.seed.amountUsd)} test USDC`,
          txHash: r.seed.txHash,
          explorerUrl: r.seed.explorerUrl ?? txUrl(r.seed.txHash),
        })
      }
      setSeed(r.seed ?? null)
    })

  const setLimit = () =>
    run('policy', async () => {
      if (!vault) return
      const w = await ownerSetPolicy(
        vault.contract,
        { dailyCapUsd: Number(dailyCap), autoApproveUsd: Number(ceiling), allowlistEnabled: true },
        setStep,
      )
      setPolicyWrite(w)
      if (w.outcome === 'settled') addReceipt({ key: 'policy', label: 'Limit set by the passkey', txHash: w.txHash, explorerUrl: w.explorerUrl })
    })

  // ── 3. the trust check, and the one write it implies ────────────────────────────
  const checkPayee = () =>
    run('kya', async () => {
      if (!vault) return
      const target = payee.trim()
      if (!/^[GC][A-Z2-7]{55}$/.test(target)) {
        fail('kya', 'That is not a Stellar address. An account starts with G, a contract with C, and both are 56 characters.')
        return
      }
      setAllowWrite(null)
      const p = await planAllowlist({ contract: vault.contract, payee: target, agentId: agentId.trim() || undefined })
      setPlan({ ...p, payee: target })
    })

  const signAllowlist = (allowed: boolean, target: string) =>
    run('allow', async () => {
      if (!vault) return
      const w = await ownerSetAllowed(vault.contract, target, allowed, setStep)
      setAllowWrite(w)
      if (w.outcome === 'settled') {
        setAllowedPayee(allowed ? target : null)
        addReceipt({
          key: `allow-${w.txHash}`,
          label: allowed ? 'Payee allowed on chain' : 'Payee revoked on chain',
          txHash: w.txHash,
          explorerUrl: w.explorerUrl,
        })
      }
    })

  // ── 4 and 5. the agent pays ─────────────────────────────────────────────────────
  const pay = (card: 'refused' | 'settled', to: string) =>
    run(card, async () => {
      if (!vault) return
      const r = await agentPay({ contract: vault.contract, to, amountUsd: DEFAULTS.payUsd })
      if (card === 'refused') setRefusal(r)
      else setPayment(r)
      if (r.outcome === 'settled') {
        addReceipt({ key: `pay-${r.txHash}`, label: `Agent paid ${money(DEFAULTS.payUsd)} test USDC`, txHash: r.txHash, explorerUrl: r.explorerUrl })
      }
    })

  const payTarget = allowedPayee ?? TRUSTED_PAYEE

  const accountStatus: Status = account ? 'done' : busy === 'account' ? 'busy' : 'ready'
  const vaultStatus: Status = !account ? 'locked' : policyWrite?.outcome === 'settled' ? 'done' : busy === 'vault' || busy === 'policy' ? 'busy' : 'ready'
  const kyaStatus: Status = !vault ? 'locked' : plan ? 'done' : busy === 'kya' ? 'busy' : 'ready'
  const refusedStatus: Status = !vault ? 'locked' : refusal ? (refusal.outcome === 'refused' ? 'stopped' : 'done') : busy === 'refused' ? 'busy' : 'ready'
  const paidStatus: Status = !vault ? 'locked' : payment?.outcome === 'settled' ? 'done' : busy === 'settled' ? 'busy' : 'ready'

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main>
        <SectionShell size="lg">
          <motion.div {...revealAt(0)} className="flex flex-wrap items-center gap-3">
            <Eyebrow icon={Fingerprint}>Stellar</Eyebrow>
            <Chip tone="warn">Testnet</Chip>
            <Chip tone="muted">no XLM needed</Chip>
          </motion.div>
          <motion.div {...revealAt(1)} className="mt-5">
            <DisplayHeading size="display" className="max-w-[17ch]">
              A passkey that owns a spend vault.
            </DisplayHeading>
          </motion.div>
          <motion.div {...revealAt(2)} className="mt-5">
            <Lede>
              Your face or fingerprint becomes a smart account on Stellar. It deploys a vault, sets the limit, and watches the
              vault refuse a payee it does not trust. Five steps, every one with its transaction.
            </Lede>
          </motion.div>
          <motion.p {...revealAt(3)} className="mt-5 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Everything here runs on Stellar testnet with test USDC, and the fees are sponsored, so you need no wallet, no
            seed phrase and no XLM. Signing uses smart-account-kit {SMART_ACCOUNT_KIT_VERSION} against the OpenZeppelin
            smart-account contracts.
            {sponsor.ready === false && (
              <>
                {' '}
                <span className="text-warn">
                  The fee sponsor is not configured on this deployment right now, so the signing steps will report what they
                  would have submitted rather than submitting it.
                </span>
              </>
            )}
          </motion.p>
          {!supported && (
            <motion.p {...revealAt(4)} className="mt-5 rounded-2xl border border-warn/35 bg-warn/[0.06] p-4 text-sm text-warn">
              This browser cannot create passkeys. Open this page in a current Chrome, Safari or Edge over https to run the
              demo; every step below still explains what it does.
            </motion.p>
          )}
        </SectionShell>

        <SectionShell size="tight">
          <div className="grid gap-4">
            {/* 1 ── the passkey */}
            <StepCard
              index={1}
              title="Sign in with a passkey"
              lede="No wallet and no seed phrase. The passkey stays on your device and controls an OpenZeppelin smart account, a C... contract deployed for you with the fee sponsored."
              status={accountStatus}
              chip={account ? <Chip tone="ok">smart account live</Chip> : restoring ? <Chip tone="muted">restoring</Chip> : undefined}
            >
              {account ? (
                <div className="grid gap-3">
                  <Address value={account.contractId} label="Your smart account" />
                  <div className="flex flex-wrap items-center gap-3">
                    {account.creation && <TxLink hash={account.creation.txHash} url={txUrl(account.creation.txHash)} label="deployed in" />}
                    <button type="button" onClick={signOut} disabled={busy !== null} className={BTN_QUIET}>
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={pending ? retryDeploy : createAccount} disabled={busy !== null || !supported} className={BTN}>
                    {spin('account')}
                    {label('account', pending ? 'Finish deploying it' : 'Create a passkey account')}
                  </button>
                  <button type="button" onClick={signIn} disabled={busy !== null || !supported} className={BTN_QUIET}>
                    I already have one
                  </button>
                </div>
              )}
              {errors.account && <p className="mt-3 text-xs text-danger">{errors.account}</p>}
              {pending && !errors.account && (
                <p className="mt-3 text-xs text-warn">The passkey exists on this device, but its account is not deployed yet.</p>
              )}
            </StepCard>

            {/* 2 ── the vault and its limit */}
            <StepCard
              index={2}
              title="Deploy a vault and set its limit"
              lede="A fresh AgentSpendPolicy vault whose owner is your smart account. We deploy it and seed it with test USDC; you sign the limit yourself, which is what proves the passkey owns it."
              status={vaultStatus}
              chip={vault ? <Chip tone={policyWrite?.outcome === 'settled' ? 'ok' : 'accent'}>{policyWrite?.outcome === 'settled' ? 'limit on chain' : 'vault live'}</Chip> : undefined}
            >
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={LABEL} htmlFor="stellar-daily-cap">
                      Daily cap (USDC)
                    </label>
                    <input
                      id="stellar-daily-cap"
                      type="number"
                      min="0"
                      step="0.5"
                      inputMode="decimal"
                      value={dailyCap}
                      onChange={(e) => setDailyCap(e.target.value)}
                      disabled={!!vault}
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="stellar-ceiling">
                      Per payment (USDC)
                    </label>
                    <input
                      id="stellar-ceiling"
                      type="number"
                      min="0"
                      step="0.5"
                      inputMode="decimal"
                      value={ceiling}
                      onChange={(e) => setCeiling(e.target.value)}
                      disabled={!!vault}
                      className={INPUT}
                    />
                  </div>
                </div>

                {!vault ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={deployVault} disabled={busy !== null || !account} className={BTN}>
                      {spin('vault')}
                      {busy === 'vault' ? 'Deploying...' : 'Deploy the vault'}
                    </button>
                    <span className="text-xs text-foreground/50">Seeded with {money(DEFAULTS.seedUsd)} test USDC so it can pay.</span>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <Address value={vault.contract} label="Your vault" />
                    {seed && !seed.txHash && (
                      <p className="text-xs text-warn">
                        The vault starts empty: {seed.reason ?? 'the seed transfer did not happen.'} Step 5 will be refused
                        for want of a balance until it holds some test USDC.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" onClick={setLimit} disabled={busy !== null} className={policyWrite?.outcome === 'settled' ? BTN_QUIET : BTN}>
                        {spin('policy')}
                        {label('policy', policyWrite?.outcome === 'settled' ? 'Sign it again' : 'Sign the limit with your passkey')}
                      </button>
                      <span className="text-xs text-foreground/50">
                        set_policy({money(Number(dailyCap))} a day, {money(Number(ceiling))} a payment, allowlist on)
                      </span>
                    </div>
                    {policyWrite && <WriteResult write={policyWrite} what="The limit" />}
                  </div>
                )}
                {errors.vault && <p className="text-xs text-danger">{errors.vault}</p>}
                {errors.policy && <p className="text-xs text-danger">{errors.policy}</p>}
              </div>
            </StepCard>

            {/* 3 ── the trust check */}
            <StepCard
              index={3}
              title="Check who you are about to pay"
              lede="Our risk engine answers ALLOW, WARN or DENY for this payee, and hands back the one chain write that verdict implies. You sign it with the passkey."
              status={kyaStatus}
              chip={plan ? <Chip tone={DECISION_TONE[plan.decision]}>{plan.decision}</Chip> : undefined}
            >
              <div className="grid gap-4">
                <div>
                  <label className={LABEL} htmlFor="stellar-payee">
                    Payee
                  </label>
                  <input
                    id="stellar-payee"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={payee}
                    onChange={(e) => setPayee(e.target.value)}
                    placeholder="G..."
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                    Try
                    <button type="button" onClick={() => setPayee(TRUSTED_PAYEE)} className={BTN_QUIET}>
                      A payee we have paid
                    </button>
                    <button type="button" onClick={() => setPayee(UNTRUSTED_PAYEE)} className={BTN_QUIET}>
                      The one we refused
                    </button>
                  </div>
                </div>
                <div>
                  <label className={LABEL} htmlFor="stellar-agent-id">
                    Agent id (optional)
                  </label>
                  <input
                    id="stellar-agent-id"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder="849980"
                    className={`${INPUT} font-mono text-xs sm:max-w-[16rem]`}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={checkPayee} disabled={busy !== null || !vault} className={BTN}>
                    {spin('kya')}
                    {busy === 'kya' ? 'Checking...' : 'Check this payee'}
                  </button>
                </div>

                {plan && (
                  <div className="rounded-xl border border-border bg-background/40 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={DECISION_TONE[plan.decision]}>{plan.decision}</Chip>
                      {plan.risk != null && <Chip tone="muted">risk {String(plan.risk)}</Chip>}
                      <Chip tone="muted">binding: {plan.binding}</Chip>
                    </div>
                    {plan.reasons.length > 0 && (
                      <ul className="mt-3 grid gap-1.5">
                        {plan.reasons.map((r) => (
                          <li key={r} className="text-[13px] leading-relaxed text-foreground/65">
                            {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    {plan.serverWarning && <p className="mt-3 text-xs text-warn">{plan.serverWarning}</p>}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      {plan.chainAction ? (
                        <button
                          type="button"
                          onClick={() => signAllowlist(plan.chainAction!.ok, plan.chainAction!.payee)}
                          disabled={busy !== null}
                          className={BTN}
                        >
                          {spin('allow')}
                          {label('allow', plan.chainAction.ok ? 'Allow this payee with your passkey' : 'Revoke this payee with your passkey')}
                        </button>
                      ) : (
                        <p className="text-xs text-foreground/60">
                          A WARN writes nothing on chain. It is a flag our server keeps, and the vault is unchanged.
                        </p>
                      )}
                      {plan.decision !== 'ALLOW' && (
                        <button type="button" onClick={() => signAllowlist(true, plan.payee)} disabled={busy !== null} className={BTN_QUIET}>
                          Allow anyway
                        </button>
                      )}
                    </div>
                    {allowWrite && (
                      <div className="mt-3">
                        <WriteResult write={allowWrite} what="The allowlist entry" />
                      </div>
                    )}
                    {errors.allow && <p className="mt-3 text-xs text-danger">{errors.allow}</p>}
                  </div>
                )}
                {errors.kya && <p className="text-xs text-danger">{errors.kya}</p>}
                <p className="text-xs leading-relaxed text-foreground/50">
                  The on-chain allowlist is binary: ALLOW writes an entry, WARN is a server-side flag and writes nothing, and
                  DENY writes a revoke so pay() reverts with PayeeNotAllowed. Only two of the three verdicts ever touch the
                  ledger.
                </p>
              </div>
            </StepCard>

            {/* 4 ── the refusal */}
            <StepCard
              index={4}
              title="The agent pays someone untrusted"
              lede="The agent asks the vault to pay an address that is not on the allowlist. The vault refuses before anything moves."
              status={refusedStatus}
              chip={refusal?.outcome === 'refused' ? <Chip tone="danger">refused</Chip> : undefined}
            >
              <div className="grid gap-3">
                <Address value={UNTRUSTED_PAYEE} label="Untrusted payee" />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => pay('refused', UNTRUSTED_PAYEE)} disabled={busy !== null || !vault} className={BTN}>
                    {spin('refused')}
                    {busy === 'refused' ? 'Asking the vault...' : `Try to pay ${money(DEFAULTS.payUsd)}`}
                  </button>
                </div>
                {refusal?.outcome === 'refused' && (
                  <div className="rounded-xl border border-danger/30 bg-danger/[0.05] p-4">
                    <p className="text-sm font-semibold text-danger">
                      {refusal.contractErrorName ?? 'PayeeNotAllowed'}
                      {refusal.contractErrorCode != null ? ` (#${refusal.contractErrorCode})` : ' (#3)'}
                    </p>
                    <p className="mt-2 text-[13px] leading-relaxed text-foreground/65">
                      {refusal.note ??
                        'The vault rejected the call in simulation, so no transaction was ever submitted and there is no hash to show. That is the honest result: a refused payment costs nothing and leaves no ledger entry.'}
                    </p>
                    <p className="mt-3 text-[13px] leading-relaxed text-foreground/65">
                      Here is the same refusal recorded on the ledger, from a run where the payee was revoked while the
                      agent's transaction was already in flight, so it landed and reverted:
                    </p>
                    <p className="mt-2">
                      <TxLink hash={RECORDED_REFUSAL} url={txUrl(RECORDED_REFUSAL)} label="refusal on chain" />
                    </p>
                  </div>
                )}
                {refusal && refusal.outcome !== 'refused' && refusal.outcome !== 'settled' && (
                  <p className="text-xs text-warn">{refusal.reason}</p>
                )}
                {refusal?.outcome === 'settled' && (
                  <p className="text-xs text-warn">
                    This payment settled, which means the payee was on the allowlist after all.{' '}
                    <TxLink hash={refusal.txHash} url={refusal.explorerUrl} />
                  </p>
                )}
                {errors.refused && <p className="text-xs text-danger">{errors.refused}</p>}
              </div>
            </StepCard>

            {/* 5 ── the payment */}
            <StepCard
              index={5}
              title="The agent pays someone trusted"
              lede="Same vault, same agent, same amount. This payee is on the allowlist and inside the limit, so the payment settles."
              status={paidStatus}
              chip={payment?.outcome === 'settled' ? <Chip tone="ok">settled</Chip> : undefined}
            >
              <div className="grid gap-3">
                <Address value={payTarget} label={allowedPayee ? 'The payee you allowed' : 'Trusted payee'} />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => pay('settled', payTarget)} disabled={busy !== null || !vault} className={BTN}>
                    {spin('settled')}
                    {busy === 'settled' ? 'Paying...' : `Pay ${money(DEFAULTS.payUsd)}`}
                  </button>
                  {!allowedPayee && <span className="text-xs text-foreground/50">Allow it in step 3 first, or the vault will refuse this too.</span>}
                </div>
                {payment?.outcome === 'settled' && (
                  <p className="text-xs text-foreground/65">
                    Settled{payment.ledger ? ` in ledger ${payment.ledger}` : ''}. <TxLink hash={payment.txHash} url={payment.explorerUrl} />
                  </p>
                )}
                {payment?.outcome === 'refused' && (
                  <p className="text-xs text-warn">
                    The vault refused it: {payment.contractErrorName ?? 'contract error'}
                    {payment.contractErrorCode != null ? ` (#${payment.contractErrorCode})` : ''}.{' '}
                    {payment.note ?? 'Allow the payee in step 3, then try again.'}
                  </p>
                )}
                {payment && payment.outcome !== 'settled' && payment.outcome !== 'refused' && (
                  <p className="text-xs text-warn">{payment.reason}</p>
                )}
                {errors.settled && <p className="text-xs text-danger">{errors.settled}</p>}
              </div>
            </StepCard>
          </div>
        </SectionShell>

        {/* The receipt strip: everything this session put on the ledger, in order. */}
        <SectionShell size="tight">
          <motion.div {...reveal}>
            <DisplayHeading size="section">Your receipts</DisplayHeading>
          </motion.div>
          <motion.p {...reveal} className="mt-3 max-w-[62ch] text-[15px] text-foreground/65">
            Every transaction this page put on Stellar testnet, in the order it happened. Nothing is listed here without a
            hash that made a ledger.
          </motion.p>
          <motion.div {...reveal} className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
            {receipts.length === 0 ? (
              <p className="p-5 text-sm text-foreground/55">
                No transactions yet. Run step 1 and this fills itself in.
              </p>
            ) : (
              receipts.map((r) => (
                <div key={r.txHash} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/60 px-5 py-3.5 last:border-0">
                  <span className="text-[15px] font-semibold text-foreground">{r.label}</span>
                  <TxLink hash={r.txHash} url={r.explorerUrl} />
                </div>
              ))
            )}
          </motion.div>
          {vault && (
            <motion.p {...reveal} className="mt-4 text-sm text-foreground/55">
              Your vault:{' '}
              <a href={contractUrl(vault.contract)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-accent hover:underline">
                {shortId(vault.contract)}
              </a>{' '}
              on stellar.expert testnet.
            </motion.p>
          )}
        </SectionShell>

        <SectionShell size="tight">
          <motion.div {...reveal} className="rounded-2xl border border-border bg-card p-6 sm:p-7">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">
              <ShieldCheck size={14} /> Stated plainly
            </div>
            <ul className="mt-3 grid gap-2 text-[15px] leading-relaxed text-foreground/70 sm:grid-cols-2 sm:gap-x-8">
              <li>Everything on this page is Stellar testnet and test USDC. Nothing here moves real money.</li>
              <li>A refused payment fails in simulation, so it has no hash. The linked refusal is a recorded one from the ledger.</li>
              <li>The passkey never leaves your device, and the server never holds a key that can move your vault.</li>
              <li>The same vault contract runs on pubnet, where it holds real USDC under a real cap.</li>
            </ul>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
              <Link to="/proof/stellar" className="inline-flex items-center gap-1 text-accent hover:underline">
                Every Stellar receipt <ArrowUpRight size={14} />
              </Link>
              <Link to="/explorer" className="inline-flex items-center gap-1 text-foreground/65 hover:text-foreground">
                Browse all agents <ArrowUpRight size={14} />
              </Link>
            </div>
          </motion.div>
        </SectionShell>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}

/** One sentence for a write that did not settle, naming what was being attempted. */
function writeMessage(write: ChainWrite, what: string): string {
  if (write.outcome === 'prepared')
    return `Fee sponsor not configured on this deployment, so ${what.toLowerCase()} and nothing was submitted.`
  if (write.outcome === 'refused') return `${what}: ${write.reason}`
  return `${what}: ${write.outcome === 'failed' ? write.reason : 'no transaction was returned.'}`
}
