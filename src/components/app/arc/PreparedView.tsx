/**
 * A prepared write, shown before the wallet is asked: which contract, which function, every
 * argument, the network, and the most the network fee can be. The browser's version of the
 * repository rule that every write is prepared-or-executed: this is the "prepared" half, and
 * nothing here is signed until the person presses the button under it.
 */
import { formatUnitsExact } from '../../../lib/arc/vault-rules'
import { networkName } from '../../../lib/arc/vault-read'
import type { PreparedTx } from '../../../lib/arc/vault-write'
import { Chip, Mono } from '../stellar/bits'

export default function PreparedView({ p, decimals, title }: { p: PreparedTx; decimals: number; title?: string }) {
  const native = p.chain.nativeCurrency.decimals
  const feeUsdc = formatUnitsExact(p.maxFeeWei, native)
  return (
    <div className="rounded-xl border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title ?? `Review: ${p.what}`}</h4>
        <Chip tone="muted">Prepared, not signed</Chip>
        {p.chain.testnet ? <Chip tone="muted">{networkName(p.chain)}: test USDC</Chip> : <Chip tone="warn">{networkName(p.chain)}: real USDC</Chip>}
      </div>
      <dl className="mt-3 grid gap-3 text-sm">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Contract</dt>
          <dd className="mt-0.5 break-all text-foreground">{p.call.contract}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Function</dt>
          <dd className="mt-0.5 font-mono text-xs text-foreground">{p.call.function}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Arguments</dt>
          <dd className="mt-1 space-y-1">
            {p.call.args.map((a) => (
              <div key={a.name} className="text-xs text-foreground/85">
                <span className="font-mono font-semibold text-foreground">{a.name}</span>: <Mono>{a.value}</Mono>
                {a.note && <span className="text-foreground/60"> ({a.note})</span>}
              </div>
            ))}
          </dd>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">From (pays the fee)</dt>
            <dd className="mt-0.5">
              <Mono>{p.from}</Mono>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Network fee, at most</dt>
            <dd className="mt-0.5 text-foreground">
              {feeUsdc} USDC{' '}
              <span className="text-xs text-foreground/60">
                ({p.gas.toLocaleString('en-US')} gas at up to {formatUnitsExact(p.maxFeePerGas, 9)} gwei; Arc charges the base fee, so it is
                usually less)
              </span>
            </dd>
          </div>
        </div>
        {p.predicted && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Vault address it should create</dt>
            <dd className="mt-0.5">
              <Mono>{p.predicted}</Mono>{' '}
              <span className="text-xs text-foreground/60">(from your account and its next nonce; the receipt is what decides)</span>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Calldata</dt>
          <dd className="mt-0.5 text-xs text-foreground/70">
            {((p.data.length - 2) / 2).toLocaleString('en-US')} bytes, simulated from your account before this screen:{' '}
            {p.action === 'deploy'
              ? 'the deploy succeeds and installs exactly the build this page carries.'
              : 'the contract accepted it.'}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] text-foreground/60">
        Amounts are in USDC at {decimals} decimals. A-Identity signs nothing: your wallet shows this same call and fee and asks you to sign it.
      </p>
    </div>
  )
}
