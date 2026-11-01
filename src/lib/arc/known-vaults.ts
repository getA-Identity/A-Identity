/**
 * The Arc vaults this page can offer without anyone typing an address: ours from the provenance
 * ledger (generated into src/lib/arc-ledger.ts, and GET /api/proof/arc for the details) and the
 * owner-held ones Milestone 1 counts (GET /api/arc/season).
 *
 * No address is typed into the frontend. A vault the backend lists shows up here on its next
 * deploy, and the paste box reads any vault whether or not the backend is awake. Our own vault is
 * labelled as ours wherever it appears, backend awake or not, with the custody the ledger records:
 * it was deployed with our server key, its owner is our operating wallet, and it is not owner-held.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { apiFetch, readJson } from '../api'
import { ARC_LEDGER_KEYS, ARC_LEDGER_VAULTS } from '../arc-ledger'
import { arcChainFor } from './vault-read'

export type KnownVault = {
  /** CAIP-2. */
  network: string
  address: Address
  kind: 'ours' | 'owner-held'
  deployTx?: string
  deployedAt?: string
  /** For an owner-held vault: the owner key it was listed with. */
  owner?: string
  note?: string
}

export type KnownVaults = {
  vaults: KnownVault[]
  /** Addresses of keys the ledger names as ours (the operating wallet), per CAIP-2, lowercased. */
  ourKeys: Record<string, string[]>
  /** Set when the owner-held list could not be read; ours still shows, from the build. */
  partial: string | null
}

type ProofNetwork = {
  caip2?: string
  agent?: { owner?: string }
  contractsLinked?: { name?: string; address?: string; note?: string }[]
  artifactsLinked?: { kind?: string; label?: string; txHash?: string; date?: string }[]
  accountsLinked?: { address?: string; custody?: string }[]
}

type SeasonReport = {
  network?: string
  milestone1?: { vaults?: { items?: { address?: string; owner?: string; deployTx?: string; deployedAt?: string; note?: string }[] } }
}

const addr = (a: unknown): Address | null => (typeof a === 'string' && isAddress(a, { strict: false }) ? getAddress(a) : null)

async function getJson<T>(path: string, onWaking?: () => void): Promise<T | null> {
  try {
    const res = await apiFetch(path, { retries: 2, timeoutMs: 20_000, onWaking })
    if (!res.ok) return null
    return await readJson<T>(res)
  } catch {
    return null
  }
}

export async function listKnownVaults(onWaking?: () => void): Promise<KnownVaults> {
  const [proof, season] = await Promise.all([
    getJson<{ networks?: ProofNetwork[] }>('/api/proof/arc', onWaking),
    getJson<SeasonReport>('/api/arc/season', onWaking),
  ])
  // What the build knows comes first, so a backend that does not answer changes no label.
  const vaults: KnownVault[] = ARC_LEDGER_VAULTS.flatMap((v) => {
    const a = addr(v.address)
    return a ? [{ network: v.network, address: a, kind: 'ours' as const }] : []
  })
  const ourKeys: Record<string, string[]> = Object.fromEntries(Object.entries(ARC_LEDGER_KEYS).map(([net, keys]) => [net, [...keys]]))
  for (const n of proof?.networks ?? []) {
    const chain = arcChainFor(n.caip2)
    if (!chain) continue
    const keys = [n.agent?.owner, ...(n.accountsLinked ?? []).filter((a) => a.custody?.startsWith('ours')).map((a) => a.address)]
      .map(addr)
      .filter((a): a is Address => a !== null)
      .map((a) => a.toLowerCase())
    ourKeys[chain.caip2] = [...new Set([...(ourKeys[chain.caip2] ?? []), ...keys])]
    const deploy = (n.artifactsLinked ?? []).find((a) => a.kind === 'deploy' && /AgentSpendPolicy/i.test(a.label ?? ''))
    for (const c of n.contractsLinked ?? []) {
      const a = addr(c.address)
      if (!a || !c.name?.startsWith('AgentSpendPolicy')) continue
      const row: KnownVault = { network: chain.caip2, address: a, kind: 'ours', deployTx: deploy?.txHash, deployedAt: deploy?.date, note: c.note }
      const at = vaults.findIndex((x) => x.network === row.network && x.address === row.address)
      if (at >= 0) vaults[at] = row
      else vaults.push(row)
    }
  }
  const seasonChain = arcChainFor(season?.network)
  for (const v of season?.milestone1?.vaults?.items ?? []) {
    const a = addr(v.address)
    if (!a || !seasonChain) continue
    if (vaults.some((x) => x.network === seasonChain.caip2 && x.address === a)) continue
    vaults.push({ network: seasonChain.caip2, address: a, kind: 'owner-held', deployTx: v.deployTx, deployedAt: v.deployedAt, owner: v.owner, note: v.note })
  }
  const partial = season ? null : 'the owner-held vaults could not be listed (GET /api/arc/season did not answer)'
  return { vaults, ourKeys, partial }
}

/** The label every view of our own vault carries, word for word, wherever it appears. */
export const OURS_LABEL = 'Deployed with our server key, not user-owned.'
export const OURS_DETAIL =
  'Its owner is our operating wallet, a key our server holds, and this contract has no owner transfer. View only here, and not counted as an owner-held vault.'
