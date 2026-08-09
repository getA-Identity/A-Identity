import { useState } from 'react'
import { Check, CheckCircle2, ChevronDown, Loader2, Terminal } from 'lucide-react'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { invalidatePlatformAgents } from '../../../lib/platformAgents'
import { useTabCarousel } from '../../../hooks/useTabCarousel'
import { Button } from '../../ui/button'
import CopyBlock from '../CopyBlock'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'
import { CATEGORIES, MCP_ADD_CMD, REGISTER_CURL, STEP_META, STEPS, type Step } from './register-constants'
import RegisterSuccess from './RegisterSuccess'
import IdentityStep from './steps/IdentityStep'
import CapabilitiesStep from './steps/CapabilitiesStep'
import PermissionsStep from './steps/PermissionsStep'
import WalletStep from './steps/WalletStep'
import ReviewStep from './steps/ReviewStep'

/**
 * Full onboarding: identity details, capabilities, KYA permissions, a real Arc
 * testnet wallet (key shown once, never stored), then registration. The on-chain
 * anchor is queued for human approval; everything else happens for real against
 * the local platform backend.
 */
export default function RegisterForm({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  /** Square logo as a small data: URL (client-side resized to 96px before upload). */
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoErr, setLogoErr] = useState<string | null>(null)

  const onLogoPick = (file: File | undefined) => {
    setLogoErr(null)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLogoErr('Pick an image file.')
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      // Downscale to a 96px square (cover-cropped) so the stored data URL stays tiny.
      const SIZE = 96
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setLogoErr('Could not read the image.')
        URL.revokeObjectURL(url)
        return
      }
      const side = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
      const data = canvas.toDataURL('image/png')
      URL.revokeObjectURL(url)
      if (data.length > 150_000) {
        setLogoErr('That image compresses too large; try a simpler one.')
        return
      }
      setLogoUrl(data)
    }
    img.onerror = () => {
      setLogoErr('Could not read the image.')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }
  const [category, setCategory] = useState(CATEGORIES[0])
  /** Optional profile-hero accent: 1..6 maps to --cat-1..--cat-6, undefined means default. */
  const [cardStyle, setCardStyle] = useState<number | undefined>(undefined)
  const [caps, setCaps] = useState<string[]>(['Payments'])
  const [dailyCap, setDailyCap] = useState('50')
  const [autoApprove, setAutoApprove] = useState('1')
  const [a2a, setA2a] = useState(true)
  const [a2h, setA2h] = useState(false)

  const [wallet, setWallet] = useState<{ address: string; privateKey: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [fundBusy, setFundBusy] = useState(false)
  const [fundBal, setFundBal] = useState<number | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [submitBusy, setSubmitBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [anchorBusy, setAnchorBusy] = useState(false)
  const [anchored, setAnchored] = useState<{ onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string } | null>(null)
  const [anchorNote, setAnchorNote] = useState<string | null>(null)
  const [kyaBusy, setKyaBusy] = useState(false)
  const [kya, setKya] = useState<{ verified: boolean; onchainTx?: string; onchainExplorer?: string } | null>(null)
  const [kyaNote, setKyaNote] = useState<string | null>(null)

  // Wizard position. The pane carousel shows the committed step; the indicator and
  // the Next/Back buttons act on the target step, same split the profile tabs use.
  const [step, setStep] = useState<Step>('identity')
  const stepIdx = STEPS.indexOf(step)
  const { shown: shownStep, className: paneClass } = useTabCarousel(step, STEPS)

  // Self-serve paths: copy-paste commands for agents, plus quick register by manifest URL.
  const [selfOpen, setSelfOpen] = useState(false)
  const [quickUrl, setQuickUrl] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [quickNote, setQuickNote] = useState<string | null>(null)
  const [quickDone, setQuickDone] = useState<{ agentId: string; onchain: string; kya: string } | null>(null)
  /** Collapsed reference of the fields the manifest registrar actually reads. */
  const [manifestOpen, setManifestOpen] = useState(false)

  const input =
    'w-full rounded-xl border border-border bg-background/40 px-3 py-2.5 text-sm outline-none transition-colors focus:border-accent'
  const label = 'text-xs font-semibold text-foreground/50'

  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  /** What blocks leaving this step, if anything. Mirrors the final submit guards. */
  const stepBlocker = (s: Step): string | null => {
    if (s === 'identity') {
      if (!name.trim()) return 'Give the agent a name.'
      if (desc.trim().length < 20)
        return 'Describe what this agent does (at least 20 characters), so it can appear in the Agent House showcase.'
      if (!category) return 'Pick a category.'
    }
    if (s === 'capabilities' && caps.length === 0) return 'Pick at least one capability.'
    if (s === 'wallet' && wallet && !keySaved) return 'Confirm you saved the private key before continuing.'
    return null
  }

  const goNext = () => {
    const blocker = stepBlocker(step)
    if (blocker) {
      setError(blocker)
      return
    }
    setError(null)
    setStep(STEPS[Math.min(stepIdx + 1, STEPS.length - 1)])
  }

  const goBack = () => {
    setError(null)
    setStep(STEPS[Math.max(stepIdx - 1, 0)])
  }

  const createWallet = async () => {
    setWalletBusy(true)
    setError(null)
    try {
      // Generate the keypair IN THE BROWSER. The private key never touches the server.
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
      const privateKey = generatePrivateKey()
      const address = privateKeyToAccount(privateKey).address
      // Register only the public address with the backend.
      const res = await apiFetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ address }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setError(null)
      setWallet({ address, privateKey })
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setWalletBusy(false)
    }
  }

  const copyAddress = async () => {
    if (!wallet) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopiedAddr(true)
      setTimeout(() => setCopiedAddr(false), 1500)
    } catch { /* clipboard blocked; the address is visible to copy by hand */ }
  }

  // "I funded it": poll the live on-chain balance so the demo never waits on a manual
  // page refresh after using the Circle faucet.
  const checkFunded = async () => {
    if (!wallet) return
    setFundBusy(true)
    try {
      const r = await apiFetch(`/api/wallet-balance?address=${wallet.address}`)
      const d = await readJson<{ balance?: string | null }>(r)
      setFundBal(d.balance != null ? Number(d.balance) : 0)
    } catch {
      setFundBal(null)
    } finally {
      setFundBusy(false)
    }
  }

  const submit = async () => {
    if (!name.trim()) { setError('Give the agent a name.'); return }
    if (desc.trim().length < 20) { setError('Describe what this agent does (at least 20 characters), so it can appear in the Agent House showcase.'); return }
    if (wallet && !keySaved) { setError('Confirm you saved the private key before continuing.'); return }
    setSubmitBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim(),
          category,
          capabilities: caps,
          logoUrl: logoUrl ?? undefined,
          cardStyle,
          permissions: {
            dailyCapUsd: Number(dailyCap) || 50,
            autoApproveUnderUsd: Number(autoApprove) || 1,
            agentToAgent: a2a,
            agentToHuman: a2h,
          },
          walletAddress: wallet?.address,
        }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      const data = await readJson<{ agent?: { id: string }; error?: string }>(res)
      if (res.ok && data.agent) {
        setError(null)
        invalidatePlatformAgents() // a new agent joined the list; refresh every screen that lists agents
        onCreated?.(data.agent.id) // select it on the parent so it shows immediately
        setDone(data.agent.id)
      } else {
        setError(explainError(res.status, data.error))
      }
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setSubmitBusy(false)
    }
  }

  // Quick register: the backend fetches a hosted manifest URL and registers from it.
  // Same roster refresh as a wizard registration; failures surface the server's answer.
  const quickRegister = async () => {
    const url = quickUrl.trim()
    if (!url) {
      setQuickNote('Paste the public URL of your agent manifest first.')
      return
    }
    setQuickBusy(true)
    setQuickNote(null)
    setQuickDone(null)
    try {
      const res = await apiFetch('/api/agents/register-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ url }),
        onWaking: () => setQuickNote('Waking up the backend (free tier)…'),
      })
      const data = await readJson<{
        agentId?: string
        erc8004Status?: { onchain?: string; kya?: string }
        error?: string
      }>(res)
      if (res.status === 201 && data.agentId) {
        setQuickNote(null)
        invalidatePlatformAgents() // a new agent joined the list; refresh every screen that lists agents
        onCreated?.(data.agentId) // select it on the parent so it shows immediately
        setQuickDone({
          agentId: data.agentId,
          onchain: data.erc8004Status?.onchain ?? 'queued',
          kya: data.erc8004Status?.kya ?? 'unverified',
        })
      } else {
        setQuickNote(explainError(res.status, data.error))
      }
    } catch {
      setQuickNote(BACKEND_UNREACHABLE)
    } finally {
      setQuickBusy(false)
    }
  }

  // Deliberate, human-triggered on-chain anchor: broadcasts a real ERC-8004
  // registration on Arc and shows the tx. Env-gated behind ARC_SIGNER_KEY server-side.
  const anchorOnchain = async () => {
    if (!done) return
    setAnchorBusy(true)
    setAnchorNote(null)
    try {
      const res = await apiFetch('/api/agents/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done }),
        timeoutMs: 90_000, // an on-chain ERC-8004 register can take a while to confirm
        onWaking: () => setAnchorNote('Waking up the backend (free tier)…'),
      })
      const data = await readJson<{
        agent?: { onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string }
        result?: { executed?: boolean; reason?: string }
        error?: string
      }>(res)
      if (res.ok && data.result?.executed && data.agent) {
        invalidatePlatformAgents() // on-chain status changed, refresh every screen that lists agents
        setAnchorNote(null)
        setAnchored(data.agent)
      } else if (!res.ok) {
        setAnchorNote(explainError(res.status, data.error))
      } else {
        setAnchorNote(data.result?.reason ?? data.error ?? 'Could not broadcast. The server needs a funded ARC_SIGNER_KEY.')
      }
    } catch {
      setAnchorNote('Anchoring timed out. It runs on-chain and can be slow, give it a moment and try again.')
    } finally {
      setAnchorBusy(false)
    }
  }

  // Real KYA: prove the agent controls its wallet by signing a challenge with the
  // key generated in the browser. On success the backend also attests the result on
  // the ERC-8004 ValidationRegistry (if the agent is anchored + a signer key is set).
  const proveKya = async () => {
    if (!done || !wallet) return
    setKyaBusy(true)
    setKyaNote(null)
    try {
      const chRes = await apiFetch('/api/agents/kya/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done }),
        onWaking: () => setKyaNote('Waking up the backend (free tier)…'),
      })
      const ch = await readJson<{ message?: string; error?: string }>(chRes)
      if (!chRes.ok || !ch.message) { setKyaNote(explainError(chRes.status, ch.error) ?? 'Could not start the KYA challenge.'); return }
      const { privateKeyToAccount } = await import('viem/accounts')
      const signature = await privateKeyToAccount(wallet.privateKey as `0x${string}`).signMessage({ message: ch.message })
      const vRes = await apiFetch('/api/agents/kya/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done, message: ch.message, signature }),
        timeoutMs: 90_000, // verify also attests on the ERC-8004 ValidationRegistry (on-chain)
      })
      const v = await readJson<{ kya?: string; onchain?: { txHash?: string; explorerUrl?: string }; error?: string }>(vRes)
      if (vRes.ok && v.kya === 'verified') {
        setKyaNote(null)
        invalidatePlatformAgents() // KYA flipped to verified; refresh the roster/showcase
        setKya({ verified: true, onchainTx: v.onchain?.txHash, onchainExplorer: v.onchain?.explorerUrl })
      } else {
        setKyaNote(explainError(vRes.status, v.error) ?? 'KYA verification failed.')
      }
    } catch {
      setKyaNote('KYA timed out. The backend may be waking up, try again in a moment.')
    } finally {
      setKyaBusy(false)
    }
  }

  if (done) {
    return (
      <RegisterSuccess
        name={name}
        wallet={wallet}
        kya={kya}
        kyaBusy={kyaBusy}
        kyaNote={kyaNote}
        anchored={anchored}
        anchorBusy={anchorBusy}
        anchorNote={anchorNote}
        anchorOnchain={anchorOnchain}
        proveKya={proveKya}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="mt-5 flex flex-col gap-5">
      {/* Are you an agent? Self-serve register paths: the same commands the profile
          Metadata tab publishes, so an agent can register itself in 1-5 minutes. */}
      <section className="overflow-hidden rounded-2xl border border-border bg-background/40">
        <button
          type="button"
          onClick={() => setSelfOpen((v) => !v)}
          aria-expanded={selfOpen}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2.5">
            <Terminal size={16} className="shrink-0 text-accent" />
            <span>
              <span className="block text-sm font-bold text-foreground/85">Are you an agent?</span>
              <span className="block text-xs text-foreground/55">
                Register yourself from a terminal or IDE in 1 to 5 minutes. No wizard needed.
              </span>
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`shrink-0 text-foreground/45 transition-transform duration-200 ${selfOpen ? 'rotate-180' : ''}`}
          />
        </button>
        <div className={`cn-collapse ${selfOpen ? 'cn-open' : ''}`}>
          <div className="flex flex-col gap-3 border-t border-border px-4 py-4">
            <CopyBlock
              title="MCP server"
              subtitle="Add the A-Identity MCP server to any client (Claude Code shown), then call the register_agent tool."
              text={MCP_ADD_CMD}
            />
            <CopyBlock
              title="Self-register over REST"
              subtitle="Agents register themselves with one manifest-shaped POST (verified session cookie or bearer required)."
              text={REGISTER_CURL}
            />
          </div>
        </div>
      </section>

      {/* Already have a metadata URL? Quick register: the backend fetches the hosted
          manifest and registers from it. Real outcome only; errors are the server's. */}
      <section className="rounded-2xl border border-border bg-background/40 p-4">
        <h3 className="text-sm font-bold text-foreground/85">Already have a metadata URL? Quick register</h3>
        <p className="mt-0.5 text-xs text-foreground/55">
          Point the registrar at your hosted agent manifest and skip the wizard. It must be a URL
          that serves the raw JSON itself, not an explorer or listing page that shows it.
        </p>
        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
          <input
            className={input}
            type="url"
            placeholder="https://your-agent.example.com/.well-known/agent-manifest.json"
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
          />
          <button
            type="button"
            onClick={quickRegister}
            disabled={quickBusy}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-50"
          >
            {quickBusy && <Loader2 size={14} className="animate-spin" />}
            {quickBusy ? 'Registering...' : 'Quick register'}
          </button>
        </div>
        {quickNote && <p className="mt-2 text-xs text-warn">{quickNote}</p>}
        {quickDone && (
          <div className="mt-3 rounded-xl border border-ok/25 bg-ok/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-ok">
              <CheckCircle2 size={16} /> Registered from your manifest.
            </div>
            <div className="mt-1 break-all font-mono text-xs text-foreground/70">{quickDone.agentId}</div>
            <p className="mt-1 text-xs text-foreground/55">
              On-chain: {quickDone.onchain} · KYA: {quickDone.kya}. It is selected in your roster above.
            </p>
            <a
              href={`/app/marketplace/${quickDone.agentId}`}
              className="mt-1.5 inline-block text-xs font-semibold text-accent hover:underline"
            >
              View its profile
            </a>
          </div>
        )}

        {/* What the registrar reads from the hosted JSON. Mirrors the backend's
            registerAgentFromManifest exactly; only `name` is required. */}
        <div className="mt-3 border-t border-border">
          <button
            type="button"
            onClick={() => setManifestOpen((v) => !v)}
            aria-expanded={manifestOpen}
            className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
          >
            <span className="text-xs font-bold text-foreground/70">Manifest fields</span>
            <ChevronDown
              size={14}
              className={`shrink-0 text-foreground/45 transition-transform duration-200 ${manifestOpen ? 'rotate-180' : ''}`}
            />
          </button>
          <div className={`cn-collapse ${manifestOpen ? 'cn-open' : ''}`}>
            <div className="pb-2">
              <p className="text-[11px] text-foreground/50">
                The registrar reads these top-level fields from your hosted JSON. Only name is required;
                everything else is optional.
              </p>
              <dl className="mt-2 flex flex-col gap-1.5">
                {(
                  [
                    ['name', 'Required. The agent\'s display name.'],
                    ['description', 'What the agent does. Verified agents with a description appear in the Agent House showcase.'],
                    ['category', 'Free-form category string. Defaults to Other.'],
                    ['capabilities', 'Array of strings. Without services, each capability becomes a hireable service.'],
                    ['services', 'Array of { name, priceUsd, unit } the agent sells.'],
                    ['endpoint', 'Public URL where the agent can be called. Agents with one are listed as online.'],
                    ['walletAddress', 'The wallet the agent pays and gets paid with.'],
                    ['cardStyle', 'Whole number 1 to 6. Themes the agent\'s public profile hero.'],
                    ['ci', 'true marks a canary or monitoring agent; its activity is excluded from traction headlines.'],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-[11px]">
                    <dt className="w-28 shrink-0 font-mono font-semibold text-foreground/70">{k}</dt>
                    <dd className="text-foreground/55">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* Step indicator: numbered dots, accent for the active step, completed steps
          are clickable to go back. */}
      <div className="flex items-start" aria-label="Registration steps">
        {STEP_META.map(({ id, label: stepLabel }, i) => {
          const stepDone = i < stepIdx
          const active = i === stepIdx
          return (
            <div key={id} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                {i > 0 && (
                  <div className={`cn-wiz-line h-0.5 flex-1 ${stepDone || active ? 'bg-accent' : 'bg-foreground/15'}`} />
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (i < stepIdx) {
                      setError(null)
                      setStep(id)
                    }
                  }}
                  disabled={i >= stepIdx}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${stepLabel}`}
                  className={`cn-wiz-dot grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 text-xs font-bold ${
                    stepDone
                      ? 'border-accent bg-accent text-white'
                      : active
                        ? 'cn-wiz-active border-accent bg-card text-accent'
                        : 'border-foreground/15 bg-card text-foreground/35'
                  }`}
                >
                  {stepDone ? <Check size={14} /> : i + 1}
                </button>
                {i < STEP_META.length - 1 && (
                  <div className={`cn-wiz-line h-0.5 flex-1 ${stepDone ? 'bg-accent' : 'bg-foreground/15'}`} />
                )}
              </div>
              <div className={`mt-1.5 text-center text-[11px] font-bold ${stepDone || active ? 'text-accent' : 'text-foreground/50'}`}>
                {stepLabel}
              </div>
            </div>
          )
        })}
      </div>

      {/* One step at a time; panes travel on the same carousel the console tabs use. */}
      <div className="cn-tab-clip">
        <div className={paneClass}>
          {shownStep === 'identity' && (
            <IdentityStep
              name={name}
              setName={setName}
              desc={desc}
              setDesc={setDesc}
              category={category}
              setCategory={setCategory}
              logoUrl={logoUrl}
              setLogoUrl={setLogoUrl}
              logoErr={logoErr}
              onLogoPick={onLogoPick}
              cardStyle={cardStyle}
              setCardStyle={setCardStyle}
              input={input}
              label={label}
            />
          )}

          {shownStep === 'capabilities' && (
            <CapabilitiesStep caps={caps} toggleCap={toggleCap} label={label} />
          )}

          {shownStep === 'permissions' && (
            <PermissionsStep
              dailyCap={dailyCap}
              setDailyCap={setDailyCap}
              autoApprove={autoApprove}
              setAutoApprove={setAutoApprove}
              a2a={a2a}
              setA2a={setA2a}
              a2h={a2h}
              setA2h={setA2h}
              input={input}
              label={label}
            />
          )}

          {shownStep === 'wallet' && (
            <WalletStep
              wallet={wallet}
              walletBusy={walletBusy}
              createWallet={createWallet}
              copiedAddr={copiedAddr}
              copyAddress={copyAddress}
              showKey={showKey}
              setShowKey={setShowKey}
              copiedKey={copiedKey}
              setCopiedKey={setCopiedKey}
              keySaved={keySaved}
              setKeySaved={setKeySaved}
              fundBusy={fundBusy}
              fundBal={fundBal}
              checkFunded={checkFunded}
              label={label}
            />
          )}

          {shownStep === 'review' && (
            <ReviewStep
              value={{ name, desc, category, caps, logoUrl, cardStyle, dailyCap, autoApprove, a2a, a2h, wallet }}
              label={label}
            />
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Wizard navigation. The final step carries the one real submit. */}
      <div className="flex items-center justify-between gap-3">
        {stepIdx > 0 ? (
          <button
            type="button"
            onClick={goBack}
            className="rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70 transition-colors hover:bg-foreground/5"
          >
            Back
          </button>
        ) : (
          <span />
        )}
        {step !== 'review' ? (
          <Button type="button" onClick={goNext}>
            Next
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            onClick={submit}
            disabled={submitBusy || (!!wallet && !keySaved)}
          >
            {submitBusy ? 'Registering...' : 'Pass KYA and register on Arc testnet'}
          </Button>
        )}
      </div>
    </div>
  )
}
