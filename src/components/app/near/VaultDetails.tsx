/**
 * The vault's settings, who can sign for it, and the account behind it, each read live.
 *
 * "Who can sign" is the ACCOUNT's own access-key list (view_access_key_list), the protocol's
 * answer rather than the contract's opinion, joined to the contract's agent records. It is the
 * claim this design rests on: the vault account carries no full-access key, and the agent's key
 * may call exactly pay, request_payment and record_refusal on this vault and can never attach a
 * deposit, so it cannot move USDC directly, transfer NEAR, add keys or deploy code.
 */
import { KeyRound, FileCode2, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { AGENT_METHODS, vaultBuild } from '../../../lib/near/abi'
import { nearAccountUrl } from '../../../lib/near/chain'
import { shortKey } from '../../../lib/near/ids'
import { keyExpired, relativeTime, utcText, type KeyRow } from '../../../lib/near/model'
import { MAX_GUARD_PAYEES, MAX_REFUSAL_PAYEES, type VaultSnapshot } from '../../../lib/near/read'
import { formatGrouped, formatNear } from '../../../lib/near/units'
import { cn } from '../../../lib/utils'
import { TONE_FRAME } from './styles'
import { Card, CopyButton, ExtLink, Fact, IdText, Mono, Pill } from './ui'

/** 10^19 yoctoNEAR per byte of storage on NEAR. */
const YOCTO_PER_BYTE = 10n ** 19n

function Account({ id, you }: { id: string; you?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Mono>{id}</Mono>
      {you && <Pill tone="ok">You</Pill>}
      <ExtLink href={nearAccountUrl(id)} className="text-xs">
        NearBlocks
      </ExtLink>
    </span>
  )
}

export function PolicyCard({ s, connected }: { s: VaultSnapshot; connected: string | null }) {
  const c = s.config
  const amt = (x: bigint) => (s.token.decimals === null ? `${x.toString()} units` : `${formatGrouped(x, s.token.decimals)} ${s.token.symbol ?? ''}`.trim())
  return (
    <Card title="Policy" icon={<SlidersHorizontal size={14} />} aside={<Pill tone="muted">get_config, read live</Pill>}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="State">{c.frozen ? <Pill tone="danger">Frozen</Pill> : <Pill tone="ok">Active</Pill>}</Fact>
        <Fact label="Payee nobody has judged">
          {c.holdUnknown === null ? (
            <Pill tone="muted">Not reported by this build</Pill>
          ) : c.holdUnknown ? (
            <Pill tone="ok">Held for the owner</Pill>
          ) : (
            <Pill tone="warn">Paid within the limits</Pill>
          )}
        </Fact>
        <Fact label="Daily cap (UTC day)">{c.dailyCap === 0n ? <Pill tone="warn">No cap: 0 means no limit</Pill> : amt(c.dailyCap)}</Fact>
        <Fact label="Largest payment without you">{c.autoApproveMax === 0n ? <Pill tone="warn">No ceiling</Pill> : amt(c.autoApproveMax)}</Fact>
        <Fact label="Allowlist" wide>
          <span className="flex flex-wrap items-center gap-2">
            {c.allowlistEnabled ? <Pill tone="accent">Enforced</Pill> : <Pill tone="muted">Not enforced</Pill>}
            <span className="text-xs text-foreground/80">
              {s.allowlist.length === 0
                ? 'Nobody is listed.'
                : `${s.allowlist.length} listed${c.allowlistEnabled ? ': the agent can pay only these.' : ': not a gate today, but listed payees count as known, so they are not held as unknown.'}`}
            </span>
          </span>
          {s.allowlist.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {s.allowlist.slice(0, 12).map((p) => (
                <li key={p}>
                  <Mono className="rounded-md bg-foreground/[0.05] px-1.5 py-0.5">{p}</Mono>
                </li>
              ))}
              {s.allowlist.length > 12 && <li className="text-xs text-foreground/80">and {s.allowlist.length - 12} more</li>}
            </ul>
          )}
        </Fact>
        <Fact label="Owner" wide>
          <Account id={c.ownerId} you={connected === c.ownerId} />
        </Fact>
        <Fact label="Risk registry the vault asks before paying" wide>
          {c.registryId ? (
            <span className="flex flex-wrap items-center gap-2">
              <Account id={c.registryId} />
              {s.registryLive === false && <Pill tone="danger">Not a live contract: every payment fails closed</Pill>}
            </span>
          ) : (
            <Pill tone="warn">None: no on-chain verdict check</Pill>
          )}
        </Fact>
        <Fact label="Token" wide>
          <span className="flex flex-wrap items-center gap-2">
            <Mono>{c.tokenId}</Mono>
            {s.token.documented ? <Pill tone="ok">Circle testnet USDC, as the registry documents it</Pill> : <Pill tone="danger">Not the USDC the registry documents</Pill>}
          </span>
          <span className="mt-1 block text-xs text-foreground/80">
            {s.token.symbol ? `Reports itself as ${s.token.name ?? s.token.symbol} (${s.token.symbol}), ${s.token.decimals ?? '?'} decimals.` : 'Its metadata did not answer, so amounts may show in raw units.'}
          </span>
        </Fact>
      </dl>
    </Card>
  )
}

function keyPermission(row: KeyRow, vaultId: string) {
  const k = row.onChain
  if (!k) return <p className="text-xs leading-5 text-foreground/80">No access key on the account</p>
  if (k.permission.kind === 'full')
    return (
      <p className="text-xs font-semibold leading-5 text-foreground">
        Full access: it can sign anything for <IdText id={vaultId} />
      </p>
    )
  const p = k.permission
  return (
    <p className="text-xs leading-6 text-foreground/85">
      May call{' '}
      {p.methodNames.length === 0 ? (
        <span className="font-semibold">any method</span>
      ) : (
        // Read from the chain as given: nothing here makes the names unique, so the position keys them.
        p.methodNames.map((m, i) => (
          <span key={`${i}:${m}`}>
            {i > 0 ? ', ' : ''}
            <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[11px] text-foreground">{m}</code>
          </span>
        ))
      )}{' '}
      on {p.receiverId === vaultId ? 'this vault only' : <Mono>{p.receiverId}</Mono>}. Gas allowance:{' '}
      {p.allowanceYocto === null ? 'unlimited' : `${formatNear(p.allowanceYocto)} NEAR left`}.
    </p>
  )
}

export function KeysCard({ s, rows }: { s: VaultSnapshot; rows: KeyRow[] }) {
  const build = vaultBuild(s.config.version)
  const full = rows.filter((r) => r.onChain?.permission.kind === 'full').length
  const paying = rows.filter((r) => r.canPay).length
  return (
    <Card title="Who can sign for this vault" icon={<KeyRound size={14} />} aside={<Pill tone="muted">view_access_key_list, read live</Pill>}>
      <div className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5', TONE_FRAME[full === 0 ? 'ok' : 'danger'])}>
        {full === 0 ? <ShieldCheck size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" /> : <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />}
        <p className="text-xs text-foreground">
          {full === 0 ? (
            <>
              <span className="font-semibold">No full-access key on the vault account.</span> Nobody, A-Identity included, can redeploy this contract,
              delete the account or sign outside the contract's rules.
            </>
          ) : (
            <>
              <span className="font-semibold">
                {full} full-access key{full === 1 ? '' : 's'} on the vault account.
              </span>{' '}
              Whoever holds {full === 1 ? 'it' : 'them'} can redeploy the contract or empty the account; the contract cannot bound that.
            </>
          )}
        </p>
      </div>
      <p className="mt-2 text-xs text-foreground/80">
        {paying === 0 ? 'No agent key can pay right now.' : `${paying} agent key${paying === 1 ? '' : 's'} can pay right now.`} An agent key may call only{' '}
        {AGENT_METHODS.join(', ')} on this vault, and a function-call key can never attach a deposit, so it cannot call the token's ft_transfer, move
        NEAR, add keys or deploy code. The protocol enforces that, not this page.{' '}
        {build === 'earlier'
          ? 'Builds before 0.2.0, this one included, do not also check that the key signed the transaction itself; 0.2.0 refuses a call the key signed and someone else relayed.'
          : build === 'unknown'
            ? ''
            : 'The vault also refuses a call the key signed and someone else relayed (a NEP-366 delegate action), so every agent call is paid from the key\'s own gas allowance.'}
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-foreground/80">The account carries no access keys and the contract lists no agent keys.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => {
            const rec = r.record
            const expiry = rec ? (rec.expiresAtS === 0n ? 'No expiry' : `${keyExpired(rec.expiresAtS, s.chainNowS) ? 'Expired' : 'Expires'} ${relativeTime(rec.expiresAtS, s.chainNowS)} (${utcText(rec.expiresAtS) ?? rec.expiresAtS.toString()})`) : null
            return (
              <li key={r.publicKey} className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{rec ? rec.label || 'Agent key (no label)' : r.onChain?.permission.kind === 'full' ? 'Full-access key' : 'Key the contract does not list'}</span>
                  {r.canPay ? <Pill tone="ok">Can pay</Pill> : rec?.revoked ? <Pill tone="muted">Revoked</Pill> : r.onChain?.permission.kind === 'full' ? <Pill tone="danger">Full access</Pill> : <Pill tone="warn">Cannot pay</Pill>}
                  <span className="font-mono text-[11px] text-foreground/80" title={r.publicKey}>
                    {shortKey(r.publicKey)}
                  </span>
                  <CopyButton text={r.publicKey} label="Copy key" />
                </div>
                <div className="mt-1.5">{keyPermission(r, s.vaultId)}</div>
                {expiry && <div className="mt-1 text-xs text-foreground/80">{expiry}</div>}
                {r.notes.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {r.notes.map((n) => (
                      <li key={n.text} className="flex items-start gap-1.5 text-xs text-foreground">
                        <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', n.tone === 'danger' ? 'bg-danger' : n.tone === 'warn' ? 'bg-warn' : 'bg-foreground/45')} aria-hidden="true" />
                        {n.text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export function ContractCard({ s }: { s: VaultSnapshot }) {
  const storageYocto = BigInt(s.account.storageUsage) * YOCTO_PER_BYTE
  const free = s.account.amountYocto > storageYocto ? s.account.amountYocto - storageYocto : 0n
  const build = vaultBuild(s.config.version)
  const c = s.counters
  return (
    <Card title="The account behind it" icon={<FileCode2 size={14} />} aside={<Pill tone="muted">view_account, read live</Pill>}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Build">
          <span className="flex flex-wrap items-center gap-2">
            {s.config.version}
            {build === 'current' ? (
              <Pill tone="ok">The build this page reads in full</Pill>
            ) : build === 'earlier' ? (
              <Pill tone="warn">Earlier than 0.2.0</Pill>
            ) : (
              <Pill tone="muted">{build === 'newer' ? 'Newer than this page' : 'A version this page cannot read'}</Pill>
            )}
          </span>
          {build === 'earlier' && (
            <span className="mt-1 block text-xs text-foreground/80">
              0.2.0 added what this build lacks: the vault's own kind on every hold (so its holds show as unclassified), a bound on refusal counters and a way to forget
              them, the refusal of relayed agent calls, and a check on who may initialize it.
            </span>
          )}
          {build === 'newer' && <span className="mt-1 block text-xs text-foreground/80">This page is written for agent-spend-policy 0.2.0 and shows the fields that build has.</span>}
        </Fact>
        <Fact label="Refusal counters in storage">
          {c.state === 'read' ? (
            <>
              {c.guard} of {MAX_GUARD_PAYEES} payees with the agent's recorded refusals, {c.registry} of {MAX_REFUSAL_PAYEES} with registry refusals
              <span className="block text-xs text-foreground/80">guard_refusal_payees and refusal_payees, read live. The owner controls free a slot.</span>
            </>
          ) : c.state === 'not-reported' ? (
            <Pill tone="muted">Not reported by this build</Pill>
          ) : (
            <Pill tone="muted">Not read</Pill>
          )}
        </Fact>
        <Fact label="NEAR on the account">
          {formatNear(s.account.amountYocto)} NEAR
          <span className="block text-xs text-foreground/80">
            {formatNear(storageYocto)} NEAR held for {s.account.storageUsage.toLocaleString('en-US')} bytes of storage, about {formatNear(free)} NEAR free. It pays its agent
            keys' gas and each new payee's token registration.
          </span>
        </Fact>
        <Fact label="Registration of a new payee on the token">{formatNear(s.config.tokenStorageDeposit, 5)} NEAR, from the vault's own NEAR</Fact>
        <Fact label="Vault registered on its token">
          {s.registeredOnToken === null ? <Pill tone="muted">Not read</Pill> : s.registeredOnToken ? <Pill tone="ok">Yes: it can receive</Pill> : <Pill tone="warn">No: funding registers it first</Pill>}
        </Fact>
        <Fact label="Code hash (base58)" wide>
          <span className="flex flex-wrap items-center gap-2">
            <Mono>{s.account.codeHash}</Mono>
            <CopyButton text={s.account.codeHash} label="Copy hash" />
          </span>
          <span className="mt-1 block text-xs text-foreground/80">Compare it with the wasm hash in the deployment record to check this is the published build.</span>
        </Fact>
      </dl>
    </Card>
  )
}
