/**
 * /app/vault/arc: the live state of any AgentSpendPolicy vault on Arc and its recent events, read
 * straight from the chain, and, for its owner, the controls to run it. Also where a vault the owner holds is
 * deployed in the first place, from the owner's own wallet.
 *
 * Public on purpose, like /app/vault/stellar: a vault's limits are on a public chain already,
 * and a claim about a budget an agent cannot exceed should be checkable by someone who does not
 * trust us, without an account and without a wallet. The page sits in the console shell but
 * outside the sign-in gate, and nothing on it needs a session: reads go to the registry's Arc
 * RPCs directly, and every write is built here, simulated as the owner and signed in the owner's
 * own wallet. A-Identity holds no key and signs nothing on this page.
 *
 * Unlike the Stellar page, controls exist for Arc MAINNET vaults, on purpose: an owner-held vault
 * on Arc Mainnet is what this page is for. They are labelled real money, they open only for a
 * vault whose code is the build this page deploys, and our own launch-day vault is view only and
 * labelled as deployed with our server key.
 *
 * Deep link: ?network=<CAIP-2 or registry id>&contract=<0x...>, or ?deploy=1 for the setup. A
 * network that is not an Arc chain in the registry is refused by name, and a contract with no
 * network is asked about: the network is never guessed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { getAddress, isAddress } from 'viem'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import DeployFlow from '../../components/app/arc/DeployFlow'
import FundForm from '../../components/app/arc/FundForm'
import OwnerControls from '../../components/app/arc/OwnerControls'
import OwnerMatch from '../../components/app/arc/OwnerMatch'
import TxReceipt from '../../components/app/arc/TxReceipt'
import VaultEvents from '../../components/app/arc/VaultEvents'
import VaultBoundary from '../../components/app/arc/VaultBoundary'
import VaultPicker from '../../components/app/arc/VaultPicker'
import VaultStatus from '../../components/app/arc/VaultStatus'
import WalletBar from '../../components/app/arc/WalletBar'
import { useArcSetup } from '../../components/app/arc/useArcSetup'
import { useArcWallet, type ArcWalletState } from '../../components/app/arc/useArcWallet'
import { Chip, Mono } from '../../components/app/stellar/bits'
import { track } from '../../lib/analytics'
import type { Chain } from '../../lib/chains'
import { listKnownVaults, seededKnownVaults, type KnownVaults } from '../../lib/arc/known-vaults'
import { autoLandVault, FUND_RISK, isOurKey, isOurVault, NAMES_OUR_KEY, NOT_MY_VAULT } from '../../lib/arc/ours'
import { clearTx, loadTx, saveTx, type TxRecord } from '../../lib/arc/pending'
import { predictedVault, setupAlert, withRecord } from '../../lib/arc/tx-rules'
import {
  ARC_CHAINS,
  ARC_MAINNET,
  READ_FAILURE_NEXT,
  READ_FAILURE_TITLE,
  arcChainFor,
  localTime,
  networkName,
  networkWord,
  readVault,
  type ReadFailure,
  type VaultSnapshot,
} from '../../lib/arc/vault-read'
import { deployFormRefused, sameAddress } from '../../lib/arc/vault-rules'

type ReadState = {
  /** The vault this state is about, so a late answer for another vault is dropped. */
  key: string
  loading: boolean
  data: VaultSnapshot | null
  failure: ReadFailure | null
  /** The last successful read, kept only to say WHEN it was; its numbers are never shown. */
  lastGood: { block: bigint; readAt: string } | null
}

const EMPTY: ReadState = { key: '', loading: false, data: null, failure: null, lastGood: null }

export default function ArcVault() {
  const [params, setParams] = useSearchParams()
  const networkParam = params.get('network')
  const contractParam = params.get('contract')?.trim() || null
  const deployMode = params.get('deploy') === '1'
  const chain = arcChainFor(networkParam)
  const network = chain?.caip2 ?? null
  const contract = contractParam && isAddress(contractParam, { strict: false }) ? getAddress(contractParam) : null
  const key = network && contract ? `${network}:${contract.toLowerCase()}` : ''
  const target: Chain = chain ?? ARC_MAINNET

  const wallet = useArcWallet()
  const store = useArcSetup()
  const setup = store.setup
  // Mainnet is the form's default and it is real money, so a typo in a deploy link opens no form.
  const deployRefused = deployMode && deployFormRefused(networkParam, Boolean(chain), Boolean(setup && arcChainFor(setup.network)))
  // What the build knows, from the first render; the backend's rows join it when it answers.
  const [known, setKnown] = useState<KnownVaults | null>(seededKnownVaults)
  // Set once someone starts on an address of their own: nothing moves the page for them after that.
  const typing = useRef(false)
  // A stranger's yes to funding this vault from this account. See the Fund section.
  const [fundAck, setFundAck] = useState<string | null>(null)
  const [read, setRead] = useState<ReadState>(EMPTY)
  const [tx, setTx] = useState<(TxRecord & { key: string }) | null>(null)
  // Bumped when a write from this page reaches its end, so the activity list reads it too.
  const [eventsRound, setEventsRound] = useState(0)
  const latestKey = useRef(key)
  latestKey.current = key

  useEffect(() => {
    let alive = true
    void listKnownVaults().then((k) => alive && setKnown(k))
    return () => {
      alive = false
    }
  }, [])

  const pick = useCallback(
    (net: string, c: string, replace?: boolean) => setParams({ network: net, contract: c }, { replace: Boolean(replace) }),
    [setParams],
  )
  const openDeploy = useCallback((net: string) => setParams({ network: net, deploy: '1' }), [setParams])
  const closeDeploy = useCallback(() => setParams(network ? { network } : {}), [setParams, network])

  // With no vault in the link, open one so the page lands on live values: the connected account's
  // own, else ours (labelled as ours), on the network the link named. Never a stranger's, and
  // never once someone has started typing an address of their own.
  const refused = Boolean(networkParam && !chain) || Boolean(contractParam && !contract)
  useEffect(() => {
    if (deployMode || contractParam || refused || !known || typing.current) return
    const first = autoLandVault(known.vaults, network ?? ARC_MAINNET.caip2, wallet.account)
    if (first) pick(first.network, first.address, true)
  }, [deployMode, contractParam, refused, known, network, pick, wallet.account])

  const load = useCallback(async () => {
    if (!chain || !contract) return
    const k = `${chain.caip2}:${contract.toLowerCase()}`
    setRead((prev) => (prev.key === k ? { ...prev, loading: true } : { ...EMPTY, key: k, loading: true }))
    const r = await readVault(chain, contract)
    if (latestKey.current !== k) return
    track('arc_vault_read', { network: networkWord(chain), outcome: r.ok ? 'ok' : r.failure.kind })
    setRead((prev) => {
      if (prev.key !== k) return prev
      if (r.ok) return { key: k, loading: false, data: r.data, failure: null, lastGood: { block: r.data.block, readAt: r.data.readAt } }
      // A failed read hides the numbers: showing the previous ones would present them as
      // current. Only the time of the last good read is kept, labelled as stale.
      return { ...prev, loading: false, data: null, failure: r.failure }
    })
  }, [chain, contract])

  useEffect(() => {
    void load()
  }, [load])

  // The latest transaction this browser sent for the vault, so a reload keeps its receipt.
  useEffect(() => {
    if (!network || !contract) {
      setTx(null)
      return
    }
    const r = loadTx(network, contract)
    setTx(r ? { ...r, key } : null)
  }, [network, contract, key])

  const onSubmitted = useCallback(
    (r: TxRecord) => {
      saveTx(r)
      setTx({ ...r, key })
    },
    [key],
  )
  const onTxUpdate = useCallback(
    (r: TxRecord) => {
      saveTx(r)
      setTx({ ...r, key })
    },
    [key],
  )

  const v = read.key === key ? read.data : null
  const listedRow = v ? known?.vaults.find((r) => r.network === v.network && sameAddress(r.address, v.address)) : undefined
  const isOwner = Boolean(v && wallet.account && sameAddress(wallet.account, v.owner))
  const fundAcked = fundAck === `${key}:${wallet.account ?? ''}`
  const shownTx = tx && tx.key === key ? tx : null
  // From the ledger as generated into this build, so the labels hold with the backend asleep.
  const ours = Boolean(v && isOurVault(v.network, v.address, known?.vaults))
  const ownerIsOurKey = Boolean(v && isOurKey(v.network, v.owner, known?.ourKeys))
  // The setup this browser holds, whatever this page is showing: a deploy the wallet was asked for
  // with no hash back, a deploy with no receipt yet, or a vault whose expiry has not been seen to
  // land. The last is hidden only when the vault on screen IS that vault and reads an expiry.
  const alert = setupAlert(setup, v)
  const setupAt = setup ? predictedVault(setup) : null

  return (
    <AppPage
      title="Arc vault"
      description="See what any spending vault on Arc holds and what its agent can do, read live from the network with no wallet and no account. Or deploy a vault you own, from your own wallet, and run it: A-Identity holds no key and signs nothing on this page."
    >
      <div className="space-y-4">
        <WalletBar wallet={wallet} target={deployMode && setup ? (arcChainFor(setup.network) ?? target) : target} />

        {setup && alert && !deployMode && (
          <div
            role="alert"
            className={`space-y-3 rounded-2xl border p-4 text-sm ${alert === 'unbounded' ? 'border-danger/30 bg-danger/[0.08]' : 'border-warn/30 bg-warn/10'}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <ShieldAlert size={16} className={`mt-0.5 shrink-0 ${alert === 'unbounded' ? 'text-danger' : 'text-warn'}`} aria-hidden="true" />
                <div className="min-w-0 text-foreground">
                  {alert === 'unbounded' ? (
                    <>
                      <span className="font-semibold">This browser has not seen an end date set for the agent key of the vault you deployed.</span>{' '}
                      <span className="break-all font-mono text-xs">{setupAt}</span>. Until one is set, its agent key has no time bound.
                    </>
                  ) : alert === 'untracked' ? (
                    <>
                      <span className="font-semibold">A vault deploy from this browser is no longer tracked, and no receipt was seen.</span> If it
                      still lands, it creates a vault
                      {setupAt ? (
                        <>
                          {' '}
                          at <Mono>{setupAt}</Mono>
                        </>
                      ) : null}{' '}
                      whose agent key has no time bound until one is set.
                    </>
                  ) : alert === 'deploying' ? (
                    <>
                      <span className="font-semibold">A vault deploy from this browser has no receipt yet.</span> Once it lands, the vault
                      {setupAt ? (
                        <>
                          {' '}
                          (expected at <Mono>{setupAt}</Mono>)
                        </>
                      ) : null}{' '}
                      exists with an agent key that has no time bound until the setup sets one.
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">Your wallet was asked to create a vault from this browser, and this page has not heard back.</span>{' '}
                      If it sent the deploy, the vault appears at <Mono>{setupAt ?? 'the address your next transaction creates'}</Mono> with an agent key
                      that has no time bound until the setup sets one.
                    </>
                  )}
                </div>
              </div>
              <Button size="sm" onClick={() => openDeploy(setup.network)}>
                Finish the setup
              </Button>
            </div>
            {/* The deploy is asked about here too, so leaving the setup view never stops its receipt being read. */}
            {alert === 'deploying' && setup.deploy && (
              <TxReceipt record={setup.deploy} onUpdate={(r) => store.patch(setup.startedAt, (s) => withRecord(s, 'deploy', r))} />
            )}
          </div>
        )}

        {deployRefused ? (
          <DeployLinkRefused networkParam={networkParam ?? ''} />
        ) : deployMode ? (
          <VaultBoundary what="The setup">
            <DeployFlow
              chain={target}
              onChainChange={(caip2) => setParams({ network: caip2, deploy: '1' }, { replace: true })}
              wallet={wallet}
              store={store}
              onOpenVault={(net, addr) => pick(net, addr)}
              onClose={closeDeploy}
            />
          </VaultBoundary>
        ) : (
          <VaultPicker known={known} network={network} contract={contract} onPick={pick} onDeploy={openDeploy} onTyping={() => (typing.current = true)} />
        )}

        {networkParam && !chain && !deployRefused && (
          <FailureLine
            title={`"${networkParam}" is not an Arc network we know.`}
            next={`Pick ${ARC_CHAINS.map(networkName).join(' or ')} in the box above. The network is never guessed: the same address means different things on each.`}
          />
        )}
        {contractParam && !contract && (
          <FailureLine title="That is not a vault address." next="A vault address is 0x followed by 40 hexadecimal characters. Paste it in the box above." />
        )}
        {contract && !networkParam && !deployMode && (
          <FailureLine
            title="The link names a vault but no network."
            next="Pick Arc Mainnet or Arc testnet above and press Read live. The network is never guessed: the same address means different things on each."
          />
        )}

        {!deployMode && chain && contract && (
          <VaultBoundary key={key} what="This vault">
          <section aria-label="Vault" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">Vault on {networkName(chain)}</h2>
                {chain.testnet ? (
                  <Chip tone="muted">Test USDC: rehearsal</Chip>
                ) : (
                  <span className="rounded-full border border-warn/40 bg-warn/15 px-3 py-1 text-xs font-bold uppercase tracking-wide text-warn">
                    Arc Mainnet - real USDC
                  </span>
                )}
                {ours && <Chip tone="warn">Ours: server key</Chip>}
              </div>
              <button
                type="button"
                onClick={() => void load()}
                disabled={read.loading}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {read.loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
                {read.loading ? 'Reading the chain...' : 'Refresh'}
              </button>
            </div>

            {/* Above the values and outside anything the refetch replaces, so the hash stays on
                screen while the vault's new state loads under it. */}
            {shownTx && (
              <div className="space-y-2">
                <TxReceipt
                  record={shownTx}
                  onUpdate={onTxUpdate}
                  onSettled={() => {
                    void load()
                    setEventsRound((n) => n + 1)
                  }}
                />
                {shownTx.outcome !== 'pending' && (
                  <button
                    type="button"
                    onClick={() => {
                      clearTx(chain.caip2, contract)
                      setTx(null)
                    }}
                    className="text-xs font-semibold text-accent underline underline-offset-2"
                  >
                    Dismiss this receipt
                  </button>
                )}
              </div>
            )}

            {read.failure && read.key === key && (
              <div role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
                <div className="font-semibold text-foreground">
                  Read failed at {localTime(read.failure.at)}: {READ_FAILURE_TITLE[read.failure.kind]}.
                </div>
                <div className="mt-1 break-words text-foreground/80">{read.failure.reason}.</div>
                <div className="mt-2 text-foreground/80">
                  <span className="font-semibold text-foreground">Next step: </span>
                  {READ_FAILURE_NEXT[read.failure.kind]}
                </div>
                {read.lastGood && (
                  <div className="mt-2 text-xs text-foreground/60">
                    The last good read was at block {read.lastGood.block.toLocaleString('en-US')}, {localTime(read.lastGood.readAt)}. Its numbers
                    are not shown because they may no longer be true.
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
              </div>
            )}

            {v && <VaultStatus
                v={v}
                chain={chain}
                ours={ours}
                ownerIsOurKey={ownerIsOurKey}
                operatorIsOurKey={isOurKey(v.network, v.operator, known?.ourKeys)}
                ownerKind={listedRow?.ownerKind}
                refreshing={read.loading}
              />}

            {v && <VaultEvents key={key} chain={chain} vault={v.address} decimals={v.decimals} refreshKey={eventsRound} />}

            {v && (
              <section aria-label="Owner" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-foreground">Owner</h3>
                <div className="mt-2 space-y-3">
                  <OwnerSection
                    v={v}
                    chain={chain}
                    wallet={wallet}
                    ours={ours}
                    ownerIsOurKey={ownerIsOurKey}
                    pending={shownTx?.outcome === 'pending'}
                    onSubmitted={onSubmitted}
                  />
                </div>
              </section>
            )}

            {v && !ours && !ownerIsOurKey && v.knownBuild && v.usdcMatches && (
              <section aria-label="Fund" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-foreground">Fund this vault</h3>
                <p className="mt-1 text-xs text-foreground/70">{FUND_RISK} Send only after its session key has an expiry.</p>
                <div className="mt-3">
                  {!wallet.account || !wallet.wallet ? (
                    <p className="text-xs text-foreground/65">Connect an EVM wallet above to send USDC into it.</p>
                  ) : wallet.chainId !== chain.chainId ? (
                    <p className="text-xs text-foreground/65">Your wallet is on another chain. Switch it to {networkName(chain)} in the strip above.</p>
                  ) : v.sessionKeyExpiry === 0n ? (
                    <p className="text-xs font-semibold text-danger">
                      Not offered: this vault's agent key has no time bound. Its owner should set an expiry first.
                    </p>
                  ) : (
                    <>
                      {!isOwner && (
                        <label className="mb-3 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={fundAcked}
                            onChange={(e) => setFundAck(e.target.checked ? `${key}:${wallet.account ?? ''}` : null)}
                          />
                          <span>
                            Your connected account is not this vault's owner, so you would have no way to take USDC back out. {NOT_MY_VAULT}
                          </span>
                        </label>
                      )}
                      {(isOwner || fundAcked) && (
                        <FundForm
                          chain={chain}
                          vault={v}
                          provider={wallet.wallet.provider}
                          account={wallet.account}
                          onSubmitted={onSubmitted}
                          held={shownTx?.outcome === 'pending'}
                        />
                      )}
                    </>
                  )}
                </div>
              </section>
            )}
          </section>
          </VaultBoundary>
        )}
      </div>
    </AppPage>
  )
}

/**
 * A deploy link whose network is not one we know. Refused by name, with no form under it: which
 * network to deploy on decides whether real money moves, so it is asked, never defaulted.
 */
function DeployLinkRefused({ networkParam }: { networkParam: string }) {
  return (
    <section aria-label="Choose a network" role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
      <div className="font-semibold text-foreground">"{networkParam}" is not an Arc network we know, so this page shows no deploy form for it.</div>
      <p className="mt-1 text-foreground/80">
        The network is never guessed. Arc Mainnet uses real USDC and Arc testnet uses free test USDC, so you choose. Nothing has been sent.
      </p>
      <ul className="mt-2 space-y-1">
        {ARC_CHAINS.map((c) => (
          <li key={c.caip2}>
            <Link to={{ search: `?network=${encodeURIComponent(c.caip2)}&deploy=1` }} className="font-semibold text-accent underline underline-offset-2">
              {c.testnet ? 'Practice on Arc testnet (free test USDC)' : 'Deploy on Arc Mainnet (real USDC)'}
            </Link>
          </li>
        ))}
        <li>
          <Link to={{ search: '' }} className="font-semibold text-accent underline underline-offset-2">
            Back to the vault list
          </Link>
        </li>
      </ul>
    </section>
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
 * Who owns it, then, only if every condition holds, the controls. Each condition that fails
 * says which one and what to do; none of them disables a button that is still drawn.
 */
function OwnerSection({
  v,
  chain,
  wallet,
  ours,
  ownerIsOurKey,
  pending,
  onSubmitted,
}: {
  v: VaultSnapshot
  chain: Chain
  wallet: ArcWalletState
  ours: boolean
  ownerIsOurKey: boolean
  pending: boolean
  onSubmitted: (r: TxRecord) => void
}) {
  const ownerLine = <OwnerMatch vault={v} account={wallet.account} ownerIsOurKey={ownerIsOurKey} />

  if (ours || ownerIsOurKey)
    return (
      <>
        {ownerLine}
        <p className="text-sm text-foreground/75">
          {ours ? 'This is our own vault, so this page offers no controls for it, whoever is connected.' : `${NAMES_OUR_KEY} This page offers no controls for it, whoever is connected.`}
        </p>
      </>
    )
  if (!v.knownBuild)
    return (
      <>
        {ownerLine}
        <p className="text-sm text-foreground/75">
          This vault's code is not the build this page deploys, so the page builds no owner calls for it, whoever is connected.
        </p>
      </>
    )
  if (!v.usdcMatches)
    return (
      <>
        {ownerLine}
        <p className="text-sm text-foreground/75">This vault holds a token that is not the registry's USDC, so the page builds no calls for it.</p>
      </>
    )
  if (!wallet.account || !wallet.wallet || !sameAddress(wallet.account, v.owner)) return ownerLine
  if (wallet.chainId === null)
    return (
      <>
        {ownerLine}
        <p className="text-sm text-foreground/75">Your wallet has not said which chain it is on. Press the refresh icon in the wallet strip, or reconnect.</p>
      </>
    )
  if (wallet.chainId !== chain.chainId)
    return (
      <>
        {ownerLine}
        <div className="flex flex-wrap items-center gap-3 text-sm text-foreground/80">
          Your wallet is on chain {wallet.chainId}; this vault is on {networkName(chain)} (chain {chain.chainId}).
          <Button size="sm" onClick={() => void wallet.switchTo(chain)} disabled={wallet.busy}>
            Switch to {networkName(chain)}
          </Button>
        </div>
      </>
    )
  return (
    <>
      {ownerLine}
      <OwnerControls
        key={`${v.network}:${v.address}`}
        chain={chain}
        vault={v}
        provider={wallet.wallet.provider}
        onSubmitted={onSubmitted}
        held={pending}
      />
    </>
  )
}
