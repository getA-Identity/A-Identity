/**
 * Everything the page shows before, or instead of, a live vault: the vault picker, the "not
 * deployed yet" state, and the answers a live read can give that are not a vault (no account, no
 * contract, a contract that is not the vault, or no host answering).
 *
 * Each one is a live answer with the block that gave it, never a placeholder that looks like data.
 * The planned demo accounts are named as planned, and the page offers to read them; whether they
 * exist is the chain's to say.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CircleAlert, CircleDashed, FileQuestion, Loader2, PackageOpen, Search, WifiOff } from 'lucide-react'
import { NEAR_RPC_URLS, PLANNED, REGISTRY_USDC, REGISTRY_VAULT, nearAccountUrl } from '../../../lib/near/chain'
import { isNearAccountId, shortId } from '../../../lib/near/ids'
import { localTime } from '../../../lib/local-time'
import { viewAccount, type AccountRead } from '../../../lib/near/rpc'
import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { GuardFlow } from './VaultOverview'
import { BUTTON_QUIET, INPUT, TONE_FRAME, TONE_ICON } from './styles'
import { ExtLink, IdText, Label, Mono, Pill } from './ui'

export function VaultPicker({ vaultId, source, onOpen }: { vaultId: string | null; source: 'link' | 'registry' | null; onOpen: (id: string) => void }) {
  const [text, setText] = useState(vaultId ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => setText(vaultId ?? ''), [vaultId])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const id = text.trim()
    if (!isNearAccountId(id)) {
      setProblem('A NEAR account id is 2 to 64 lowercase letters, digits, and . - _ between them, such as vault.aid-demo-owner.testnet.')
      return
    }
    setProblem(null)
    onOpen(id)
  }
  return (
    <form onSubmit={submit} aria-label="Choose a vault" className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block w-full min-w-0 text-[11px] font-semibold text-foreground/80 sm:w-auto sm:flex-1">
          Vault account on NEAR testnet
          <input
            className={`${INPUT} font-mono text-xs`}
            placeholder={`for example ${PLANNED.vault}`}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button type="submit" className={cn(BUTTON_QUIET, 'h-[38px]')}>
          <Search size={12} aria-hidden="true" />
          Read live
        </button>
      </div>
      <p className="mt-2 text-[11px] text-foreground/75">
        {source === 'link'
          ? 'From the link. Any NEAR account can be read here, with no wallet.'
          : source === 'registry'
            ? 'The vault the chain registry records for NEAR testnet. Any other account can be read here too.'
            : 'The chain registry records no NEAR vault yet. Enter any account to read it live.'}
        {source === 'link' && REGISTRY_VAULT && REGISTRY_VAULT !== vaultId && (
          <>
            {' '}
            <Link to={{ search: '' }} className="font-semibold text-foreground underline decoration-accent/60 decoration-2 underline-offset-2">
              Back to the registry's vault
            </Link>
          </>
        )}
      </p>
      {problem && (
        <p role="alert" className="mt-2 text-xs text-foreground">
          {problem}
        </p>
      )}
    </form>
  )
}

type PlannedCheck = { vault: AccountRead | null; registry: AccountRead | null; failed: boolean; at: string | null }

/** Whether the planned demo accounts exist, read live; never assumed either way. */
function usePlannedCheck(): PlannedCheck {
  const [c, setC] = useState<PlannedCheck>({ vault: null, registry: null, failed: false, at: null })
  useEffect(() => {
    let alive = true
    void Promise.all([viewAccount(NEAR_RPC_URLS, PLANNED.vault), viewAccount(NEAR_RPC_URLS, PLANNED.registry)]).then(
      ([vault, registry]) => alive && setC({ vault, registry, failed: false, at: new Date().toISOString() }),
      () => alive && setC({ vault: null, registry: null, failed: true, at: new Date().toISOString() }),
    )
    return () => {
      alive = false
    }
  }, [])
  return c
}

function liveLine(r: AccountRead | null, failed: boolean) {
  if (failed) return <Pill tone="muted">Not read: no host answered</Pill>
  if (!r)
    return (
      <Pill tone="muted" icon={<Loader2 size={11} className="animate-spin" aria-hidden="true" />}>
        Reading
      </Pill>
    )
  if (!r.exists) return <Pill tone="warn">Not on testnet yet{r.blockHeight ? ` (block ${r.blockHeight.toLocaleString('en-US')})` : ''}</Pill>
  return r.hasContract ? <Pill tone="ok">Deployed (block {r.blockHeight.toLocaleString('en-US')})</Pill> : <Pill tone="warn">Account exists, no contract yet</Pill>
}

/** No vault in the link and none in the registry: what is planned, and what the chain says about it now. */
export function NotDeployed({ onOpen }: { onOpen: (id: string) => void }) {
  const check = usePlannedCheck()
  const vaultLive = check.vault?.exists && check.vault.hasContract
  return (
    <div className="space-y-3">
      <section aria-label="Not deployed yet" className="rounded-2xl border border-dashed border-foreground/25 bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-foreground/[0.05]">
            <PackageOpen size={21} className="text-foreground/80" aria-hidden="true" />
          </span>
          <h2 className="text-lg font-semibold text-foreground">Not deployed yet</h2>
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone="warn">Planned</Pill>
            <Pill tone="accent">NEAR testnet</Pill>
          </span>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-foreground/85">
          The chain registry records no NEAR vault yet, and the link names none, so there is nothing live to show. This page shows no numbers until a
          vault exists on chain: no sample data, no mock.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <PlannedRow label="Demo vault" id={PLANNED.vault} live={liveLine(check.vault, check.failed)} />
          <PlannedRow label="Its owner" id={PLANNED.owner} />
          <PlannedRow label="A-Identity risk registry" id={PLANNED.registry} live={liveLine(check.registry, check.failed)} />
          <div className="min-w-0">
            <dt>
              <Label>Token (from the registry)</Label>
            </dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              {REGISTRY_USDC ? (
                <>
                  <span className="text-sm text-foreground">
                    {REGISTRY_USDC.issuer} testnet {REGISTRY_USDC.symbol}, {REGISTRY_USDC.decimals} decimals
                  </span>
                  <Mono>{shortId(REGISTRY_USDC.address, 8)}</Mono>
                </>
              ) : (
                <span className="text-sm text-foreground/85">Not documented in the registry</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onOpen(PLANNED.vault)}>
            {vaultLive ? 'Open the demo vault' : 'Read the demo vault live'}
          </Button>
          <span className="text-xs text-foreground/80">
            {check.at ? `Checked live at ${localTime(check.at)} (your time).` : 'Checking the planned accounts live...'}
          </span>
        </div>
      </section>
      <GuardFlow
        planned
        keyLine="One key, created by the vault itself"
        policyLine="A daily cap and a per-payment ceiling"
        policySub="Set by the owner at deploy; allowlist off"
        registryLine={PLANNED.registry}
        registrySub="DENY refused on chain, WARN held"
        unknownLine="Held for the owner (on by default)"
        unknownSub="Paid only if you listed it or the vault paid it before"
      />
    </div>
  )
}

function PlannedRow({ label, id, live }: { label: string; id: string; live?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt>
        <Label>{label} (planned)</Label>
      </dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2">
        <ExtLink href={nearAccountUrl(id)} className="font-mono text-xs [overflow-wrap:anywhere]">
          <IdText id={id} />
        </ExtLink>
        {live}
      </dd>
    </div>
  )
}

/** A live read that came back as something other than a vault. */
export function NotAVault({
  kind,
  vaultId,
  blockHeight,
  host,
  readAt,
  reason,
  codeHash,
  planned,
}: {
  kind: 'missing' | 'no-code' | 'not-vault'
  vaultId: string
  blockHeight: number | null
  host: string
  readAt: string
  reason?: string
  codeHash?: string
  planned: boolean
}) {
  const title =
    kind === 'missing'
      ? `${vaultId} does not exist on NEAR testnet${planned ? ' yet' : ''}.`
      : kind === 'no-code'
        ? `${vaultId} exists, but carries no contract${planned ? ' yet' : ''}.`
        : `${vaultId} runs a contract that is not the A-Identity vault.`
  const next =
    kind === 'missing'
      ? planned
        ? 'This is the planned demo vault: it is not deployed yet. Read it again after the deploy.'
        : 'Check the account id. Nothing is deployed at this one.'
      : kind === 'no-code'
        ? planned
          ? 'The account is created and the contract is not deployed on it yet.'
          : 'A vault is a contract account. This one is a plain account.'
        : `Nothing it reports is shown here, because ${reason ?? 'its views do not answer the vault shape'}.`
  const tone = kind === 'not-vault' ? 'danger' : 'warn'
  return (
    <section aria-label="Read result" className={cn('rounded-2xl border p-4 sm:p-5', TONE_FRAME[tone])}>
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 shrink-0', TONE_ICON[tone])} aria-hidden="true">
          {kind === 'missing' ? <CircleDashed size={20} /> : kind === 'no-code' ? <FileQuestion size={20} /> : <CircleAlert size={20} />}
        </span>
        <div className="min-w-0">
          <p className="break-words text-base font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm text-foreground/85">{next}</p>
          {codeHash && (
            <p className="mt-2 text-xs text-foreground/85">
              Its code hash: <Mono>{codeHash}</Mono>
            </p>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-foreground/75">
            <span>
              Read live{blockHeight ? ` at block ${blockHeight.toLocaleString('en-US')}` : ''} from {host}, {localTime(readAt)} (your time).
            </span>
            <ExtLink href={nearAccountUrl(vaultId)}>NearBlocks</ExtLink>
          </p>
        </div>
      </div>
    </section>
  )
}

/** No host answered: not a verdict about the vault. The page tries again by itself. */
export function ReadFailed({ at, reason, lastGood, retrying }: { at: string; reason: string; lastGood: { block: number; readAt: string } | null; retrying: boolean }) {
  return (
    <section role="alert" aria-label="Read failed" className={cn('rounded-2xl border p-4 sm:p-5', TONE_FRAME.danger)}>
      <div className="flex items-start gap-3">
        <WifiOff size={20} className={cn('mt-0.5 shrink-0', TONE_ICON.danger)} aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold text-foreground">The read failed at {localTime(at)}: no NEAR testnet host gave an answer.</p>
          <p className="mt-1 break-words text-sm text-foreground/85">{reason}</p>
          <p className="mt-2 text-sm text-foreground/85">
            <span className="font-semibold text-foreground">Next step: </span>
            {retrying ? 'wait, this page tries again every 10 seconds, or press Refresh.' : 'press Refresh.'} If you use Brave, Shields can block these reads.
          </p>
          {lastGood && (
            <p className="mt-2 text-xs text-foreground/80">
              The last good read was at block {lastGood.block.toLocaleString('en-US')}, {localTime(lastGood.readAt)}. Its numbers are not shown, because they may no
              longer be true.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
