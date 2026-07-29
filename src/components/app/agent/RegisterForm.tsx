import { useState } from 'react'
import { BadgeCheck, CheckCircle2 } from 'lucide-react'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { invalidatePlatformAgents } from '../../../lib/platformAgents'
import { Button } from '../../ui/button'
import { OwlMascot } from '../../OwlMascot'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'

const CAPABILITIES = ['Payments', 'Purchases', 'Rentals', 'Batch actions'] as const

/**
 * Full onboarding: identity details, capabilities, KYA permissions, a real Arc
 * testnet wallet (key shown once, never stored), then registration. The on-chain
 * anchor is queued for human approval; everything else happens for real against
 * the local platform backend.
 */
const CATEGORIES = [
  'Trading / Finance',
  'Research / Data',
  'Content / Writing',
  'DevOps / Code',
  'Customer Support',
  'Other',
]

export default function RegisterForm({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0])
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

  const input =
    'w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none transition-colors focus:border-accent'
  const label = 'text-xs font-semibold text-foreground/50'

  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

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
      setAnchorNote('Anchoring timed out. It runs on-chain and can be slow — give it a moment and try again.')
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
      setKyaNote('KYA timed out. The backend may be waking up — try again in a moment.')
    } finally {
      setKyaBusy(false)
    }
  }

  if (done) {
    return (
      <div className="relative mt-5 overflow-hidden rounded-2xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 p-6">
        {/* The owl marks the good outcome. Decorative, so it stays out of the a11y tree and
            never overlaps the text: it sits in the card's empty top-right corner. */}
        <OwlMascot
          variant="geometric"
          width={264}
          className="pointer-events-none absolute -right-14 -top-16 hidden w-[264px] select-none opacity-90 sm:block"
        />
        <div className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={18} /> {name} is registered.
        </div>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm text-foreground/70">
          <li>Permissions set (daily cap, auto-approve).</li>
          {kya?.verified ? (
            <li>KYA verified: wallet control proven.</li>
          ) : (
            <li>KYA pending: prove the agent controls its wallet below.</li>
          )}
          {wallet && <li>Wallet {wallet.address.slice(0, 10)}... is assigned to it.</li>}
          {!anchored && <li>On-chain anchor is queued. Anchor it on Arc to mint a real ERC-8004 identity.</li>}
        </ul>

        {/* On-chain anchor: real ERC-8004 registration on Arc, human-triggered */}
        {anchored ? (
          <div className="mt-4 rounded-xl border border-[#2775CA]/25 bg-[#2775CA]/[0.05] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#2775CA]">
              <BadgeCheck size={16} /> Anchored on Arc: ERC-8004 id #{anchored.onchainAgentId ?? '?'}
            </div>
            {anchored.onchainExplorer && (
              <a
                href={anchored.onchainExplorer}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block break-all text-xs font-semibold text-[#2775CA] hover:underline"
              >
                View transaction on arcscan
              </a>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <button
              type="button"
              onClick={anchorOnchain}
              disabled={anchorBusy}
              className="rounded-full border border-[#2775CA]/30 px-4 py-2 text-sm font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
            >
              {anchorBusy ? 'Anchoring on Arc...' : 'Anchor on Arc (register on-chain)'}
            </button>
            {anchorNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{anchorNote}</p>}
          </div>
        )}

        {/* KYA: prove the agent controls its wallet (real signature, not a stamp) */}
        {wallet && (
          <div className="mt-4">
            {kya?.verified ? (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  <BadgeCheck size={16} /> KYA verified: wallet control proven
                </div>
                {kya.onchainExplorer ? (
                  <a
                    href={kya.onchainExplorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block break-all text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                  >
                    Attested on-chain: ERC-8004 ValidationRegistry (view tx)
                  </a>
                ) : (
                  <p className="mt-1 text-xs text-foreground/45">Anchor on Arc to also record this on the ERC-8004 ValidationRegistry.</p>
                )}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={proveKya}
                  disabled={kyaBusy}
                  className="rounded-full border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                >
                  {kyaBusy ? 'Proving wallet control...' : 'Prove wallet control (KYA)'}
                </button>
                <p className="mt-2 text-xs text-foreground/45">
                  Signs a challenge with your agent's wallet key (in your browser)
                  {anchored ? ' and records it on the ERC-8004 ValidationRegistry.' : '. Anchor first for an on-chain attestation.'}
                </p>
                {kyaNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{kyaNote}</p>}
              </>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-3">
          <Button asChild size="sm" className="text-sm">
            <a href="/app/marketplace">See it in Agent House</a>
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-5 flex flex-col gap-5">
      {/* 1. Identity */}
      <div>
        <div className={label}>1. Identity</div>
        <div className="mt-2 flex flex-col gap-3">
          <input className={input} placeholder="Agent name (e.g. My Trading Agent)" value={name} onChange={(e) => setName(e.target.value)} required />
          <div>
            <input className={input} placeholder="What does this agent do? (shown in Agent House)" value={desc} onChange={(e) => setDesc(e.target.value)} required minLength={20} />
            <p className="mt-1 text-[11px] text-foreground/45">
              At least 20 characters. Verified agents with a description appear in the Agent House showcase.
            </p>
          </div>
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* 2. Capabilities */}
      <div>
        <div className={label}>2. What it is allowed to do</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {CAPABILITIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCap(c)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                caps.includes(c)
                  ? 'bg-accent text-white'
                  : 'border border-foreground/15 text-foreground/60 hover:bg-foreground/5'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 3. KYA permissions */}
      <div>
        <div className={label}>3. Permissions (set at KYA, like card limits)</div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[11px] text-foreground/45">Daily cap (USD)</div>
            <input className={input} type="number" min="0" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-foreground/45">Auto-approve under (USD)</div>
            <input className={input} type="number" min="0" step="0.1" value={autoApprove} onChange={(e) => setAutoApprove(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={a2a} onChange={(e) => setA2a(e.target.checked)} className="accent-[#7342E2]" />
            Agent-to-agent payments
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={a2h} onChange={(e) => setA2h(e.target.checked)} className="accent-[#7342E2]" />
            Agent-to-human payments
          </label>
        </div>
      </div>

      {/* 4. Wallet */}
      <div>
        <div className={label}>4. Arc testnet wallet</div>
        {!wallet ? (
          <button
            type="button"
            onClick={createWallet}
            disabled={walletBusy}
            className="mt-2 rounded-full border border-[#2775CA]/30 px-4 py-2.5 text-sm font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
          >
            {walletBusy ? 'Creating...' : 'Create wallet (generated in your browser)'}
          </button>
        ) : (
          <div className="mt-2 rounded-xl border border-[#2775CA]/25 bg-[#2775CA]/[0.04] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-foreground/50">Address</div>
              <button type="button" onClick={copyAddress} className="text-[11px] font-semibold text-[#2775CA] hover:underline">
                {copiedAddr ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="break-all font-mono text-xs text-foreground">{wallet.address}</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-red-600">
                Private key (generated in your browser, the server never sees it)
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="text-[11px] font-semibold text-[#2775CA] hover:underline"
                >
                  {showKey ? 'Hide' : 'Reveal'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(wallet.privateKey)
                      setCopiedKey(true)
                      setTimeout(() => setCopiedKey(false), 1500)
                    } catch {
                      setShowKey(true) // clipboard blocked, reveal so it can be copied by hand
                    }
                  }}
                  className="text-[11px] font-semibold text-[#2775CA] hover:underline"
                >
                  {copiedKey ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="break-all font-mono text-xs text-foreground/70">
              {showKey ? wallet.privateKey : '•'.repeat(48)}
            </div>
            <p className="mt-1 text-[11px] text-foreground/45">
              Save it now. It is shown once and never stored. Reveal only somewhere no one can see your screen.
            </p>
            <label className="mt-2 flex items-start gap-2 text-[11px] font-medium text-foreground/70">
              <input
                type="checkbox"
                checked={keySaved}
                onChange={(e) => setKeySaved(e.target.checked)}
                className="mt-0.5 accent-[#7342E2]"
              />
              I saved this private key somewhere safe. A-Identity never stores it and cannot recover it.
            </label>
            <a
              href="https://faucet.circle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-[#2775CA] hover:underline"
            >
              Fund it with testnet USDC at faucet.circle.com
            </a>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={checkFunded}
                disabled={fundBusy}
                className="rounded-full border border-[#2775CA]/30 px-3 py-1.5 text-[11px] font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
              >
                {fundBusy ? 'Checking...' : 'I funded it, check balance'}
              </button>
              {fundBal != null && (
                <span className={`text-[11px] font-semibold ${fundBal > 0 ? 'text-emerald-600' : 'text-foreground/50'}`}>
                  {fundBal > 0 ? `Funded: ${fundBal.toFixed(4)} USDC` : 'Still 0 USDC, give the faucet a moment and check again'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button
        type="button"
        size="lg"
        onClick={submit}
        disabled={submitBusy || (!!wallet && !keySaved)}
      >
        {submitBusy ? 'Registering...' : 'Pass KYA and register on Arc testnet'}
      </Button>
      <p className="text-xs text-foreground/45">
        Registration writes to the A-Identity registry now; the on-chain anchor is queued and
        broadcast only after a human approves it.
      </p>
    </div>
  )
}
