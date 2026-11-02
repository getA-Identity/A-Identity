/**
 * One Arc vault's live state, owner's question first.
 *
 * The headline answers "what can my agent do right now?" in one sentence, from the same block as
 * every value under it, and the State chip reads the same answer, so the two cannot disagree.
 * Then, in a fixed order: status and today's spending, the per-payment ceiling, the allowlist, the
 * session key, the balance, and the contract's own identity, including whether its code is the
 * build this page deploys. Every group carries the stamp of the block it was read at.
 *
 * A session key with no expiry is shown as a danger, never as a neutral "none": the vault's
 * promise is a key bounded in time, and an unbounded one breaks it.
 *
 * A contract can answer any uint256 for a time, so every date goes through readableDate first, and
 * one that no date can hold is shown as the raw number it is.
 */
import { useState, type FormEvent } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { isAddress } from 'viem'
import type { Chain } from '../../../lib/chains'
import { AGENT_SPEND_POLICY_COMPILER, AGENT_SPEND_POLICY_SOURCE_SHA256 } from '../../../lib/contracts/agent-spend-policy'
import { OURS_DETAIL, OURS_LABEL } from '../../../lib/arc/known-vaults'
import { earlierBuildLine, NAMES_OUR_KEY } from '../../../lib/arc/ours'
import {
  addressUrl,
  localDateTime,
  networkName,
  readAllowed,
  usdcOf,
  utcDateTime,
  viewerTimeZone,
  type VaultSnapshot,
} from '../../../lib/arc/vault-read'
import { REVOKED_SESSION_EXPIRY, ZERO_ADDRESS, formatUnitsExact, readableDate, relativeSeconds, sameAddress, vaultHeadline } from '../../../lib/arc/vault-rules'
import { Chip, CopyButton, Field, Group, Mono } from '../stellar/bits'
import ReadStamp from './ReadStamp'

function Explorer({ href, label = 'Explorer' }: { href: string | null; label?: string }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
      {label} <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

export default function VaultStatus({
  v,
  chain,
  ours,
  ownerIsOurKey,
  operatorIsOurKey,
  ownerKind,
  refreshing,
}: {
  v: VaultSnapshot
  chain: Chain
  /** The provenance ledger lists this vault as ours. */
  ours: boolean
  /** owner() is a key of ours. Anyone can deploy a contract naming one, so this alone says only that. */
  ownerIsOurKey: boolean
  /** operator() is a key of ours. */
  operatorIsOurKey?: boolean
  /** Whose wallet the owner key is, for a vault on the owner-held list. */
  ownerKind?: 'team' | 'external'
  refreshing?: boolean
}) {
  const usd = (x: bigint) => `${formatUnitsExact(x, v.decimals)} USDC`
  const stamp = <ReadStamp v={v} refreshing={refreshing} compact />
  const h = vaultHeadline(v)
  const registryUsdc = usdcOf(chain)
  const resets = readableDate(v.resetsAt)
  // Ledger-backed and only for our own vault: anyone else's unknown code keeps the warning below.
  const earlierBuild = ours ? earlierBuildLine(v.network, v.address) : null

  return (
    <div className="space-y-3">
      {ours && (
        <p className="rounded-xl border border-border bg-foreground/[0.04] px-3 py-2 text-xs text-foreground/85">
          <span className="font-semibold text-foreground">Launch-day vault (ours). </span>
          {OURS_LABEL} {OURS_DETAIL}
        </p>
      )}
      {!ours && ownerIsOurKey && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
          <span className="font-semibold text-foreground">Not a vault we list. </span>
          {NAMES_OUR_KEY}
        </p>
      )}
      {!ours && !ownerIsOurKey && ownerKind === 'team' && (
        <p className="rounded-xl border border-border bg-foreground/[0.04] px-3 py-2 text-xs text-foreground/85">
          <span className="font-semibold text-foreground">Team-owned. </span>
          Its owner key is an A-Identity team member's own wallet, listed that way on the public season report.
        </p>
      )}

      <section
        aria-label="Can the agent pay"
        className={`rounded-2xl border p-4 sm:p-5 ${h.tone === 'ok' ? 'border-ok/30 bg-ok/[0.06]' : h.tone === 'warn' ? 'border-warn/30 bg-warn/[0.08]' : 'border-danger/30 bg-danger/[0.07]'}`}
      >
        <p className="text-base font-semibold leading-snug text-foreground sm:text-lg">{h.text}</p>
        {v.autoApproveMax !== 0n && h.canPay && (
          <p className="mt-1 text-sm text-foreground/75">
            A single agent payment above {usd(v.autoApproveMax)} is refused by the contract itself; only the owner can pay more.
          </p>
        )}
        <div className="mt-2">
          <ReadStamp v={v} refreshing={refreshing} />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Group title="Status" stamp={stamp}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="State">
              <Chip tone={h.tone}>{h.state}</Chip>
            </Field>
            <Field label="Agent key (operator)">
              {sameAddress(v.operator, ZERO_ADDRESS) ? <Chip tone="warn">None set</Chip> : <Chip tone="muted">Set</Chip>}
            </Field>
          </dl>
        </Group>

        <Group title="Today (UTC day, chain time)" stamp={stamp}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Daily cap">{v.dailyCap === 0n ? <Chip tone="warn">No cap: 0 means no limit</Chip> : usd(v.dailyCap)}</Field>
            <Field label="Spent today">{usd(v.spentToday)}</Field>
            <Field label="Still allowed today">{v.remainingToday === null ? 'No cap, so no daily limit' : usd(v.remainingToday)}</Field>
            <Field label="Resets at">
              {resets ? (
                `${utcDateTime(v.resetsAt)} (${localDateTime(resets.toISOString())}, ${viewerTimeZone(resets)})`
              ) : (
                <>
                  Unreadable: this contract's today() answered <Mono>{v.today.toString()}</Mono>, which is not a day.
                </>
              )}
            </Field>
          </dl>
        </Group>
      </div>

      <Group title="Largest auto-approved payment" stamp={stamp}>
        <p className="text-sm text-foreground">
          {v.autoApproveMax === 0n ? (
            <>
              <Chip tone="warn">No ceiling</Chip> 0 means the contract does not cap a single payment. The daily cap still applies.
            </>
          ) : (
            `${usd(v.autoApproveMax)} per payment. Anything above it is refused unless the owner pays it.`
          )}
        </p>
      </Group>

      <Group title="Allowlist" stamp={stamp}>
        <p className="text-sm text-foreground">
          {v.allowlistEnabled ? (
            <>
              <Chip tone="accent">Enforced</Chip> Only payees on the list can be paid by the agent.
            </>
          ) : (
            <>
              <Chip tone="muted">Not enforced</Chip> Any payee passes this gate; the cap and the ceiling still apply.
            </>
          )}
        </p>
        <AllowedChecker chain={chain} vault={v.address} enforced={v.allowlistEnabled} />
      </Group>

      <div className="grid gap-3 lg:grid-cols-2">
        <Group title="When the agent's key ends (session key)" stamp={stamp}>
          {v.sessionKeyExpiry === 0n ? (
            <p className="text-sm text-foreground">
              <Chip tone="danger">No time bound</Chip> The agent's key never expires. The owner should set an expiry before this vault holds money.
            </p>
          ) : v.sessionKeyExpiry === REVOKED_SESSION_EXPIRY ? (
            <p className="text-sm text-foreground">
              <Chip tone="warn">Revoked</Chip> The owner ended this key. The owner can give it a new expiry.
            </p>
          ) : readableDate(v.sessionKeyExpiry) === null ? (
            <p className="text-sm text-foreground">
              <Chip tone="danger">Unreadable expiry</Chip> It reads <Mono>{v.sessionKeyExpiry.toString()}</Mono>, too far ahead to be a date, so the
              key has no real time bound.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <span>
                {v.expired ? 'Expired' : 'Expires'} {utcDateTime(v.sessionKeyExpiry)} ({relativeSeconds(v.sessionKeyExpiry, v.chainTime)} in chain time)
              </span>
              {v.expired ? <Chip tone="danger">Expired</Chip> : <Chip tone="ok">Not expired</Chip>}
            </div>
          )}
        </Group>
        <Group title="USDC balance" stamp={stamp}>
          <p className="text-lg font-semibold tabular-nums text-foreground">{usd(v.balance)}</p>
          <p className="mt-1 text-xs text-foreground/65">{v.balance.toString()} units at {v.decimals} decimals, from the vault's own balance().</p>
        </Group>
      </div>

      <Group title="Contract" stamp={stamp}>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Vault contract" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.address}</Mono>
              <CopyButton text={v.address} label="Copy address" />
              <Explorer href={addressUrl(chain, v.address)} />
            </span>
          </Field>
          <Field label="Network">
            {networkName(chain)} <span className="text-foreground/55">({chain.caip2})</span>{' '}
            {chain.testnet ? <Chip tone="muted">Test USDC</Chip> : <Chip tone="warn">Real USDC</Chip>}
          </Field>
          <Field label="Build">
            {v.knownBuild ? (
              <>
                <Chip tone="ok">This page's build</Chip> AgentSpendPolicy from mcp/contracts, source sha256 {AGENT_SPEND_POLICY_SOURCE_SHA256.slice(0, 12)}...,
                solc {AGENT_SPEND_POLICY_COMPILER.solc.split('+')[0]}. Its code matches byte for byte with the owner and token below in every
                slot the contract reads them from, so the owner shown is the key it obeys.
              </>
            ) : earlierBuild ? (
              <>
                <Chip tone="muted">Earlier build of ours</Chip> {earlierBuild}
              </>
            ) : (
              <>
                <Chip tone="warn">Not this page's build</Chip> Its views answer like the vault, but its code is not the build this page deploys
                with the owner and token below written into it, so the owner shown may not be the key it obeys. The page offers no controls
                and no funding for it.
              </>
            )}
          </Field>
          <Field label="Owner" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.owner}</Mono>
              <CopyButton text={v.owner} label="Copy" />
              {ownerIsOurKey && <Chip tone="warn">Our operating wallet</Chip>}
              <Explorer href={addressUrl(chain, v.owner)} />
            </span>
          </Field>
          <Field label="Agent key (operator): it can only pay, within the limits" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.operator}</Mono>
              {sameAddress(v.operator, v.owner) && <Chip tone="danger">Same key as the owner</Chip>}
              {operatorIsOurKey && <Chip tone="warn">One of our keys</Chip>}
              <Explorer href={addressUrl(chain, v.operator)} />
            </span>
          </Field>
          <Field label="Token (usdc())" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.usdc}</Mono>
              {v.usdcMatches ? (
                <Chip tone="ok">The registry's USDC</Chip>
              ) : (
                <Chip tone="danger">Not the registry's USDC{registryUsdc ? ` (${registryUsdc.address})` : ''}</Chip>
              )}
            </span>
          </Field>
          <Field label="Code" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>
                {v.codeBytes.toLocaleString('en-US')} bytes, keccak256 {v.codeHash}
              </Mono>
              <CopyButton text={v.codeHash} label="Copy hash" />
            </span>
          </Field>
        </dl>
      </Group>
    </div>
  )
}

/** Ask the vault whether one payee passes its allowlist, live: allowed(payee) at the latest block. */
function AllowedChecker({ chain, vault, enforced }: { chain: Chain; vault: string; enforced: boolean }) {
  const [payee, setPayee] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const id = `allowed-${vault.slice(2, 10)}`

  const check = async (e: FormEvent) => {
    e.preventDefault()
    const p = payee.trim()
    if (!isAddress(p, { strict: false })) {
      setAnswer('Enter an EVM address: 0x followed by 40 hexadecimal characters.')
      return
    }
    setBusy(true)
    const r = await readAllowed(chain, vault, p)
    setBusy(false)
    if (!r) {
      setAnswer('No RPC answered. Try again in a moment.')
      return
    }
    setAnswer(
      `${r.allowed ? 'On the list' : 'Not on the list'} at block ${r.block.toLocaleString('en-US')} (${r.host}). ` +
        (enforced
          ? r.allowed
            ? 'The agent may pay it, within the cap and the ceiling.'
            : 'The agent cannot pay it while the allowlist is enforced.'
          : 'The allowlist is not enforced, so this does not limit the agent today.'),
    )
  }

  return (
    <form onSubmit={check} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-[11px] font-semibold text-foreground/65">
          Is a payee on the list?
        </label>
        <input
          id={id}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          placeholder="0x..."
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-xs font-semibold text-foreground/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
        Check live
      </button>
      {answer && <p className="w-full text-xs text-foreground/75">{answer}</p>}
    </form>
  )
}
