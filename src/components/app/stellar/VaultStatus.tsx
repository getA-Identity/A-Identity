/**
 * One vault's live state, owner's question first.
 *
 * The headline answers "can my agent pay, and how much more today?" in one sentence, from
 * the same read as everything under it. The fields follow in a fixed order: status, today,
 * the per-payment ceiling, the allowlist, the session key, the balance, then the contract's
 * own identity. Every group carries the ledger and time it was read at.
 *
 * Amounts are compared in base units (BigInt over the raw strings), never as floats, so a
 * headline cannot round a balance that is a stroop short into "can spend".
 */
import { ExternalLink } from 'lucide-react'
import {
  addressExplorerUrl,
  isZero,
  localDateTime,
  money,
  networkWord,
  relativeTo,
  viewerTimeZone,
  vaultHeadline,
  type VaultRead,
} from '../../../lib/stellar/vault-read'
import AllowlistChecker from './AllowlistChecker'
import ReadStamp from './ReadStamp'
import { Chip, CopyButton, Field, Group, Mono } from './bits'

export default function VaultStatus({ v, refreshing }: { v: VaultRead; refreshing?: boolean }) {
  const sym = v.tokenSymbol || 'USDC'
  const stamp = <ReadStamp ledger={v.ledger} readAt={v.readAt} refreshing={refreshing} />
  const h = vaultHeadline(v)
  const resets = new Date(v.resetsAt)
  const tokenHref = addressExplorerUrl(v.network, v.token)
  const ownerHref = addressExplorerUrl(v.network, v.owner)
  const operatorHref = addressExplorerUrl(v.network, v.operator)

  return (
    <div className="space-y-3">
      {/* The owner's question, answered first. */}
      <section
        aria-label="Can the agent pay"
        className={`rounded-2xl border p-4 sm:p-5 ${h.tone === 'ok' ? 'border-ok/30 bg-ok/[0.06]' : h.tone === 'warn' ? 'border-warn/30 bg-warn/[0.08]' : 'border-danger/30 bg-danger/[0.07]'}`}
      >
        <p className="text-base font-semibold leading-snug text-foreground sm:text-lg">{h.text}</p>
        {!isZero(v.autoApproveMax) && !v.frozen && (
          <p className="mt-1 text-sm text-foreground/75">
            A single payment above {money(v.autoApproveMax, sym)} is refused by the contract unless the owner makes it.
          </p>
        )}
        <div className="mt-2">{stamp}</div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Group title="Status" stamp={stamp}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="State">
              {v.frozen ? <Chip tone="danger">Frozen</Chip> : <Chip tone="ok">Active</Chip>}
            </Field>
            <Field label="Instance entry">
              {v.ttl.archived ? (
                <Chip tone="warn">Archived: the next call restores it</Chip>
              ) : v.ttl.liveUntilLedger ? (
                <>Live until ledger {v.ttl.liveUntilLedger.toLocaleString('en-US')}</>
              ) : (
                'Not reported'
              )}
            </Field>
          </dl>
        </Group>

        <Group title="Today (UTC day)" stamp={stamp}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Daily cap">{isZero(v.dailyCap) ? 'No cap set' : money(v.dailyCap, sym)}</Field>
            <Field label="Spent today">{money(v.spentToday, sym)}</Field>
            <Field label="Still allowed today">
              {v.remainingToday ? money(v.remainingToday, sym) : 'No cap, so no daily limit'}
            </Field>
            <Field label="Resets at">
              {Number.isNaN(resets.getTime()) ? (
                v.resetsAt
              ) : (
                <>
                  {localDateTime(v.resetsAt)} ({viewerTimeZone(resets)}), which is 00:00 UTC
                </>
              )}
            </Field>
          </dl>
        </Group>

      </div>

      <Group title="Largest auto-approved payment" stamp={stamp}>
        <p className="text-sm text-foreground">
          {isZero(v.autoApproveMax)
            ? 'No ceiling: 0 means the contract does not cap a single payment. The daily cap still applies.'
            : `${money(v.autoApproveMax, sym)} per payment. Anything above it is refused unless the owner pays it.`}
        </p>
      </Group>

      <Group title="Allowlist" stamp={stamp}>
        <p className="text-sm text-foreground">
          {v.allowlistEnabled ? (
            <>
              <Chip tone="accent">Enforced</Chip> Only payees on the list can be paid.
            </>
          ) : (
            <>
              <Chip tone="muted">Not enforced</Chip> Any payee passes this gate; the cap and ceiling still apply.
            </>
          )}
        </p>
        <AllowlistChecker network={v.network} contract={v.contract} />
      </Group>

      <div className="grid gap-3 lg:grid-cols-2">
        <Group title="Session key" stamp={stamp}>
          {v.sessionKeyExpiry === 0 ? (
            <p className="text-sm text-foreground">None: the operator's authority has no time limit.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <span>
                Expires {localDateTime(v.sessionKeyExpiry)} ({relativeTo(v.sessionKeyExpiry)})
              </span>
              {v.sessionKeyExpired ? <Chip tone="danger">Expired</Chip> : <Chip tone="ok">Active</Chip>}
            </div>
          )}
        </Group>
        <Group title={`${sym} balance`} stamp={stamp}>
          <p className="text-lg font-semibold tabular-nums text-foreground">{money(v.balance, sym)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/65">
            Token contract <Mono>{v.token}</Mono>
            {tokenHref && (
              <a href={tokenHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                Explorer <ExternalLink size={11} />
              </a>
            )}
          </p>
        </Group>

      </div>

      <Group title="Contract" stamp={stamp}>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Vault contract" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.contract}</Mono>
              <CopyButton text={v.contract} label="Copy id" />
              <a
                href={v.explorer.contract}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
              >
                Explorer <ExternalLink size={11} />
              </a>
            </span>
          </Field>
          <Field label="Network">
            Stellar {networkWord(v.network)} <span className="text-foreground/55">({v.network})</span>
          </Field>
          <Field label="Build">
            {v.knownBuild ? (
              <>AgentSpendPolicy {v.build ?? '(version not recorded)'}</>
            ) : (
              <>Not a build we published: its views answer like the vault, but the code hash is not in our list.</>
            )}
          </Field>
          <Field label="Owner" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.owner}</Mono>
              <CopyButton text={v.owner} label="Copy" />
              {v.ownerKind === 'smart-account' && <Chip tone="accent">Passkey smart account</Chip>}
              {ownerHref && (
                <a href={ownerHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                  Explorer <ExternalLink size={11} />
                </a>
              )}
            </span>
          </Field>
          <Field label="Operator (the agent's key)" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.operator}</Mono>
              {operatorHref && (
                <a href={operatorHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                  Explorer <ExternalLink size={11} />
                </a>
              )}
            </span>
          </Field>
          <Field label="Code hash" wide>
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{v.wasmHash}</Mono>
              <CopyButton text={v.wasmHash} label="Copy" />
            </span>
          </Field>
        </dl>
        {v.note && <p className="mt-3 text-xs text-foreground/60">{v.note}</p>}
      </Group>
    </div>
  )
}
