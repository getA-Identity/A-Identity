/**
 * /app/vault/stellar: the live state of any AgentSpendPolicy vault on Stellar, and, for the
 * owner of a testnet vault, the controls to freeze it and withdraw from it.
 *
 * Public on purpose. A vault's limits are on a public ledger already, and the point of
 * showing them is that a claim about a budget an agent cannot exceed should be checkable by
 * someone who does not trust us, without an account and without a wallet. The page sits in
 * the console shell but outside the sign-in gate; only the owner actions need a session,
 * and they ask for one at the moment they need it.
 *
 * The order is the owner's: the one-sentence answer first, then every field with the ledger
 * it was read at, then who owns the vault, and only after that, any control. A pubnet vault
 * is real money and this page is view-only for it: its controls are never mounted.
 *
 * Deep link: ?network=<CAIP-2 or registry id>&contract=<C...>. A network that is not a
 * Stellar chain in the registry is refused by name, and a missing one is asked for: never guessed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'
import FailureNotice from '../../components/app/stellar/FailureNotice'
import OwnerControls from '../../components/app/stellar/OwnerControls'
import OwnerMatch from '../../components/app/stellar/OwnerMatch'
import TxReceipt, { type Receipt } from '../../components/app/stellar/TxReceipt'
import VaultPicker from '../../components/app/stellar/VaultPicker'
import VaultStatus from '../../components/app/stellar/VaultStatus'
import WalletBar from '../../components/app/stellar/WalletBar'
import { Chip } from '../../components/app/stellar/bits'
import { useStellarWallet } from '../../components/app/stellar/useStellarWallet'
import { track } from '../../lib/analytics'
import {
  CONTRACT_ID,
  READ_FAILURE_NEXT,
  READ_FAILURE_TITLE,
  ROLE_NAME,
  localTime,
  networkWord,
  readVault,
  stellarChainFor,
  type ReadFailure,
  type VaultRead,
} from '../../lib/stellar/vault-read'

type ReadState = {
  /** The vault this state is about, so a late answer for another vault is dropped. */
  key: string
  loading: boolean
  data: VaultRead | null
  failure: ReadFailure | null
  /** The last successful read, kept only to say WHEN it was; its numbers are never shown. */
  lastGood: { ledger: number; readAt: string } | null
  waking: boolean
}

const EMPTY: ReadState = { key: '', loading: false, data: null, failure: null, lastGood: null, waking: false }

export default function StellarVault() {
  const [params, setParams] = useSearchParams()
  const networkParam = params.get('network')
  const contractParam = params.get('contract')?.trim() ?? null
  const chain = stellarChainFor(networkParam)
  const network = chain?.caip2 ?? null
  const contract = contractParam && CONTRACT_ID.test(contractParam) ? contractParam : null
  const key = network && contract ? `${network}:${contract}` : ''

  const wallet = useStellarWallet()
  const [read, setRead] = useState<ReadState>(EMPTY)
  const [receipt, setReceipt] = useState<(Receipt & { key: string }) | null>(null)
  const latestKey = useRef(key)
  latestKey.current = key

  const pick = useCallback(
    (net: string, c: string, replace?: boolean) => {
      setParams({ network: net, contract: c }, { replace: Boolean(replace) })
    },
    [setParams],
  )

  const load = useCallback(async () => {
    if (!network || !contract) return
    const k = `${network}:${contract}`
    setRead((prev) => (prev.key === k ? { ...prev, loading: true, waking: false } : { ...EMPTY, key: k, loading: true }))
    const r = await readVault(network, contract, () => {
      if (latestKey.current === k) setRead((prev) => (prev.key === k ? { ...prev, waking: true } : prev))
    })
    if (latestKey.current !== k) return
    track('stellar_vault_read', { network: networkWord(network), outcome: r.ok ? 'ok' : r.failure.kind })
    setRead((prev) => {
      if (prev.key !== k) return prev
      if (r.ok)
        return { key: k, loading: false, data: r.data, failure: null, lastGood: { ledger: r.data.ledger, readAt: r.data.readAt }, waking: false }
      // A failed read hides the numbers: showing the previous ones would present them as
      // current. Only the time of the last good read is kept, labelled as stale.
      return { ...prev, loading: false, data: null, failure: r.failure, waking: false }
    })
  }, [network, contract])

  useEffect(() => {
    void load()
  }, [load])

  const onReceipt = useCallback(
    (r: Receipt) => {
      setReceipt({ ...r, key })
      if (r.outcome === 'settled') void load()
    },
    [key, load],
  )

  const v = read.key === key ? read.data : null
  const signerAddress = wallet.signer?.address ?? null
  const shownReceipt = receipt && receipt.key === key ? receipt : null

  return (
    <AppPage
      title="Stellar vault"
      description="The live state of any AgentSpendPolicy vault on Stellar, read from the ledger. The owner of a testnet vault can freeze it and withdraw from it here, signing in their own wallet."
    >
      <div className="space-y-4">
        <WalletBar wallet={wallet} />
        <VaultPicker network={network} contract={contract} autoPick={!contractParam && !(networkParam && !chain)} onPick={pick} />

        {networkParam && !chain && (
          <FailureLine
            title={`"${networkParam}" is not a Stellar network we know.`}
            next="Pick testnet or pubnet in the box above. The network is never guessed: the same contract id means different things on each."
          />
        )}
        {contractParam && !contract && (
          <FailureLine title="That is not a vault contract id." next="A vault id starts with C and is 56 characters long. Paste it in the box above." />
        )}
        {contract && !networkParam && (
          <FailureLine
            title="The link names a vault but no network."
            next="Pick testnet or pubnet above and press Read live. The network is never guessed: the same contract id means different things on each."
          />
        )}

        {network && contract && (
          <section aria-label="Vault" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">
                  {v?.role ? ROLE_NAME[v.role] : 'Vault'} on Stellar {networkWord(network)}
                </h2>
                {((chain && !chain.testnet) || v?.realMoney) && (
                  <span className="rounded-full border border-warn/40 bg-warn/15 px-3 py-1 text-xs font-bold uppercase tracking-wide text-warn">
                    Real money - view only
                  </span>
                )}
                {v?.role === 'rehearsal' && <Chip tone="warn">Rehearsal</Chip>}
              </div>
              <button
                type="button"
                onClick={() => void load()}
                disabled={read.loading}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {read.loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
                {read.loading ? (read.waking ? 'Waking the backend...' : 'Reading...') : 'Refresh'}
              </button>
            </div>

            {v?.roleLabel && (
              <p
                className={
                  v.role === 'rehearsal'
                    ? 'rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85'
                    : 'text-xs text-foreground/65'
                }
              >
                {v.roleLabel}
              </p>
            )}

            {/* Above the values and outside anything the refetch replaces, so the hash
                stays on screen while the vault's new state loads under it. */}
            {shownReceipt && (
              <TxReceipt
                receipt={shownReceipt}
                onUpdate={(r) => setReceipt({ ...r, key })}
                onSettled={() => void load()}
              />
            )}

            {read.failure && read.key === key && (
              <div role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
                <div className="font-semibold text-foreground">
                  Read failed at {localTime(read.failure.at)}: {READ_FAILURE_TITLE[read.failure.kind]}.
                </div>
                <div className="mt-1 text-foreground/80">{read.failure.reason}.</div>
                {read.failure.wasmHash && (
                  <div className="mt-1 break-all font-mono text-xs text-foreground/70">Code hash: {read.failure.wasmHash}</div>
                )}
                <div className="mt-2 text-foreground/80">
                  <span className="font-semibold text-foreground">Next step: </span>
                  {READ_FAILURE_NEXT[read.failure.kind]}
                </div>
                {read.lastGood && (
                  <div className="mt-2 text-xs text-foreground/60">
                    The last good read was at ledger {read.lastGood.ledger.toLocaleString('en-US')}, {localTime(read.lastGood.readAt)}. Its
                    numbers are not shown because they may no longer be true.
                  </div>
                )}
              </div>
            )}

            {!v && read.loading && !read.failure && (
              <div className="space-y-3" aria-busy="true" aria-label="Reading the vault">
                <Skeleton className="h-20 w-full rounded-2xl" />
                <div className="grid gap-3 lg:grid-cols-2">
                  <Skeleton className="h-32 w-full rounded-2xl" />
                  <Skeleton className="h-32 w-full rounded-2xl" />
                </div>
                {read.waking && <p className="text-xs text-foreground/60">Waking up the backend (free tier), usually under a minute...</p>}
              </div>
            )}

            {v && <VaultStatus v={v} refreshing={read.loading} />}

            {v && (
              <section aria-label="Owner" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-foreground">Owner</h3>
                <div className="mt-2 space-y-3">
                  <OwnerSection
                    vault={v}
                    wallet={wallet}
                    signerAddress={signerAddress}
                    onReceipt={onReceipt}
                    pending={shownReceipt?.outcome === 'pending'}
                  />
                </div>
              </section>
            )}
          </section>
        )}
      </div>
    </AppPage>
  )
}

function FailureLine({ title, next }: { title: string; next: string }) {
  return (
    <div role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
      <div className="font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-foreground/80">
        <span className="font-semibold text-foreground">Next step: </span>
        {next}
      </div>
    </div>
  )
}

/**
 * Who owns it, then, only if every condition holds, the controls. Each condition that
 * fails says which one and what to do; none of them disables a button that is still drawn.
 */
function OwnerSection({
  vault,
  wallet,
  signerAddress,
  onReceipt,
  pending,
}: {
  vault: VaultRead
  wallet: ReturnType<typeof useStellarWallet>
  signerAddress: string | null
  onReceipt: (r: Receipt) => void
  /** A transaction this page submitted for the vault has no ledger yet. */
  pending: boolean
}) {
  const ownerLine = <OwnerMatch vault={vault} address={signerAddress} />

  // Real money: view only. The controls component is not mounted at all. The registry's own
  // testnet flag is checked as well as the backend's realMoney, so neither alone can open it.
  const testnet = stellarChainFor(vault.network)?.testnet === true
  if (vault.realMoney || !testnet)
    return (
      <>
        {signerAddress && ownerLine}
        <p className="text-sm text-foreground/75">
          This is a pubnet vault holding real money. This panel is view-only for it and offers no controls, whoever is connected.
        </p>
      </>
    )

  // A passkey smart account owner is never a browser wallet, so no wallet state changes
  // the answer; OwnerMatch says where its controls live.
  if (vault.ownerKind === 'smart-account') return ownerLine

  // Code we did not publish, in no registry slot: the backend builds no owner call for it
  // (unknown_vault), and the read's own note says so. Drawing controls that can only fail
  // would contradict that note.
  if (!vault.knownBuild && !vault.role)
    return (
      <>
        {signerAddress && ownerLine}
        <p className="text-sm text-foreground/75">
          This vault runs code that is not an AgentSpendPolicy build we published, so this console builds no owner calls for it,
          whoever is connected.
        </p>
      </>
    )

  if (!wallet.signer) {
    if (wallet.detect === 'none')
      return <FailureNotice failure={{ code: 'no_wallet', message: '' }} network={vault.network} />
    return ownerLine
  }

  if (signerAddress !== vault.owner) return ownerLine

  const reading = wallet.network
  if (!reading)
    return (
      <>
        {ownerLine}
        <p className="text-sm text-foreground/65">Reading which network your wallet is on...</p>
      </>
    )
  if (!reading.reported)
    return (
      <>
        {ownerLine}
        <FailureNotice
          failure={{
            code: 'wallet_network_unknown',
            message:
              'This wallet does not report which network it is on, so we cannot confirm it is on testnet. Use Freighter, or a wallet that reports its network.',
          }}
          network={vault.network}
        />
      </>
    )
  if (reading.network !== vault.network)
    return (
      <>
        {ownerLine}
        <FailureNotice
          failure={{
            code: 'wrong_network',
            message: `${wallet.signer.walletName || 'Your wallet'} is on ${reading.network ? networkWord(reading.network) : 'a network that is neither testnet nor pubnet'}; this vault is on ${networkWord(vault.network)}.`,
            walletNetwork: reading.network,
            targetNetwork: vault.network,
          }}
          network={vault.network}
        />
      </>
    )

  return (
    <>
      {ownerLine}
      <OwnerControls key={`${vault.network}:${vault.contract}`} vault={vault} signer={wallet.signer} onReceipt={onReceipt} pending={pending} />
    </>
  )
}
