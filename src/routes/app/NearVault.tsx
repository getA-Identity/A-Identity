/**
 * /app/vault/near: the owner console for A-Identity's agent spend vault on NEAR TESTNET.
 *
 * Public on purpose, like /app/vault/arc and /app/vault/stellar: a vault's limits are on a public
 * chain already, and a claim about a budget an agent cannot exceed should be checkable by someone
 * who does not trust us, with no account and no wallet. Every value is read from the browser over
 * the registry's NEAR testnet RPC hosts (src/lib/chains.ts, generated), at the latest final block,
 * and stamped with the block that answered.
 *
 * The owner can freeze the vault, approve or reject held payments, change its limits, forget
 * refusal counters, and move money in or out, signing in their own NEAR wallet through NEAR
 * Connect. Every call is shown exactly, before the wallet opens, and its result is read back from
 * the chain with its hash. A-Identity holds no key and signs nothing on this page.
 *
 * Which vault: ?vault=<account> names one; otherwise the one the chain registry records for NEAR
 * testnet. The registry records none until a deploy receipt fills it, and then the page shows a
 * "not deployed yet" state backed by a live read of the planned accounts, never sample data.
 *
 * Its own chunk (App.tsx lazy-loads it), and NEAR Connect is a further dynamic import inside it, so
 * no NEAR code reaches the landing page or the prerender.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'
import Activity from '../../components/app/near/Activity'
import type { ActionContext } from '../../components/app/near/ActionFlow'
import HeldPayments from '../../components/app/near/HeldPayments'
import OwnerControls from '../../components/app/near/OwnerControls'
import PayeesCard from '../../components/app/near/Payees'
import { ContractCard, KeysCard, PolicyCard } from '../../components/app/near/VaultDetails'
import VaultOverview from '../../components/app/near/VaultOverview'
import { NotAVault, NotDeployed, ReadFailed, VaultPicker } from '../../components/app/near/VaultStates'
import WalletBar from '../../components/app/near/WalletBar'
import { BUTTON_QUIET } from '../../components/app/near/styles'
import { Pill } from '../../components/app/near/ui'
import { usePayeeFacts } from '../../components/app/near/usePayeeFacts'
import { useNearWallet } from '../../components/app/near/useNearWallet'
import { track } from '../../lib/analytics'
import { NEAR_RPC_URLS, PLANNED, REGISTRY_USDC, REGISTRY_VAULT } from '../../lib/near/chain'
import { isNearAccountId } from '../../lib/near/ids'
import { keyRows } from '../../lib/near/model'
import { readNearVault, type VaultRead } from '../../lib/near/read'
import { NearUnreachable } from '../../lib/near/rpc'

/** How often a read no host answered is tried again. No answer is not a verdict, so nobody has to press Refresh. */
const UNANSWERED_RETRY_MS = 10_000

type ReadState = {
  /** The vault this state is about, so a late answer for another vault is dropped. */
  key: string
  loading: boolean
  data: VaultRead | null
  failure: { at: string; reason: string; unreachable: boolean } | null
  /** The last successful read, kept only to say WHEN it was; its numbers are never shown. */
  lastGood: { block: number; readAt: string } | null
}

const EMPTY: ReadState = { key: '', loading: false, data: null, failure: null, lastGood: null }

export default function NearVault() {
  const [params, setParams] = useSearchParams()
  const vaultParam = params.get('vault')?.trim() || null
  const vaultId = vaultParam ?? REGISTRY_VAULT
  const source: 'link' | 'registry' | null = vaultParam ? 'link' : REGISTRY_VAULT ? 'registry' : null
  const valid = vaultId !== null && isNearAccountId(vaultId)
  const key = valid ? vaultId : ''

  const wallet = useNearWallet()
  const [read, setRead] = useState<ReadState>(EMPTY)
  const [extraPayees, setExtraPayees] = useState<string[]>([])
  const [landed, setLanded] = useState(0)
  const latestKey = useRef(key)
  latestKey.current = key

  const open = useCallback((id: string) => setParams({ vault: id }), [setParams])

  const load = useCallback(async () => {
    if (!key) return
    const k = key
    setRead((prev) => (prev.key === k ? { ...prev, loading: true } : { ...EMPTY, key: k, loading: true }))
    try {
      const data = await readNearVault(NEAR_RPC_URLS, k, REGISTRY_USDC)
      if (latestKey.current !== k) return
      track('near_vault_read', { outcome: data.state })
      setRead({
        key: k,
        loading: false,
        data,
        failure: null,
        lastGood: data.state === 'live' ? { block: data.snapshot.blocks.max, readAt: data.snapshot.readAt } : null,
      })
    } catch (e) {
      if (latestKey.current !== k) return
      const unreachable = e instanceof NearUnreachable
      const reason =
        e instanceof NearUnreachable
          ? e.tried.map((t) => `${t.host}: ${t.reason}`).join('; ') || 'No host is configured.'
          : e instanceof Error
            ? e.message
            : String(e)
      track('near_vault_read', { outcome: unreachable ? 'unreachable' : 'error' })
      // A failed read hides the numbers: showing the previous ones would present them as current.
      setRead((prev) => (prev.key === k ? { ...prev, loading: false, data: null, failure: { at: new Date().toISOString(), reason, unreachable } } : prev))
    }
  }, [key])

  useEffect(() => {
    setExtraPayees([])
    void load()
  }, [load])

  const unreachable = read.key === key && read.failure?.unreachable === true
  useEffect(() => {
    if (!unreachable) return
    const t = setInterval(() => {
      if (!document.hidden) void load()
    }, UNANSWERED_RETRY_MS)
    return () => clearInterval(t)
  }, [unreachable, load])

  const data = read.key === key ? read.data : null
  const s = data?.state === 'live' ? data.snapshot : null
  const rows = useMemo(() => (s ? keyRows(s.vaultId, s.keys, s.agents, s.chainNowS) : []), [s])
  const payingKeys = rows.filter((r) => r.canPay).length
  const { byPayee, loading: payeesLoading, payees } = usePayeeFacts(s, extraPayees)

  const onLanded = useCallback(() => {
    void load()
    setLanded((n) => n + 1)
  }, [load])

  const ctx: ActionContext | null = s
    ? { wallet, ownerId: s.config.ownerId, vaultId: s.vaultId, tokenId: s.config.tokenId, decimals: s.token.decimals, symbol: s.token.symbol ?? 'units', onLanded }
    : null
  const isOwner = Boolean(s && wallet.accountId === s.config.ownerId)
  const planned = vaultId === PLANNED.vault

  return (
    <AppPage
      title="NEAR vault"
      description="An AI agent's spend vault on NEAR, read live from the chain with no wallet and no account: its limits, who can sign for it, what waits for its owner, and what the A-Identity registry says about each payee. Its owner runs it here from their own wallet. A-Identity holds no key and signs nothing."
      actions={<Pill tone="accent">Testnet only</Pill>}
    >
      <div className="space-y-4">
        <WalletBar wallet={wallet} ownerId={s?.config.ownerId ?? null} />
        <VaultPicker vaultId={vaultId} source={source} onOpen={open} />

        {vaultParam && !valid && (
          <section role="alert" className="rounded-2xl border border-danger/35 bg-danger/[0.07] p-4 text-sm text-foreground">
            <p className="font-semibold">"{vaultParam}" is not a NEAR account id, so nothing was read.</p>
            <p className="mt-1 text-foreground/85">A NEAR account id is lowercase letters, digits, and . - _ between them, such as {PLANNED.vault}.</p>
          </section>
        )}

        {!vaultId && <NotDeployed onOpen={open} />}

        {valid && (
          <section aria-label="Vault" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">{s ? 'Vault, read live' : 'Vault'}</h2>
              <button type="button" onClick={() => void load()} disabled={read.loading} className={BUTTON_QUIET}>
                {read.loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
                {read.loading ? 'Reading the chain...' : 'Refresh'}
              </button>
            </div>

            {read.failure && read.key === key && (
              <ReadFailed at={read.failure.at} reason={read.failure.reason} lastGood={read.lastGood} retrying={read.failure.unreachable} />
            )}

            {!data && read.loading && !read.failure && (
              <div className="space-y-3" aria-busy="true" aria-label="Reading the vault">
                <Skeleton className="h-48 w-full rounded-2xl" />
                <Skeleton className="h-28 w-full rounded-2xl" />
                <div className="grid gap-3 lg:grid-cols-2">
                  <Skeleton className="h-40 w-full rounded-2xl" />
                  <Skeleton className="h-40 w-full rounded-2xl" />
                </div>
              </div>
            )}

            {data && data.state !== 'live' && (
              <NotAVault
                kind={data.state}
                vaultId={data.vaultId}
                blockHeight={data.blockHeight}
                host={data.host}
                readAt={data.readAt}
                reason={data.state === 'not-vault' ? data.reason : undefined}
                codeHash={data.state === 'not-vault' ? data.codeHash : undefined}
                planned={planned}
              />
            )}

            {s && ctx && (
              // ONE key, on the whole live view: another vault starts every card fresh (half-typed
              // amounts, an open approval, the transactions this browser sent), and a new read of
              // the same vault updates the cards in place. The same key on several siblings instead
              // makes React keep stale copies and add more on every read.
              <Fragment key={s.vaultId}>
                <VaultOverview s={s} payingKeys={payingKeys} refreshing={read.loading} />
                {isOwner && <OwnerControls s={s} ctx={ctx} byPayee={byPayee} />}
                <HeldPayments s={s} byPayee={byPayee} payeesLoading={payeesLoading} ctx={ctx} />
                <div className="grid gap-4 lg:grid-cols-2">
                  <PolicyCard s={s} connected={wallet.accountId} />
                  <KeysCard s={s} rows={rows} />
                </div>
                <PayeesCard
                  s={s}
                  payees={payees}
                  byPayee={byPayee}
                  loading={payeesLoading}
                  onCheck={(p) => setExtraPayees((list) => [p, ...list.filter((x) => x !== p)].slice(0, 8))}
                />
                {!isOwner && <OwnerControls s={s} ctx={ctx} byPayee={byPayee} />}
                <Activity vaultId={s.vaultId} ownerId={s.config.ownerId} tokenId={s.config.tokenId} decimals={s.token.decimals} symbol={s.token.symbol ?? 'units'} refreshKey={landed} />
                <ContractCard s={s} />
              </Fragment>
            )}
          </section>
        )}
      </div>
    </AppPage>
  )
}
