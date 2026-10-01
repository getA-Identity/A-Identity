import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, Fingerprint, Loader2, ShieldCheck } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, reveal, revealAt } from '../components/ui/section'
import AddDevice from '../components/stellar/AddDevice'
import { AddressLink, BTN, BTN_QUIET, Chip, INPUT, LABEL, TxLink } from '../components/stellar/bits'
import { money, shortId } from '../components/stellar/format'
import DeviceSummary from '../components/stellar/DeviceSummary'
import NetworkSwitch from '../components/stellar/NetworkSwitch'
import OwnerActions from '../components/stellar/OwnerActions'
import { RecoveryBadge, RecoveryNotice } from '../components/stellar/RecoveryState'
import TxResult from '../components/stellar/TxResult'
import { usePageMeta } from '../lib/head'
import {
  PASSKEY_STEP_LABEL,
  SMART_ACCOUNT_KIT_VERSION,
  contractUrl,
  createPasskeyAccount,
  deployPendingPasskey,
  disconnectPasskey,
  hasPasskeySession,
  ownerSetAllowed,
  ownerSetPolicy,
  passkeyErrorMessage,
  passkeyNetworkFrom,
  passkeyNetworkInfo,
  passkeyNetworkParam,
  passkeysSupported,
  relyingPartyRefusal,
  restorePasskeyAccount,
  signInWithPasskey,
  txUrl,
  type ChainWrite,
  type DeviceMeta,
  type PasskeyAccount,
  type PasskeyNetwork,
  type PasskeyStep,
} from '../lib/stellar/passkey'
import {
  agentPay,
  defaultsFor,
  deployPasskeyVault,
  planAllowlist,
  readPasskeyStatus,
  type AgentPay,
  type AllowlistPlan,
  type Decision,
  type FeePayerNamed,
  type PasskeyStatus,
  type SeedResult,
} from '../lib/stellar/passkey-api'

/**
 * /stellar: the passkey vault demo, end to end, on the Stellar network the visitor picks.
 *
 * Mainnet by default, with every amount dust and capped by the backend; testnet at
 * ?network=testnet, which is where the SOW 2 D3 evidence is produced with a real device
 * passkey. The switch is in the open, each side says what it costs, and the whole demo
 * remounts on a switch, so nothing from one network is ever shown on the other.
 *
 * The cards run in the order a person needs them: a passkey becomes an OpenZeppelin smart
 * account (and the page names the device it lives on), the recovery position is stated and
 * acknowledged, that account owns a fresh spend vault and signs its limit, the risk engine
 * answers ALLOW / WARN / DENY and the passkey signs the write that verdict implies, the
 * agent is refused paying an untrusted payee and settles paying a trusted one, the owner
 * freezes and withdraws, and a second device is added on its own rule.
 *
 * Every write ends in its full hash, who paid its fee, and, for a passkey-signed write,
 * what was signed. The one step with no hash of its own says so out loud: a payment the
 * vault refuses is rejected in simulation, so nothing reaches a ledger.
 *
 * Every network-specific value (caps and defaults, explorer links, contract ids, payees)
 * comes from GET /api/stellar/passkey/status or the generated chain descriptor. The kit is
 * imported lazily inside lib/stellar/passkey.ts, so nothing here reaches WebAuthn or the
 * Stellar SDK until a visitor asks, and the prerender snapshot is the idle mainnet page.
 */

/** Testnet accounts from earlier releases. Testnet only: they are never offered on mainnet. */
const TESTNET_PAYEES = {
  /** A testnet account with a USDC trustline that earlier releases paid. */
  trusted: 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI',
  /** The account the vault refused, both in simulation and on the ledger below. */
  untrusted: 'GDSEJCFLEBVEJ5GGDNCPRPKCRFH64CIHA3H3C3ILO5C5VTQMTSLUHQ7N',
}

/**
 * A testnet pay() the vault refused ON the ledger, recorded 2026-09-19 (the payee was
 * revoked while the agent's transaction was in flight, so it landed and reverted with
 * PayeeNotAllowed). Testnet only, linked to the testnet explorer, and part of the
 * software-key rehearsal, so it is shown as what a refusal looks like and nothing more.
 */
const RECORDED_TESTNET_REFUSAL = '22b33018c807946df066365bde2a72293372bf7768ab96688acb623c290357a0'

type Receipt = { key: string; label: string; txHash: string; explorerUrl: string }

type Status = 'locked' | 'ready' | 'busy' | 'done' | 'stopped'

const isAddress = (v: string) => /^[GC][A-Z2-7]{55}$/.test(v.trim())

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
  lede: React.ReactNode
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
      <div className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-foreground/65">{lede}</div>
      <div className={status === 'locked' ? 'pointer-events-none mt-4 opacity-45' : 'mt-4'}>{children}</div>
    </motion.section>
  )
}

const DECISION_TONE: Record<Decision, 'ok' | 'warn' | 'danger'> = { ALLOW: 'ok', WARN: 'warn', DENY: 'danger' }

export default function Stellar() {
  const [params, setParams] = useSearchParams()
  const net = passkeyNetworkFrom(params.get('network'))
  usePageMeta({
    title: 'A passkey that owns a spend vault on Stellar | A-Identity',
    description:
      'A passkey becomes an OpenZeppelin smart account on Stellar, that account owns an AgentSpendPolicy vault and signs its limit, the risk engine answers ALLOW, WARN or DENY, and the vault refuses the payment it should. Mainnet in dust amounts, or testnet. Every step links its transaction.',
    canonical: 'https://a-identity.xyz/stellar',
  })

  const switchTo = (next: PasskeyNetwork) => {
    const p = new URLSearchParams(params)
    const v = passkeyNetworkParam(next)
    if (v) p.set('network', v)
    else p.delete('network')
    setParams(p)
  }

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main>
        {/* Keyed by network: switching remounts everything, so no state crosses networks. */}
        <StellarDemo key={net} net={net} onSwitch={switchTo} />
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}

function StellarDemo({ net, onSwitch }: { net: PasskeyNetwork; onSwitch: (n: PasskeyNetwork) => void }) {
  const info = passkeyNetworkInfo(net)
  const testnet = net === 'stellar:testnet'
  const usdcWord = testnet ? 'test USDC' : 'USDC'

  // What this deployment serves on this network.
  const [status, setStatus] = useState<PasskeyStatus | null>(null)
  const [statusRead, setStatusRead] = useState(false)

  // Who is signing, and what the passkey controls.
  const [account, setAccount] = useState<PasskeyAccount | null>(null)
  const [pending, setPending] = useState<{ credentialId: string; contractId: string; device: DeviceMeta | null } | null>(null)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [supported, setSupported] = useState(true)
  const [hostRefusal, setHostRefusal] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [signerRefresh, setSignerRefresh] = useState(0)

  // The vault and its policy. Defaults arrive with the status, sized to its caps.
  const [dailyCap, setDailyCap] = useState('')
  const [ceiling, setCeiling] = useState('')
  const [vault, setVault] = useState<{ contract: string; explorerUrl: string; ownerReadBack: { owner: string | null; matches: boolean | null; read: string } } | null>(null)
  const [deployWrite, setDeployWrite] = useState<{ write: ChainWrite; feePayer: FeePayerNamed | null } | null>(null)
  const [seed, setSeed] = useState<SeedResult | null>(null)
  const [policyWrite, setPolicyWrite] = useState<ChainWrite | null>(null)

  // The trust check and the write it implies.
  const [payee, setPayee] = useState('')
  const [agentId, setAgentId] = useState('')
  const [plan, setPlan] = useState<(AllowlistPlan & { payee: string }) | null>(null)
  const [allowWrite, setAllowWrite] = useState<ChainWrite | null>(null)
  const [allowedPayee, setAllowedPayee] = useState<string | null>(null)

  // The two payments.
  const [untrusted, setUntrusted] = useState(testnet ? TESTNET_PAYEES.untrusted : '')
  const [refusal, setRefusal] = useState<AgentPay | null>(null)
  const [payment, setPayment] = useState<AgentPay | null>(null)

  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<PasskeyStep | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const caps = status?.caps ?? null
  const defaults = useMemo(() => (caps ? defaultsFor(caps) : null), [caps])
  const sponsor = status?.relayer.configured ?? null

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

  // On load: whether this browser and host can do passkeys at all, how the deployment is
  // configured for this network, and a silent restore of a returning visitor's account on
  // THIS network. The kit is only imported when there is a session to restore.
  useEffect(() => {
    setSupported(passkeysSupported())
    setHostRefusal(relyingPartyRefusal())
    let alive = true
    void readPasskeyStatus(net).then((s) => {
      if (!alive) return
      setStatus(s)
      setStatusRead(true)
    })
    if (!hasPasskeySession(net) || relyingPartyRefusal()) {
      return () => {
        alive = false
      }
    }
    setRestoring(true)
    void restorePasskeyAccount(net)
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
  }, [net])

  // The inputs start from the caps the backend enforces here, never from a constant that
  // could exceed them. A value the visitor typed is left alone.
  useEffect(() => {
    if (!defaults) return
    setDailyCap((v) => v || String(defaults.dailyCapUsd))
    setCeiling((v) => v || String(defaults.autoApproveUsd))
    // The payee check starts on a known-good payee: testnet's paid account, or on mainnet
    // the visitor's own smart account once it exists.
    setPayee((v) => v || (testnet ? TESTNET_PAYEES.trusted : (account?.contractId ?? '')))
  }, [defaults, testnet, account])

  const label = (card: string, idle: string) => (busy === card ? `${step ? PASSKEY_STEP_LABEL[step] : 'Working'}...` : idle)
  const spin = (card: string) => busy === card && <Loader2 size={15} className="animate-spin" />
  const blocked = !supported || Boolean(hostRefusal)

  // ── 1. the passkey and its smart account ────────────────────────────────────────
  const onCreated = (p: { contractId: string; credentialId: string; device: DeviceMeta | null }) => setPending(p)

  const createAccount = () =>
    run('account', async () => {
      const r = await createPasskeyAccount(net, { label: deviceLabel.trim() || null, onStep: setStep, onCreated })
      if (r.ok) {
        setAccount(r.account)
        setPending(null)
        addReceipt({ key: 'account', label: 'Smart account deployed', txHash: r.write.txHash, explorerUrl: r.write.explorerUrl })
        return
      }
      setPending({ credentialId: r.credentialId, contractId: r.contractId, device: r.device })
      fail('account', writeMessage(r.write, 'The smart account was not deployed'))
    })

  const retryDeploy = () =>
    run('account', async () => {
      if (!pending) return
      const r = await deployPendingPasskey(net, pending.credentialId, setStep)
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
      setAccount(await signInWithPasskey(net))
      setPending(null)
    })

  const signOut = () =>
    run('account', async () => {
      await disconnectPasskey(net)
      setAccount(null)
      setPending(null)
    })

  // ── 3. the vault, and its limit signed by the passkey ───────────────────────────
  const deployVault = () =>
    run('vault', async () => {
      if (!account || !defaults) return
      if (!account.publicKeyHex) {
        fail('vault', 'This browser does not hold the passkey public key for this account, which the server checks against the account before deploying. Disconnect and sign in with your passkey again.')
        return
      }
      const r = await deployPasskeyVault(net, {
        owner: account.contractId,
        ownerPublicKey: account.publicKeyHex,
        dailyCapUsd: Number(dailyCap),
        autoApproveUsd: Number(ceiling),
        seedUsd: defaults.seedUsd,
      })
      if (r.outcome !== 'settled') {
        fail('vault', r.outcome === 'prepared' ? `${r.reason} Nothing was submitted.` : r.reason)
        return
      }
      setVault({ contract: r.vault, explorerUrl: r.vaultUrl || contractUrl(net, r.vault), ownerReadBack: r.ownerReadBack })
      setDeployWrite({ write: { outcome: 'settled', txHash: r.txHash, ledger: r.ledger, explorerUrl: r.explorerUrl }, feePayer: r.feePayer })
      addReceipt({ key: 'vault', label: 'Vault deployed', txHash: r.txHash, explorerUrl: r.explorerUrl })
      // The seed is a separate transaction and it is allowed not to happen. An empty
      // vault is exactly why a later payment would fail, so a skipped seed is said, not hidden.
      if (r.seed?.txHash) {
        addReceipt({
          key: 'seed',
          label: `Vault funded with ${money(r.seed.amountUsd)} ${usdcWord}`,
          txHash: r.seed.txHash,
          explorerUrl: r.seed.explorerUrl ?? txUrl(net, r.seed.txHash),
        })
      }
      setSeed(r.seed ?? null)
    })

  const setLimit = () =>
    run('policy', async () => {
      if (!vault) return
      const w = await ownerSetPolicy(net, vault.contract, { dailyCapUsd: Number(dailyCap), autoApproveUsd: Number(ceiling), allowlistEnabled: true }, setStep)
      setPolicyWrite(w)
      if (w.outcome === 'settled') addReceipt({ key: 'policy', label: 'Limit set by the passkey', txHash: w.txHash, explorerUrl: w.explorerUrl })
    })

  // ── 4. the trust check, and the one write it implies ────────────────────────────
  const checkPayee = () =>
    run('kya', async () => {
      if (!vault) return
      const target = payee.trim()
      if (!isAddress(target)) {
        fail('kya', 'That is not a Stellar address. An account starts with G, a contract with C, and both are 56 characters.')
        return
      }
      setAllowWrite(null)
      const p = await planAllowlist(net, { contract: vault.contract, payee: target, agentId: agentId.trim() || undefined })
      setPlan({ ...p, payee: target })
    })

  const signAllowlist = (allowed: boolean, target: string) =>
    run('allow', async () => {
      if (!vault) return
      const w = await ownerSetAllowed(net, vault.contract, target, allowed, setStep)
      setAllowWrite(w)
      if (w.outcome === 'settled') {
        setAllowedPayee(allowed ? target : null)
        addReceipt({ key: `allow-${w.txHash}`, label: allowed ? 'Payee allowed on chain' : 'Payee revoked on chain', txHash: w.txHash, explorerUrl: w.explorerUrl })
      }
    })

  // ── 5 and 6. the agent pays ─────────────────────────────────────────────────────
  const payUsd = defaults?.payUsd ?? 0
  const pay = (card: 'refused' | 'settled', to: string) =>
    run(card, async () => {
      if (!vault || !payUsd) return
      const r = await agentPay(net, { contract: vault.contract, to, amountUsd: payUsd })
      if (card === 'refused') setRefusal(r)
      else setPayment(r)
      if (r.outcome === 'settled') {
        addReceipt({ key: `pay-${r.txHash}`, label: `Agent paid ${money(payUsd)} ${usdcWord}`, txHash: r.txHash, explorerUrl: r.explorerUrl })
      }
    })

  const payTarget = allowedPayee ?? (testnet ? TESTNET_PAYEES.trusted : account?.contractId ?? '')

  const accountStatus: Status = account ? 'done' : busy === 'account' ? 'busy' : 'ready'
  const recoveryStatus: Status = !account && !pending ? 'locked' : accepted ? 'done' : 'ready'
  const vaultStatus: Status = !account || !accepted ? 'locked' : policyWrite?.outcome === 'settled' ? 'done' : busy === 'vault' || busy === 'policy' ? 'busy' : 'ready'
  const kyaStatus: Status = !vault ? 'locked' : plan ? 'done' : busy === 'kya' ? 'busy' : 'ready'
  const refusedStatus: Status = !vault ? 'locked' : refusal ? (refusal.outcome === 'refused' ? 'stopped' : 'done') : busy === 'refused' ? 'busy' : 'ready'
  const paidStatus: Status = !vault ? 'locked' : payment?.outcome === 'settled' ? 'done' : busy === 'settled' ? 'busy' : 'ready'
  const ownerStatus: Status = !vault || !account ? 'locked' : 'ready'
  const deviceStatus: Status = !account ? 'locked' : 'ready'

  const sa = status?.smartAccount

  return (
    <>
      <SectionShell size="lg">
        <motion.div {...revealAt(0)} className="flex flex-wrap items-center gap-3">
          <Eyebrow icon={Fingerprint}>Stellar</Eyebrow>
          {testnet ? <Chip tone="accent">Testnet, no real money</Chip> : <Chip tone="warn">Mainnet, real money in dust amounts</Chip>}
          <Chip tone="muted">no XLM needed</Chip>
        </motion.div>
        <motion.div {...revealAt(1)} className="mt-5">
          <DisplayHeading size="display" className="max-w-[17ch]">
            A passkey that owns a spend vault.
          </DisplayHeading>
        </motion.div>
        <motion.div {...revealAt(2)} className="mt-5">
          <Lede>
            Your face or fingerprint becomes a smart account on Stellar. It deploys a vault, sets the limit, watches the vault
            refuse a payee it does not trust, and keeps the owner's levers: freeze, withdraw, add a device.
          </Lede>
        </motion.div>
        <motion.div {...revealAt(3)} className="mt-6">
          <NetworkSwitch value={net} onChange={onSwitch} disabled={busy !== null} />
        </motion.div>
        <motion.div {...revealAt(3)} className="mt-5 grid max-w-[62ch] gap-2 text-sm leading-relaxed text-foreground/55">
          {testnet ? (
            <p>Everything here runs on Stellar testnet with test USDC. Nothing on this side moves real money.</p>
          ) : (
            <p>
              This side is Stellar mainnet with real Circle USDC, in dust amounts the server enforces
              {caps ? (
                <>
                  : a seed of {money(caps.seedUsdDefault)}, a daily cap of at most {money(caps.dailyCapMaxUsd)}, payments of at most{' '}
                  {money(caps.agentPayMaxUsd)}, and {money(caps.sharedDailyCeilingUsd)} a day in seeds across every visitor together
                </>
              ) : null}
              .
            </p>
          )}
          <p>
            You need no wallet, no seed phrase and no XLM.{' '}
            {sponsor === true && 'Network fees are sponsored: a relayer (OpenZeppelin Channels) pays them, and each transaction below names the account that paid.'}
            {sponsor === false && (
              <span className="text-warn">
                The fee sponsor is not configured on this deployment for {info.label}, so the signing steps will report what they
                would have submitted rather than submitting it.
              </span>
            )}
            {sponsor === null && statusRead && <span className="text-warn">This deployment did not say whether fees are sponsored on {info.label}.</span>}
          </p>
          <p>
            Signing uses smart-account-kit {SMART_ACCOUNT_KIT_VERSION} against OpenZeppelin smart-account contracts
            {sa ? (
              <>
                {' '}
                (account wasm <span className="font-mono">{sa.wasmHash.slice(0, 8)}...</span>, WebAuthn verifier{' '}
                <span className="font-mono">{shortId(sa.webauthnVerifier)}</span>, as recorded for {info.label})
              </>
            ) : null}
            .
          </p>
          {sa?.verified && <p className="text-xs text-foreground/45">Where those ids come from: {sa.verified}</p>}
        </motion.div>
        {!supported && (
          <p className="mt-5 rounded-2xl border border-warn/35 bg-warn/[0.06] p-4 text-sm text-warn">
            This browser cannot create passkeys. Open this page in a current Chrome, Safari or Edge over https to run the demo;
            every step below still explains what it does.
          </p>
        )}
        {hostRefusal && <p className="mt-5 rounded-2xl border border-warn/35 bg-warn/[0.06] p-4 text-sm text-warn">{hostRefusal}</p>}
        {statusRead && !status && (
          <p className="mt-5 rounded-2xl border border-warn/35 bg-warn/[0.06] p-4 text-sm text-warn">
            The backend did not answer for {info.label}, so the caps and contract ids this page needs are unknown. Give it a few
            seconds and reload.
          </p>
        )}
        {account && (
          <div className="mt-6 max-w-[62ch]">
            <RecoveryBadge net={net} contractId={account.contractId} refreshKey={signerRefresh} />
          </div>
        )}
      </SectionShell>

      <SectionShell size="tight">
        <div className="grid gap-4">
          {/* 1 ── the passkey */}
          <StepCard
            index={1}
            title="Create your passkey"
            lede={
              <>
                No wallet and no seed phrase. The passkey's private key stays in your device's authenticator (or in the password
                manager that syncs it) and controls an OpenZeppelin smart account, a C... contract deployed for you on {info.label}.
              </>
            }
            status={accountStatus}
            chip={account ? <Chip tone="ok">smart account live</Chip> : restoring ? <Chip tone="muted">restoring</Chip> : pending ? <Chip tone="warn">not deployed yet</Chip> : undefined}
          >
            {account ? (
              <div className="grid gap-3">
                <AddressLink net={net} value={account.contractId} label="Your smart account" />
                <DeviceSummary device={account.device} />
                <div className="flex flex-wrap items-center gap-3">
                  {account.creation && <TxLink hash={account.creation.txHash} url={txUrl(net, account.creation.txHash)} label="deployed in" />}
                  <button type="button" onClick={signOut} disabled={busy !== null} className={BTN_QUIET}>
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid gap-4">
                {!pending && (
                  <div className="sm:max-w-[18rem]">
                    <label className={LABEL} htmlFor="stellar-device-name">
                      Name this device (optional)
                    </label>
                    <input
                      id="stellar-device-name"
                      type="text"
                      maxLength={20}
                      value={deviceLabel}
                      onChange={(e) => setDeviceLabel(e.target.value)}
                      placeholder="my phone"
                      className={INPUT}
                      disabled={busy !== null}
                    />
                  </div>
                )}
                {pending && (
                  <div className="grid gap-3 rounded-xl border border-warn/30 bg-warn/[0.05] p-4">
                    <AddressLink net={net} value={pending.contractId} label="Your smart account" note={<Chip tone="warn">not deployed yet</Chip>} />
                    <DeviceSummary device={pending.device} label={deviceLabel.trim() || null} />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={pending ? retryDeploy : createAccount} disabled={busy !== null || blocked || !status} className={BTN}>
                    {spin('account')}
                    {label('account', pending ? 'Finish deploying it' : 'Create a passkey account')}
                  </button>
                  {!pending && (
                    <button type="button" onClick={signIn} disabled={busy !== null || blocked || !status} className={BTN_QUIET}>
                      I already have one
                    </button>
                  )}
                </div>
              </div>
            )}
            {errors.account && <p className="mt-3 text-xs text-danger">{errors.account}</p>}
            {pending && !errors.account && busy !== 'account' && (
              <p className="mt-3 text-xs text-warn">The passkey exists on your device, but its account is not deployed yet.</p>
            )}
          </StepCard>

          {/* 2 ── the recovery position */}
          <StepCard
            index={2}
            title="Know how you recover it"
            lede="Read this before any money goes in. The vault deploy below stays locked until you tick the box."
            status={recoveryStatus}
            chip={accepted ? <Chip tone="ok">understood</Chip> : undefined}
          >
            <RecoveryNotice accepted={accepted} onAccept={setAccepted} realMoney={!testnet} disabled={busy !== null} />
          </StepCard>

          {/* 3 ── the vault and its limit */}
          <StepCard
            index={3}
            title="Deploy a vault and set its limit"
            lede={`A fresh AgentSpendPolicy vault whose owner is your smart account. The server first reads your account off the ledger and deploys only if this passkey is its one signer; it then seeds the vault with ${usdcWord}, and you sign the limit yourself, which is what proves the passkey owns it.`}
            status={vaultStatus}
            chip={vault ? <Chip tone={policyWrite?.outcome === 'settled' ? 'ok' : 'accent'}>{policyWrite?.outcome === 'settled' ? 'limit on chain' : 'vault live'}</Chip> : undefined}
          >
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="stellar-daily-cap">
                    Daily cap (USDC){caps ? `, at most ${money(caps.dailyCapMaxUsd)}` : ''}
                  </label>
                  <input
                    id="stellar-daily-cap"
                    type="number"
                    min="0"
                    max={caps?.dailyCapMaxUsd}
                    step="any"
                    inputMode="decimal"
                    value={dailyCap}
                    onChange={(e) => setDailyCap(e.target.value)}
                    disabled={!!vault}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="stellar-ceiling">
                    Per payment (USDC){caps ? `, at most ${money(caps.perPaymentMaxUsd)}` : ''}
                  </label>
                  <input
                    id="stellar-ceiling"
                    type="number"
                    min="0"
                    max={caps?.perPaymentMaxUsd}
                    step="any"
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
                  <button type="button" onClick={deployVault} disabled={busy !== null || !account || !accepted || !defaults} className={BTN}>
                    {spin('vault')}
                    {busy === 'vault' ? 'Checking your account and deploying...' : 'Deploy the vault'}
                  </button>
                  {defaults && (
                    <span className="text-xs text-foreground/50">
                      Seeded with {money(defaults.seedUsd)} {usdcWord} so it can pay.
                    </span>
                  )}
                  {account && !accepted && <span className="text-xs text-warn">Tick the box in step 2 first.</span>}
                </div>
              ) : (
                <div className="grid gap-3">
                  <AddressLink net={net} value={vault.contract} label="Your vault" />
                  {vault.ownerReadBack.read === 'live' ? (
                    <p className={`text-xs ${vault.ownerReadBack.matches ? 'text-ok' : 'text-danger'}`}>
                      owner() read back from the vault: <span className="break-all font-mono">{vault.ownerReadBack.owner}</span>
                      {vault.ownerReadBack.matches ? ', which is your smart account.' : ', which is NOT your smart account.'}
                    </p>
                  ) : (
                    <p className="text-xs text-warn">The vault's owner() could not be read back just now; the explorer link above shows it.</p>
                  )}
                  {deployWrite && <TxResult net={net} write={deployWrite.write} what="The vault deploy" feePayer={deployWrite.feePayer} decode={false} />}
                  {seed && !seed.txHash && (
                    <p className="text-xs text-warn">
                      The vault starts empty: {seed.reason ?? 'the seed transfer did not happen.'} Step 6 will be refused for want of a
                      balance until it holds some {usdcWord}.
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
                  {policyWrite && <TxResult net={net} write={policyWrite} what="The limit" />}
                </div>
              )}
              {errors.vault && <p className="text-xs text-danger">{errors.vault}</p>}
              {errors.policy && <p className="text-xs text-danger">{errors.policy}</p>}
            </div>
          </StepCard>

          {/* 4 ── the trust check */}
          <StepCard
            index={4}
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
                  placeholder="G... or C..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                  Try
                  {testnet ? (
                    <>
                      <button type="button" onClick={() => setPayee(TESTNET_PAYEES.trusted)} className={BTN_QUIET}>
                        A payee we have paid
                      </button>
                      <button type="button" onClick={() => setPayee(TESTNET_PAYEES.untrusted)} className={BTN_QUIET}>
                        The one we refused
                      </button>
                    </>
                  ) : (
                    account && (
                      <button type="button" onClick={() => setPayee(account.contractId)} className={BTN_QUIET}>
                        Your own smart account
                      </button>
                    )
                  )}
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
                      <button type="button" onClick={() => signAllowlist(plan.chainAction!.ok, plan.chainAction!.payee)} disabled={busy !== null} className={BTN}>
                        {spin('allow')}
                        {label('allow', plan.chainAction.ok ? 'Allow this payee with your passkey' : 'Revoke this payee with your passkey')}
                      </button>
                    ) : (
                      <p className="text-xs text-foreground/60">A WARN writes nothing on chain. It is a flag our server keeps, and the vault is unchanged.</p>
                    )}
                    {plan.decision !== 'ALLOW' && (
                      <button type="button" onClick={() => signAllowlist(true, plan.payee)} disabled={busy !== null} className={BTN_QUIET}>
                        Allow anyway
                      </button>
                    )}
                  </div>
                  {allowWrite && (
                    <div className="mt-3">
                      <TxResult net={net} write={allowWrite} what="The allowlist entry" />
                    </div>
                  )}
                  {errors.allow && <p className="mt-3 text-xs text-danger">{errors.allow}</p>}
                </div>
              )}
              {errors.kya && <p className="text-xs text-danger">{errors.kya}</p>}
              <p className="text-xs leading-relaxed text-foreground/50">
                The on-chain allowlist is binary: ALLOW writes an entry, WARN is a server-side flag and writes nothing, and DENY writes
                a revoke so pay() reverts with PayeeNotAllowed. Only two of the three verdicts ever touch the ledger.
              </p>
            </div>
          </StepCard>

          {/* 5 ── the refusal */}
          <StepCard
            index={5}
            title="The agent pays someone untrusted"
            lede="The agent asks the vault to pay an address that is not on the allowlist. The vault refuses before anything moves."
            status={refusedStatus}
            chip={refusal?.outcome === 'refused' ? <Chip tone="danger">refused</Chip> : undefined}
          >
            <div className="grid gap-3">
              {testnet ? (
                <AddressLink net={net} value={TESTNET_PAYEES.untrusted} label="Untrusted payee" />
              ) : (
                <div>
                  <label className={LABEL} htmlFor="stellar-untrusted">
                    An address you have not allowed
                  </label>
                  <input
                    id="stellar-untrusted"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={untrusted}
                    onChange={(e) => setUntrusted(e.target.value)}
                    placeholder="G... or C..."
                    className={`${INPUT} font-mono text-xs`}
                  />
                  <p className="mt-1 text-[11px] text-foreground/50">Any Stellar address that is not on your allowlist. A refused payment moves nothing and costs nothing.</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => pay('refused', untrusted.trim())}
                  disabled={busy !== null || !vault || !payUsd || !isAddress(untrusted)}
                  className={BTN}
                >
                  {spin('refused')}
                  {busy === 'refused' ? 'Asking the vault...' : `Try to pay ${money(payUsd)}`}
                </button>
              </div>
              {refusal?.outcome === 'refused' && (
                <div className="rounded-xl border border-danger/30 bg-danger/[0.05] p-4">
                  <p className="text-sm font-semibold text-danger">
                    {refusal.contractErrorName ?? 'refused'}
                    {refusal.contractErrorCode != null ? ` (#${refusal.contractErrorCode})` : ''}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-foreground/65">
                    {refusal.note ??
                      'The vault rejected the call in simulation, so no transaction was ever submitted and there is no hash to show. A refused payment costs nothing and leaves no ledger entry.'}
                  </p>
                  {testnet && (
                    <>
                      <p className="mt-3 text-[13px] leading-relaxed text-foreground/65">
                        For what the same refusal looks like ON a ledger, here is one recorded on testnet, from a rehearsal where the payee
                        was revoked while the agent's transaction was already in flight, so it landed and reverted:
                      </p>
                      <p className="mt-2">
                        <TxLink hash={RECORDED_TESTNET_REFUSAL} url={txUrl('stellar:testnet', RECORDED_TESTNET_REFUSAL)} label="testnet refusal on chain" />
                      </p>
                    </>
                  )}
                </div>
              )}
              {refusal && refusal.outcome !== 'refused' && refusal.outcome !== 'settled' && <p className="text-xs text-warn">{refusal.reason}</p>}
              {refusal?.outcome === 'settled' && (
                <p className="text-xs text-warn">
                  This payment settled, which means the payee was on the allowlist after all (or the allowlist is not on yet: sign the
                  limit in step 3). <TxLink hash={refusal.txHash} url={refusal.explorerUrl} />
                </p>
              )}
              {errors.refused && <p className="text-xs text-danger">{errors.refused}</p>}
            </div>
          </StepCard>

          {/* 6 ── the payment */}
          <StepCard
            index={6}
            title="The agent pays someone trusted"
            lede="Same vault, same agent, same amount. This payee is on the allowlist and inside the limit, so the payment settles. Our operator key signs this one, inside the policy your passkey set."
            status={paidStatus}
            chip={payment?.outcome === 'settled' ? <Chip tone="ok">settled</Chip> : undefined}
          >
            <div className="grid gap-3">
              {payTarget ? (
                <AddressLink
                  net={net}
                  value={payTarget}
                  label={allowedPayee ? 'The payee you allowed' : testnet ? 'Trusted payee' : 'Your own smart account'}
                />
              ) : (
                <p className="text-xs text-foreground/55">Create your passkey account first; on mainnet the trusted payee is your own smart account.</p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => pay('settled', payTarget)} disabled={busy !== null || !vault || !payTarget || !payUsd} className={BTN}>
                  {spin('settled')}
                  {busy === 'settled' ? 'Paying...' : `Pay ${money(payUsd)}`}
                </button>
                {!allowedPayee && <span className="text-xs text-foreground/50">Allow it in step 4 first, or the vault will refuse this too.</span>}
              </div>
              {payment?.outcome === 'settled' && (
                <TxResult
                  net={net}
                  write={{ outcome: 'settled', txHash: payment.txHash, ledger: payment.ledger, explorerUrl: payment.explorerUrl }}
                  what="The payment"
                  feePayer={payment.feePayer}
                  decode={false}
                />
              )}
              {payment?.outcome === 'refused' && (
                <p className="text-xs text-warn">
                  The vault refused it: {payment.contractErrorName ?? 'contract error'}
                  {payment.contractErrorCode != null ? ` (#${payment.contractErrorCode})` : ''}. {payment.note ?? 'Allow the payee in step 4, then try again.'}
                </p>
              )}
              {payment && payment.outcome !== 'settled' && payment.outcome !== 'refused' && <p className="text-xs text-warn">{payment.reason}</p>}
              {errors.settled && <p className="text-xs text-danger">{errors.settled}</p>}
            </div>
          </StepCard>

          {/* 7 ── the owner's levers */}
          <StepCard
            index={7}
            title="Freeze it, or take the money back"
            lede="The owner's own controls, signed by your passkey through the smart account: a freeze that stops every agent payment, and a withdrawal back to you. The operator key can do neither."
            status={ownerStatus}
          >
            {vault && account ? (
              <OwnerActions
                net={net}
                vault={vault.contract}
                smartAccount={account.contractId}
                onSettled={(r) => addReceipt({ key: `owner-${r.write.txHash}`, label: `${r.label}, signed by the passkey`, txHash: r.write.txHash, explorerUrl: r.write.explorerUrl })}
              />
            ) : (
              <p className="text-xs text-foreground/55">Deploy the vault in step 3 first.</p>
            )}
          </StepCard>

          {/* 8 ── a second device */}
          <StepCard
            index={8}
            title="Add another device"
            lede="One passkey on one device is one point of failure. A second device gets its own rule on your smart account, so either can sign alone."
            status={deviceStatus}
          >
            {account ? (
              <AddDevice
                net={net}
                disabled={busy !== null || blocked}
                onAdded={() => setSignerRefresh((n) => n + 1)}
              />
            ) : (
              <p className="text-xs text-foreground/55">Create your passkey account in step 1 first.</p>
            )}
          </StepCard>
        </div>
      </SectionShell>

      {/* The receipt strip: everything this session put on the ledger, in order. */}
      <SectionShell size="tight">
        <motion.div {...reveal}>
          <DisplayHeading size="section">Your receipts</DisplayHeading>
        </motion.div>
        <motion.p {...reveal} className="mt-3 max-w-[62ch] text-[15px] text-foreground/65">
          Every transaction this page put on {info.label}, in the order it happened. Nothing is listed here without a hash that made a
          ledger.
        </motion.p>
        <motion.div {...reveal} className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
          {receipts.length === 0 ? (
            <p className="p-5 text-sm text-foreground/55">No transactions yet. Run step 1 and this fills itself in.</p>
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
            <a href={contractUrl(net, vault.contract)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-accent hover:underline">
              {shortId(vault.contract)}
            </a>{' '}
            on stellar.expert ({info.short}).
          </motion.p>
        )}
      </SectionShell>

      <SectionShell size="tight">
        <motion.div {...reveal} className="rounded-2xl border border-border bg-card p-6 sm:p-7">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">
            <ShieldCheck size={14} /> Stated plainly
          </div>
          <ul className="mt-3 grid gap-2 text-[15px] leading-relaxed text-foreground/70 sm:grid-cols-2 sm:gap-x-8">
            {testnet ? (
              <li>This side is Stellar testnet and test USDC. Nothing on it moves real money, and a testnet reset takes it all with it.</li>
            ) : (
              <li>This side is Stellar mainnet. The USDC is real and the amounts are dust, capped by the server for every visitor.</li>
            )}
            <li>A refused payment fails in simulation, so it has no hash.{testnet ? ' The linked refusal is a recorded one from a testnet rehearsal.' : ''}</li>
            <li>
              The passkey's private key never leaves your authenticator. Our server holds the vault's operator key: it can call pay()
              inside the cap and ceiling you signed, and with the allowlist on only to payees you allowed. It cannot withdraw, change
              your limit, unfreeze the vault or add a signer.
            </li>
            <li>Lose every device with this passkey and the vault's funds are unreachable; nobody, including A-Identity, can recover them.</li>
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
    </>
  )
}

/** One sentence for a write that did not settle, naming what was being attempted. */
function writeMessage(write: ChainWrite, what: string): string {
  if (write.outcome === 'prepared') return `The fee sponsor is not configured on this deployment, so ${what.toLowerCase()} and nothing was submitted.`
  if (write.outcome === 'refused') return `${what}: ${write.reason}`
  return `${what}: ${write.outcome === 'failed' ? write.reason : 'no transaction was returned.'}`
}
