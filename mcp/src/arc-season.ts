/**
 * Arc Acceleration Season: progress against the success metrics, read from the logs.
 *
 * Circle judges Deliverable 2 (due 2026-10-30) on progress against each success metric
 * with current numbers, links to on-chain evidence and usage so far, with external
 * activity counted separately from our own. This module is that report, and it is
 * computed rather than written: every count comes from the two settlement logs, the
 * verify-then-pay flow log and the admitted vault list on every request, and the lists a
 * human has to curate (owner-held vaults admitted by hand, inspectable refusals, partner wallets,
 * verify-then-pay flows recorded anywhere else, and the links between wallets that a hand trace
 * found, in arc-season-links.ts) are exported here as data, and fill only when the evidence exists.
 *
 * What counts, stated once:
 *   - A check is a settled row on Arc Mainnet. On the Gateway log that is an outcome of
 *     'credited' or 'completed' (Circle holds the money, or the batch has landed); on the
 *     facilitator log it is 'settled' (a receipt with a matching Transfer log). The
 *     facilitator rows are reported under usage, labeled as such.
 *   - Milestone 1 counts verify-then-pay flows, not checks: one of our own Gateway checks
 *     that a vault payment or an inspectable refusal followed, linked by the nonce the
 *     check's settlement row is keyed by. A check with nothing linked is a paid check and
 *     not a flow. An external check is never counted in Milestone 1: it belongs to
 *     Milestone 2, so no check counts in both. The flows come from the vtp_flows log the
 *     verify-then-pay route writes (verify-then-pay/season.ts maps its rows), merged with
 *     the curated list, one flow per check nonce and per payment transaction. A row that cannot
 *     be mapped is skipped and named in logs.flows, and never hides the others. The Gateway log keeps its newest 2000 rows
 *     and vtp_flows keeps every flow, so a recorded flow whose check is older than the oldest
 *     row of a full Gateway log links by the settlement its own row recorded (the same
 *     read-back from Gateway's transfers API, written by the same server), and the report
 *     says how many did. A Gateway log that cannot be read links nothing and says so.
 *     An external team's flow follows the same linking rules against external checks and is
 *     reported under Milestone 2, never in the Milestone 1 count. A paid or reverted flow is
 *     timed by its block, which the chain gives in whole seconds, so it is compared with its check
 *     at that precision; the receipt route has already proved the block order.
 *   - A payer is internal when it is on either rail's published list of our own buyer
 *     wallets, is an address this repo commits as ours (committedOurKeys, which admission refuses
 *     an owner from too, and no env), is the owner of a vault labeled 'team', or is the agent key on
 *     a recorded flow through such a vault or through the launch-day vault, compared
 *     case-insensitively. Everything else is external.
 *   - A vault counts only when its owner key is one we never held, so the launch-day
 *     vault, owned by our operating wallet, does not. The vaults are the curated list plus the
 *     ones POST /api/arc/vaults admitted (arc-owner-vault-live.ts holds them to the same checks),
 *     one per address, the curated entry first. Each carries the freezes and withdrawals its owner's
 *     wallet signed, read from the chain (arc-vault-actions.ts). A refusal counts only when a
 *     reviewer can inspect it: a reverted vault transaction with a hash, or a DENY that
 *     stopped a payment before signing, with its audit entry. The launch-day refusal was
 *     a simulation with no hash, so it does not. The commitment is one of each kind, so the
 *     metric counts kinds shown: any number of DENYs and no revert is 1 of 2, not met.
 *   - A log that could not be read makes every number it feeds a lower limit, marked incomplete,
 *     and no note then says that nothing happened. The reason stays in the server log: what a
 *     database driver says about itself is not for a public page.
 *
 * Pure: the loaders, the internal payer lists, the curated lists and the clock are
 * injected, so the aggregation is unit-tested with rows and the route adds the real
 * loaders and nothing else.
 */
import { ADMISSION_CHAIN, ADMISSION_EVIDENCE_URL, ARC_OUR_PAYEES, collectOurAddresses, committedOurKeys, liveOurAddressSources } from './arc-owner-vault.js'
import { admittedVaultsFromStore } from './arc-owner-vault-live.js'
import { liveOwnerActions, type ActionsReadState, type ActionTx, type ActionVault, type VaultOwnerActions } from './arc-vault-actions.js'
import { getChainById, type ChainDescriptor } from './chains/index.js'
import { addressUrl, txUrl } from './chains/explorer.js'
import { PROVENANCE } from './chains/provenance.js'
import {
  GATEWAY_SETTLEMENTS_CAP,
  loadGatewaySettlementsResult,
  loadCountableVtpFlows,
  loadX402SettlementsResult,
  type GatewaySettlementRecord,
  type VtpFlowRecord,
  type VtpStoreIo,
  type X402SettlementRecord,
} from './storage.js'
import { internalPayers as gatewayInternalPayers, railStatus as gatewayRailStatus } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers, railStatus as facilitatorRailStatus } from './x402-3009/rail.js'
import { holdsNoFlow } from './verify-then-pay/context.js'
import { toSeasonFlow } from './verify-then-pay/season.js'
import {
  ARC_GAS_SUPPORT,
  ARC_LINK_TRACE,
  ARC_NOT_TEAM_PAYERS,
  ARC_OUR_SIDE_LINKS,
  ARC_WALLET_LINKS,
  type ArcLinkEvidence,
  type ArcNotTeamPayer,
  type ArcOurSideKind,
  type ArcOurSideLink,
  type ArcWalletLink,
} from './arc-season-links.js'

export {
  ARC_GAS_SUPPORT,
  ARC_LINK_TRACE,
  ARC_NOT_TEAM_PAYERS,
  ARC_OUR_SIDE_LINKS,
  ARC_WALLET_LINKS,
  type ArcLinkEvidence,
  type ArcNotTeamPayer,
  type ArcOurSideKind,
  type ArcOurSideLink,
  type ArcWalletLink,
}

export const ARC_SEASON_CHAIN = ADMISSION_CHAIN

export const ARC_SEASON_PROGRAM = {
  name: 'Arc Acceleration Season',
  deliverable2Due: '2026-10-30',
  // The two milestone dates are the targets the team set itself. The program said on 2026-11-04 that the
  // Deliverable 1 milestones are measured through its last day, and that traction can extend past it.
  milestone1Due: '2026-11-05',
  milestone2Due: '2026-11-06',
  measuredThrough: '2026-11-13',
} as const

/** The Deliverable 1 commitments as Circle revised them on 2026-10-19. */
export const ARC_SEASON_TARGETS = {
  ownerHeldVaults: 5,
  gatewayChecks: 100,
  inspectableRefusals: 2,
  externalTeamsLive: 2,
  externalChecks: 30,
  teamsActiveOnSeveralDays: 1,
  publicReferences: 1,
  /** After the program: active external wallets inside a 28-day window. */
  activeExternalWallets: 5,
  activeWindowDays: 28,
} as const

export const ARC_SEASON_EVIDENCE_URL = ADMISSION_EVIDENCE_URL

// ── the curated lists ─────────────────────────────────────────────────────────────

export type ArcPartner = {
  /** The wallet the team pays from, any case; matched case-insensitively. */
  wallet: string
  team: string
  /** True once the team has agreed to be named in public as an integration. */
  publicReference: boolean
  /** How the team agreed to be named, so the public reference row can say what the reference is. */
  namedWith?: string
}

/**
 * External teams, attributed by wallet. A team is added here only AFTER its wallet has
 * paid a check on Arc Mainnet, with the settlement row it first appeared in named in the
 * commit; an entry written before that would make externalTeamsLive count a promise. It was
 * empty on 2026-10-19, before any external wallet had paid. A team that pays from more than
 * one wallet has one entry per wallet under the same name, and every team metric counts it once.
 */
export const ARC_PARTNERS: ArcPartner[] = [
  // Named on the team's own written OK of 2026-11-03: as an integration, on this page and in the
  // Milestone 2 report. Its wallet paid risk_check on Arc Mainnet from its own Gateway balance:
  // transfer 824da778-5018-4b39-893a-7d2f5d7955f9, the row the team quoted, read back from the log.
  { wallet: '0x40BC51511ad79166FCc3506bea745A928f7E2708', team: 'Trustless Work', publicReference: true, namedWith: 'its own written OK of 2026-11-03' },
  // Named with the team's OK, confirmed by Meric on 2026-11-06, in the same scope: as an integration,
  // on this page and in the Milestone 2 report. Both wallets are the team's own and paid from their
  // own Gateway balances, 5 checks and 2 on 2026-10-19 and 2026-10-20. The first row of each is named
  // in the commit that added them.
  { wallet: '0x94a2f2f914862f99bf122b9a932ebc4ae3e555c6', team: 'Slippay', publicReference: true, namedWith: 'its OK, confirmed by our founder on 2026-11-06' },
  { wallet: '0xe75d597f414eba88bf4226a3ad8e0fae46b1edc1', team: 'Slippay', publicReference: true, namedWith: 'its OK, confirmed by our founder on 2026-11-06' },
]

/**
 * Whose wallet an owner-held vault's owner key is. 'team': a person on the A-Identity team, in
 * their own wallet. 'external': anyone else. Our server holds neither, which is what the metric
 * counts; a reviewer still needs to see which of the two each vault is. The chain cannot tell them
 * apart, so whoever admits the vault with the script says which, with --owner-kind. 'unstated': the
 * vault was admitted automatically by POST /api/arc/vaults, where nobody can say, and a reader is
 * told the owner is not identified, until someone says (labelOwners).
 */
export type ArcOwnerKind = 'team' | 'external' | 'unstated'

export type ArcOwnerHeldVault = {
  /** The AgentSpendPolicy contract. */
  address: string
  /** The owner key. It is the user's; we never held it, which is the whole metric. */
  owner: string
  ownerKind: ArcOwnerKind
  deployTx: string
  /** Decimal, when known: where a read of the vault's logs starts. Otherwise its deploy receipt says. */
  deployBlock?: string
  /** UTC day of the deployment. */
  deployedAt: string
  note: string
}

/**
 * Owner-held AgentSpendPolicy vaults on Arc Mainnet, deployed by the owner's own wallet with a
 * key A-Identity never holds, admitted by hand: mcp/scripts/arc-owner-vault-check.mjs admits a
 * vault and prints its entry, which can say whose wallet it is. A vault is listed only with its
 * deploy hash. The browser vault deployer at /app/vault/arc needs no entry here: its deploys are
 * admitted by POST /api/arc/vaults or the server's own sweep under the same checks, and
 * ArcSeasonDeps.admittedVaults reads them. An entry here for a vault already admitted that way is
 * what a person says about its owner: it wins over the stored row (labelOwners), and counts once.
 */
/** The note on a vault the server admitted with its owner not identified, which the founder later said, on saidOn, is not a team wallet. */
const externalByFounderNote = (saidOn: string) =>
  `Deploy sent by the owner's own wallet (receipt.from is owner()), its creation input is AgentSpendPolicyBytecode plus its constructor args, and its owner is none of the keys it was compared with; admitted automatically by POST /api/arc/vaults. Outside the team: on ${saidOn} the founder said that this owner is not a team wallet. The owner is not identified: nobody has said whose wallet it is.`

export const ARC_OWNER_HELD_VAULTS: ArcOwnerHeldVault[] = [
  // The three vaults POST /api/arc/vaults admitted, deployed on 2026-11-04, 11-05 and 11-06, each with the owner
  // not identified. On 2026-11-06 the founder, Meric, confirmed that none of the three owners is a team wallet, so
  // each is labeled external here. Nobody has said whose wallets they are. Every field is the admitted row's,
  // re-read from the chain the same day: the deploy receipt's sender, created address and block, and owner().
  {
    address: '0x25e461649e232ae23fF6CBA1e4Cd001F7a056B90',
    owner: '0x8cd5D3981A1fA059A92722591d25240e6F0f27A5',
    ownerKind: 'external',
    deployTx: '0xbd8d1e4ab5d14e6f65837f92becf0a492165bd007e8e9308ad177f7ab3cf9d2f',
    deployBlock: '29552025',
    deployedAt: '2026-11-04',
    note: externalByFounderNote('2026-11-06'),
  },
  {
    address: '0xa4D8052998A59017fd6816654F4C9eef62DE8182',
    owner: '0x39AEfbC8388da12907A21d9De888B288a9fa5794',
    ownerKind: 'external',
    deployTx: '0xeedb9cf539988596b145b8f467c15fe489f8f2b6f5ef5b8488bcd991e7a42e7b',
    deployBlock: '29681265',
    deployedAt: '2026-11-05',
    note: externalByFounderNote('2026-11-06'),
  },
  {
    address: '0x033FdeECD2f60d2A0Cb78794c4Cd1F191A9DEbE5',
    owner: '0xeD701bA695FBBaa7f0CD1D4cBe540E86F55C677b',
    ownerKind: 'external',
    deployTx: '0xd7ea1ee90de141eb89ac6c10b16d8066fb54d66088550dc9794569d83a5ae7fe',
    deployBlock: '29751356',
    deployedAt: '2026-11-06',
    note: externalByFounderNote('2026-11-06'),
  },
  // Vault 0xcB7e...Ed41, deployed on 2026-11-07 and admitted by POST /api/arc/vaults with the owner not identified. On
  // 2026-11-10 the founder said that its owner and agent key are not team wallets, and that neither he nor his cofounder
  // knows whose they are, so it is labeled external here. Every field is the admitted row's as the trace of 2026-11-08
  // recorded it, and the deploy is the first linked group's evidence in arc-season-links.ts.
  {
    address: '0xcB7e3b8b323B897E7E4303245dc98DE130B2Ed41',
    owner: '0x56755b84a0825d82f9be97C8Ab057cCDC3Dc1a43',
    ownerKind: 'external',
    deployTx: '0x6725e2e3e1f1066e774bd35d6dee10627f12e0416d18ea96f55f4ffc9c354c47',
    deployBlock: '30080119',
    deployedAt: '2026-11-07',
    note: externalByFounderNote('2026-11-10'),
  },
]

/**
 * Where the server's own vault sweep (arc-vault-sweep.ts) starts after a restart, on Arc Mainnet: just
 * before block 28991766, the first at or after 2026-11-01T13:05Z, when /app/vault/arc was first
 * committed. No owner could deploy from the page before it, and a vault only appears to the sweep once
 * its end date is set, which is later still. Older than this it would only cost reads for nothing.
 */
export const ARC_VAULT_SWEEP_START_BLOCK = 28_990_000

export type ArcRefusalKind = 'vault-policy-on-chain' | 'deny-before-signing'

export type ArcRefusal = {
  kind: ArcRefusalKind
  /** The reverted vault transaction. Required for a vault-policy refusal; absent for a
   *  DENY that stopped the payment before anything was signed, because there is none. */
  txHash?: string
  /** Where the refusal can be inspected when it has no transaction: the audit entry. */
  evidenceUrl?: string
  /** UTC timestamp of the refusal. */
  at: string
  note: string
  /** Why the payment that was refused was to a wallet of ours, when it was. */
  payeeInternal?: string
}

// Our own agents. Admission refuses an owner from this list too, so it lives in arc-owner-vault.ts.
export { ARC_OUR_PAYEES }

/**
 * The day the trust verdict's rule changed: from then on, a payee we know nothing about gets WARN
 * and DENY means we hold evidence against the payee. Recorded DENYs stay as recorded.
 */
const RISK_RULE_CHANGED_ON = '2026-11-04'

/**
 * Refusals anyone can inspect. One of each kind is the Milestone 1 commitment: a
 * vault-policy refusal that reverted on chain (so it has a hash), and a DENY verdict
 * that stopped a payment before signing (so it has an audit entry and no hash). The
 * launch-day refusal was a simulation and is not here, see the note in the report. The
 * first on-chain refusal was mined on 2026-11-01 by mcp/scripts/arc-vault-refusal.mjs.
 */
export const ARC_REFUSALS: ArcRefusal[] = [
  {
    kind: 'vault-policy-on-chain',
    txHash: '0x134de0b2e18b516d2fb3eda456201d741a089d79dcdc827d77b83e60afd6cb72',
    at: '2026-11-01T12:54:40Z',
    note: 'A 0.5 USDC pay() on the launch-day vault, above its 0.25 USDC autoApproveMax, sent by its operator key (ours) to its owner (our operating wallet) with an explicit gas limit so that it would be mined. It reverted with AboveAutoApprove in block 28990543 (31079 gas, 0.00065 USDC); nothing moved.',
  },
]

export type ArcFlowOutcome = 'paid' | 'refused'

export type ArcVerifyThenPayFlow = {
  /** The Gateway check that opened the flow, by the EIP-3009 nonce its settlement row is
   *  keyed by (authNonce). It counts only when that row is one of our own settled Gateway
   *  checks on Arc Mainnet, so a nonce that names no such row counts nothing. */
  checkNonce: string
  /** The address that was checked and then paid or refused. The check's agentId and the
   *  vault payee are this one address, so a reviewer can match the verdict to the Paid
   *  event; a Gateway row does not record what was checked. */
  payee: string
  outcome: ArcFlowOutcome
  /** The vault's Paid transaction for a payment, or the reverted pay() for an on-chain
   *  refusal. Required for a payment. */
  txHash?: string
  /** Where a DENY that stopped the payment before signing can be inspected: its public
   *  audit entry or flow record. Only for a refusal with no transaction. */
  evidenceUrl?: string
  /** The wallet that paid for the check, when the flow names it. EIP-3009 nonces are unique
   *  per payer, not globally, so a flow that names its payer links only to that payer's
   *  check. */
  payer?: string
  /** The check's settlement as the flow's own record holds it (recorded flows only). Read
   *  only when the check's row can have aged out of the retained Gateway log: the log is full
   *  and the check is older than its oldest row. */
  check?: { network: string; payer: string; outcome: string; ts: string }
  /** The vault's two keys as the flow's own record holds them (recorded flows only). A flow
   *  whose payee is one of them is labeled in the report: it is a real settled check, and it is
   *  not a payment to anyone else. */
  vaultKeys?: { owner: string; operator: string }
  /** The vault the flow ran through, as the flow's own record holds it (recorded flows only). */
  vault?: string
  /** The flow's public record: the check, the verdict and the vault (recorded flows only). */
  recordUrl?: string
  /** UTC timestamp of the outcome. */
  at: string
  note: string
}

/**
 * Verify-then-pay flows on Arc Mainnet recorded anywhere other than the vtp_flows log: a
 * Gateway check followed by the vault payment or the refusal it led to. The route
 * POST /api/x402/gateway/verify-then-pay records its own flows and the report reads them
 * through ArcSeasonDeps.flowRows; an entry here is for a flow that ran some other way. A
 * flow is added only after its outcome was read back from the chain (the Paid or reverted
 * receipt, paying the payee that was checked) or published (the DENY's public record), with
 * the check's settlement nonce. Empty on 2026-11-01: no settled check is linked to a vault
 * payment or a refusal yet. The two launch-day vault payments went to our own operating
 * wallet and are not linked to any check.
 */
export const ARC_VERIFY_THEN_PAY_FLOWS: ArcVerifyThenPayFlow[] = []

// ── the report ────────────────────────────────────────────────────────────────────

export type ArcSeasonRailTotals = { checks: number; usd: number }

/** What is known of whose an external wallet is: named by a partner entry, said by the founder not to be the team's, or neither. */
export type ArcSeasonWalletIdentity = 'team' | 'not-team' | 'not-identified'

export type ArcSeasonWallet = {
  wallet: string
  /** The partner team, when the wallet is attributed to one. */
  team?: string
  identity: ArcSeasonWalletIdentity
  /** When identity is 'not-team': the UTC day the founder said so. */
  notTeamSaidOn?: string
  /** The other paying wallets a link or a shared team ties to this one. Absent when none does. */
  linkedWith?: string[]
  checks: number
  usd: number
  firstTs: string
  lastTs: string
  /** Distinct UTC days with at least one settled check, ascending. */
  activeDays: string[]
}

export type ArcSeasonUsageSide = {
  checks: number
  usd: number
  /** Distinct payer wallets, lowercased, ascending. */
  wallets: string[]
  /** Distinct UTC days with at least one settled check, ascending. */
  activeDays: string[]
  byRail: { gateway: ArcSeasonRailTotals; facilitator: ArcSeasonRailTotals }
}

/** A flow row the report could not map. flowId is null when the row does not carry one. */
export type ArcSeasonSkippedRow = { flowId: string | null; reason: string }
export type ArcSeasonLogRead = { readable: boolean; rows: number; reason?: string; skipped?: ArcSeasonSkippedRow[] }

/** One transaction or public record behind a link, with the link a reader opens. */
export type ArcSeasonLinkEvidence = ArcLinkEvidence & { explorerUrl: string | null }

/** A curated link as the report shows it: only the linked wallets that own a counted vault, and those vaults. */
export type ArcSeasonOwnerLinkItem = {
  /** The linked wallets that own a counted vault, as the counted vaults spell them. Two or more. */
  owners: string[]
  /** The counted vaults those owners deployed. */
  vaults: string[]
  /** The UTC day the founder said those owners belong to one person, when his word covers all of them. */
  onePersonOn?: string
  tracedOn: string
  confidence: string
  note: string
  evidence: ArcSeasonLinkEvidence[]
}
/** Who stands behind the vault count, as far as the chain and the curated links say. */
export type ArcSeasonVaultOwners = {
  /** Distinct owner wallets behind the counted vaults. */
  distinct: number
  /** At most this many parties stand behind those wallets: the chain can merge wallets but cannot prove that two are different people.
   *  null when the list of admitted vaults could not be read, because a ceiling from a short list would be a guess. */
  parties: number | null
  /** Owner wallets a curated link ties to each other, among the counted vaults' owners. */
  linked: ArcSeasonOwnerLinkItem[]
  /** A party behind a counted vault that also paid external checks. Those count under Milestone 2, never here. */
  alsoPaid: { vaults: string[]; wallets: string[]; checks: number; note: string }[]
  /** "6 vaults from 6 owner wallets; two of the owner wallets are linked on chain, and the founder said on 2026-11-10 that they belong to one person: at most 5 parties." */
  summary: string
}

/** A curated link among external wallets that paid checks. */
export type ArcSeasonPayerLinkItem = {
  /** The linked wallets that paid, lowercased as byWallet spells them. Two or more. */
  wallets: string[]
  checks: number
  /** Set when every one of them is attributed to one partner team. */
  team?: string
  /** The UTC day the founder said those wallets belong to one person, when his word covers all of them. */
  onePersonOn?: string
  tracedOn: string
  confidence: string
  note: string
  evidence: ArcSeasonLinkEvidence[]
}
/** Who stands behind the external checks, as far as the links and the attributions say. */
export type ArcSeasonPayers = {
  /** Distinct external wallets that paid. */
  wallets: number
  /** At most this many parties stand behind those wallets. A ceiling, as for vault owners, and null when a settlement log could
   *  not be read, because then more wallets may have paid. */
  parties: number | null
  linked: ArcSeasonPayerLinkItem[]
  /** By what anyone has said of whose wallets they are. */
  whoPaid: Record<ArcSeasonWalletIdentity, { wallets: number; checks: number }>
  /** "33 checks from 8 wallets, at most 6 parties: two wallets linked on chain paid 20, and Slippay's two wallets paid 7." */
  summary: string
}
export type ArcSeasonLinkGroup = Omit<ArcWalletLink, 'evidence'> & { evidence: ArcSeasonLinkEvidence[] }
export type ArcSeasonOurSideItem = Omit<ArcOurSideLink, 'evidence'> & { evidence: ArcSeasonLinkEvidence[] }
/** The whole hand trace behind the links, in the open: every group it found outside a named team's own wallets, every link to
 *  our own side, and how far it goes. */
export type ArcSeasonLinkedWallets = {
  tracedOn: string
  /** What was read and when. Said by hand: nothing here is read on a request. */
  reads: string
  groups: ArcSeasonLinkGroup[]
  /** What the trace found between what is counted and our own side, labeled as ours or disclosed. */
  ourSide: ArcSeasonOurSideItem[]
  /** What the trace cannot say. */
  limits: readonly string[]
}

/** A row the admitted vault list could not count. vault is null when the row names none. */
export type ArcSeasonSkippedVault = { vault: string | null; reason: string }
export type ArcSeasonVaultsRead = { readable: boolean; rows: number; reason?: string; skipped?: ArcSeasonSkippedVault[] }
export type ArcSeasonActionTx = ActionTx & { explorerUrl: string }
/**
 * A counted vault and what its owner's wallet did to it. Each hash is a transaction whose from is
 * the owner, and `actionsRead` says how far the chain was read: an empty list means nothing was
 * found so far only when its state is 'complete'.
 */
export type ArcSeasonVaultItem = ArcOwnerHeldVault & {
  explorerUrl: string
  deployExplorerUrl: string
  freezeTxs: ArcSeasonActionTx[]
  withdrawTxs: ArcSeasonActionTx[]
  actionsRead: ActionsReadState
}
export type ArcSeasonRefusalItem = ArcRefusal & { explorerUrl: string | null }
/** Which vault a flow ran through, in a reader's terms. 'launch-day': the vault our own server keys
 *  own and operate. 'owner-held': one of the vaults counted in the row above it. */
export type ArcFlowVaultKind = 'launch-day' | 'owner-held' | 'other' | 'not-recorded'
/** A flow's check as it stands now. From 'gateway-log' it is the check's row on this read, and the
 *  batch hash appears once Gateway reports it. From 'flow-record' the row has aged out of the log,
 *  so it is what the flow's record held when the check settled. */
export type ArcSeasonFlowCheck = { outcome: string; readFrom: 'gateway-log' | 'flow-record'; batchTx?: string; batchExplorerUrl?: string }
/** What ties an external flow's payee to the wallet that paid for its check: both are keys of the flow's vault, or a curated link holds both. */
export type ArcPayeeTie = 'vault-keys' | 'link'
export type ArcSeasonFlowItem = Omit<ArcVerifyThenPayFlow, 'check'> & {
  explorerUrl: string | null
  vaultKind: ArcFlowVaultKind
  checkSettlement: ArcSeasonFlowCheck
  payeeInternal?: string
  /** On an external flow: the payee is tied to the wallet that paid for the check. Set only when the two are both keys of the
   *  flow's vault, or a curated link holds both. A payee that is only the vault's own key is not tied to a payer outside the
   *  vault, because anyone can buy a check that names any vault. */
  payeeTiedToPayer?: true
  /** What ties them, when payeeTiedToPayer is set: 'vault-keys' when the payer and the payee are each the vault's owner or
   *  operator, and 'link' when a curated link holds both. Only the two together make the flow one party paying itself. Either
   *  alone says they may be one party: a vault's owner can name anyone's wallet as its operator, and a link can be of medium
   *  strength. */
  payeeTiedBy?: ArcPayeeTie[]
}
/** One UTC week, Monday to Sunday, of external use. A week with no check is listed too, so a gap shows. */
export type ArcSeasonWeek = {
  weekStart: string
  weekEnd: string
  /** The week has not ended at the time of this read. */
  inProgress: boolean
  checks: number
  /** Distinct external wallets with a settled check this week, ascending. */
  activeWallets: string[]
  /** Distinct UTC days with at least one settled external check this week, ascending. */
  activeDays: string[]
  /** Of activeWallets, the ones that had also paid in an earlier week. */
  returningWallets: string[]
}
export type ArcSeasonTeam = ArcSeasonWallet & { team: string; publicReference: boolean }

export type ArcSeasonReport = {
  asOf: string
  chain: string
  /** CAIP-2 id of Arc Mainnet, from the registry. */
  network: string
  program: typeof ARC_SEASON_PROGRAM
  /** Whether each log could be read. A log that could not be read contributes nothing,
   *  and says so here rather than reading as zero demand. `flows` is the verify-then-pay
   *  flow log, present whenever a loader for it is wired (the live route always wires one). */
  logs: { gateway: ArcSeasonLogRead; facilitator: ArcSeasonLogRead; flows?: ArcSeasonLogRead; admittedVaults?: ArcSeasonVaultsRead }
  usage: {
    basis: string
    internal: ArcSeasonUsageSide
    external: ArcSeasonUsageSide & {
      byWallet: ArcSeasonWallet[]
      /** Set when the flow log could not be read: the agent key of a vault labeled team, and a key the launch-day vault rotated
       *  to, are known from that log, so one could be counted as external. The number is then an upper limit, the opposite of
       *  incomplete. Every number that reads external checks carries this. */
      mayIncludeTeamKeys?: true
    }
  }
  milestone1: {
    title: string
    due: string
    vaults: {
      count: number
      target: number
      /** Set when the list of admitted vaults could not be read: count is then a lower limit. */
      incomplete?: true
      items: ArcSeasonVaultItem[]
      /** Whose wallet each counted vault is, as far as anyone can say. */
      byKind: Record<ArcOwnerKind, number>
      /** The hashes of what owners signed, summed over the items, and how many vaults are not fully read. */
      ownerActions: { freezes: number; withdrawals: number; vaultsNotFullyRead: number }
      /** How many owner wallets stand behind the count, and which of them the chain links. The count itself does not move. */
      owners: ArcSeasonVaultOwners
      note: string
    }
    checks: {
      /** Verify-then-pay flows: our own Gateway checks with a vault payment or a refusal linked. */
      count: number
      target: number
      /** Set when the Gateway log or the flow log could not be read: count is then a lower limit. */
      incomplete?: true
      /** Our own Gateway checks settled on Arc Mainnet, linked or not. */
      internal: number
      /** External Gateway checks. Counted under Milestone 2, never in count. */
      external: number
      /** external, and so internal the other way, could be off by an agent key of a vault labeled team (usage.external). */
      externalMayIncludeTeamKeys?: true
      linked: Record<ArcFlowOutcome, number>
      /** Our own Gateway checks in the retained log with nothing linked: paid checks, not flows.
       *  null when the Gateway log or the flow log could not be read, because then nobody can say. */
      unlinked: number | null
      /** Of count, flows linked by the settlement their own flow record holds, because their
       *  check's Gateway row aged out of the retained log. */
      agedOut: number
      /** Of count, flows whose payee is one of our own wallets or the vault's own key. Each is
       *  labeled on its item. Planned probes count as flows, and are not third-party payments. */
      internalPayee: number
      /** How many different payees the refused flows name, next to linked.refused. */
      refusedPayees: number
      /** Of count, how many ran through which vault. */
      byVault: Record<ArcFlowVaultKind, number>
      items: ArcSeasonFlowItem[]
      rail: string
      note: string
    }
    refusals: {
      /** Kinds of refusal shown, 0 to 2. How many of each is in byKind. */
      count: number
      target: number
      /** Set when the flow log could not be read: count is then a lower limit. */
      incomplete?: true
      items: ArcSeasonRefusalItem[]
      byKind: Record<ArcRefusalKind, number>
      note: string
    }
    evidence: string
  }
  milestone2: {
    title: string
    due: string
    externalTeamsLive: { count: number; target: number; incomplete?: true; teams: ArcSeasonTeam[]; note: string }
    externalChecks: { count: number; target: number; incomplete?: true; mayIncludeTeamKeys?: true; payers: ArcSeasonPayers; note: string }
    teamActiveOnSeveralDays: {
      count: number
      target: number
      incomplete?: true
      teams: string[]
      /** Each live team's dates across all its wallets, so a reader can judge the span. */
      byTeam: { team: string; activeDays: string[]; firstTs: string; lastTs: string }[]
      note: string
    }
    publicReference: { count: number; target: number; incomplete?: true; names: string[]; note: string }
    /** An external team's own verify-then-pay flows: its check, then its vault's payment or a
     *  refusal. They are not in Milestone 1 and they have no target; they are the strongest thing
     *  an outside team can show, so they are listed. */
    externalFlows: { count: number; linked: Record<ArcFlowOutcome, number>; items: ArcSeasonFlowItem[]; incomplete?: true; note: string }
    /** External wallets that paid but are attributed to no team. Reported, never folded. */
    unattributed: { wallets: number; checks: number; mayIncludeTeamKeys?: true; note: string }
  }
  afterProgram: {
    activeExternalWallets: {
      count: number
      target: number
      incomplete?: true
      mayIncludeTeamKeys?: true
      windowDays: number
      since: string
      wallets: string[]
      /** At most this many parties stand behind those wallets: a team or a linked party with two wallets counts twice in count.
       *  null when a settlement log could not be read. */
      parties: number | null
      /** Which of those wallets are linked, in one sentence. */
      linkedSummary: string
    }
    /** External use per UTC week, Monday first, from the first external check to this read. */
    weekly: {
      incomplete?: true
      mayIncludeTeamKeys?: true
      weeks: ArcSeasonWeek[]
      /** External wallets that paid in two or more different weeks, ascending. */
      repeatWallets: string[]
      /** Teams whose wallets, taken together, paid in two or more different weeks. */
      repeatTeams: string[]
      note: string
    }
    note: string
  }
  /** The curated hand trace behind every link above, and how far it goes. */
  linkedWallets: ArcSeasonLinkedWallets
  note: string
}

export type ArcSeasonDeps = {
  /** May throw: an unreadable Gateway log is reported as unreadable, not as empty. */
  gatewayRows: () => Promise<GatewaySettlementRecord[]>
  /** How many rows the Gateway log keeps. Default GATEWAY_SETTLEMENTS_CAP. */
  gatewayCap?: number
  /** May throw: an unreadable facilitator log is reported as unreadable, not as empty. */
  facilitatorRows: () => Promise<X402SettlementRecord[]>
  /** Our own buyer wallets, as each rail publishes them. Any case. */
  internalPayers: { gateway: string[]; facilitator: string[] }
  /** Every other address the repo itself commits as ours, read with no env (committedOurKeys). Any case. */
  committedOurs?: string[]
  /** The wallets our rails are paid to. A payment to one is a payment to ourselves. */
  ourPayTo?: string[]
  /** Our own agents and other payees that are ours. Default ARC_OUR_PAYEES. */
  ourPayees?: { address: string; why: string }[]
  now?: () => number
  partners?: ArcPartner[]
  /** The curated vaults. Default ARC_OWNER_HELD_VAULTS. */
  vaults?: ArcOwnerHeldVault[]
  /** The curated links between wallets. Default ARC_WALLET_LINKS. */
  walletLinks?: ArcWalletLink[]
  /** External payers the founder said are not team wallets, each with the day he said it. Default ARC_NOT_TEAM_PAYERS. Any case. */
  notTeamPayers?: ArcNotTeamPayer[]
  /** The curated links to our own side. Default ARC_OUR_SIDE_LINKS. */
  ourSideLinks?: ArcOurSideLink[]
  /** Vaults POST /api/arc/vaults admitted. May throw: an unreadable list is reported in
   *  logs.admittedVaults, and the count is then the curated list alone and says so. A row it
   *  cannot count goes to onSkip and on into logs.admittedVaults. */
  admittedVaults?: (onSkip?: (row: ArcSeasonSkippedVault) => void) => Promise<ArcOwnerHeldVault[]>
  /** What each counted vault's owner did, by lowercase address. May throw: every vault then says
   *  its actions could not be read. A vault it has no answer for says the same. */
  ownerActions?: (vaults: readonly ActionVault[]) => Promise<Map<string, VaultOwnerActions>>
  refusals?: ArcRefusal[]
  /** The curated flows. Default ARC_VERIFY_THEN_PAY_FLOWS. */
  flows?: ArcVerifyThenPayFlow[]
  /** Flows the server recorded after its own read-back (vtp_flows), mapped by toSeasonFlow.
   *  May throw: an unreadable flow log is reported in logs.flows as unreadable, never as no
   *  flows. A single row it cannot map goes to onSkip and on into logs.flows. Merged with
   *  `flows`, one flow per check nonce, the curated entry first. onKeys is told which key ran
   *  which vault for every row, including one that maps to no flow. */
  flowRows?: (onSkip?: (row: ArcSeasonSkippedRow) => void, onKeys?: (keys: ArcFlowKeys) => void) => Promise<ArcVerifyThenPayFlow[]>
}

/**
 * Which key was a vault's operator when a flow was recorded, read from the chain by the check's free half, so it is
 * nobody's word, and which wallet paid that flow's check, when the row names it. The two can differ: anyone can deploy a
 * vault naming someone else's wallet as its operator and buy a check for it.
 */
export type ArcFlowKeys = { vault: string; operator: string; payer?: string }

// The live loaders, each through the read that tells "no rows yet" from "could not read the
// log", so an unreadable log throws and is reported as unreadable rather than counted as zero.
// Declared once at module level, so every document that takes the season report's loaders
// (settlement-networks.ts does) holds these very functions, and a test can say so.
async function liveGatewayRows(): Promise<GatewaySettlementRecord[]> {
  const read = await loadGatewaySettlementsResult()
  if (!read.ok) throw new Error(read.reason)
  return read.rows
}

async function liveFacilitatorRows(): Promise<X402SettlementRecord[]> {
  const read = await loadX402SettlementsResult()
  if (!read.ok) throw new Error(read.reason)
  return read.rows
}

/** The store is a seam only so a test can run this very loader against a real file: a recorded row's keys reach the report through it. */
export async function liveFlowRows(onSkip?: (row: ArcSeasonSkippedRow) => void, onKeys?: (keys: ArcFlowKeys) => void, io: VtpStoreIo = {}): Promise<ArcVerifyThenPayFlow[]> {
  const read = await loadCountableVtpFlows(io)
  if (!read.ok) throw new Error(read.reason)
  for (const keys of flowKeysFromRows(read.rows)) onKeys?.(keys)
  return seasonFlowsFromRows(read.rows, onSkip)
}

/**
 * Who ran each vault, from every row that holds a flow. Not only the rows that map to a season flow: a WARN
 * still waiting for its owner is a paid check too, and the key that paid it is on that row. A row an old key
 * wrote keeps naming it after a setOperator, which is why this reads rows and not the vault as it is now.
 */
export function flowKeysFromRows(rows: VtpFlowRecord[]): ArcFlowKeys[] {
  return rows.flatMap((row) =>
    row && !holdsNoFlow(row) && typeof row.vault === 'string' && typeof row.operator === 'string'
      ? [{ vault: row.vault, operator: row.operator, ...(typeof row.check?.payer === 'string' ? { payer: row.check.payer } : {}) }]
      : [],
  )
}

/** Flow rows as season flows, one row at a time: a row that cannot be mapped is passed to onSkip,
 *  and the rest still count. */
export function seasonFlowsFromRows(rows: VtpFlowRecord[], onSkip?: (row: ArcSeasonSkippedRow) => void): ArcVerifyThenPayFlow[] {
  return rows.flatMap((row) => {
    try {
      return toSeasonFlow(row)
    } catch (e) {
      const flowId = (row as { flowId?: unknown } | null)?.flowId
      onSkip?.({ flowId: typeof flowId === 'string' ? flowId : null, reason: e instanceof Error ? e.message : String(e) })
      return []
    }
  })
}

/** The real loaders and the rails' own internal-payer lists. The route adds nothing else. */
export function liveArcSeasonDeps(env: NodeJS.ProcessEnv = process.env): ArcSeasonDeps {
  return {
    gatewayRows: liveGatewayRows,
    facilitatorRows: liveFacilitatorRows,
    flowRows: liveFlowRows,
    admittedVaults: (onSkip) => admittedVaultsFromStore(collectOurAddresses(liveOurAddressSources(env)), onSkip),
    ownerActions: liveOwnerActions(env),
    internalPayers: { gateway: gatewayInternalPayers(env), facilitator: facilitatorInternalPayers(env) },
    committedOurs: committedOurKeys(),
    ourPayTo: [gatewayRailStatus(env, arcMainnet().caip2).payTo, facilitatorRailStatus(env, arcMainnet().caip2).payTo].filter((a): a is string => Boolean(a)),
  }
}

/** Curated flows first, then recorded ones, one per check nonce whatever its case. */
export function mergeFlows(curated: ArcVerifyThenPayFlow[], recorded: ArcVerifyThenPayFlow[]): ArcVerifyThenPayFlow[] {
  const seen = new Set<string>()
  const out: ArcVerifyThenPayFlow[] = []
  for (const f of [...curated, ...recorded]) {
    const key = f.checkNonce.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Curated vaults first, then admitted ones, one per address whatever its case. */
export function mergeVaults(curated: ArcOwnerHeldVault[], admitted: ArcOwnerHeldVault[]): ArcOwnerHeldVault[] {
  const seen = new Set<string>()
  const out: ArcOwnerHeldVault[] = []
  for (const v of [...curated, ...admitted]) {
    const key = v.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

const PARTNER_OWNER_NOTE = 'Passed every owner-held check and admitted automatically. The chain cannot say whose wallet an owner is; this one is on our list of wallets attributed to external teams.'

/**
 * What is known of whose wallet each vault's owner is. A stored row says 'unstated', because the chain cannot tell. A
 * curated entry for the same vault says what a person said. A wallet on the partner list is one someone has said is
 * outside the team, and an owner cannot be planted: admission requires that wallet to have sent the deploy. Nothing else
 * moves a label, so both the report and GET /api/arc/vaults read a vault's owner the same way.
 */
export function labelOwners(vaults: ArcOwnerHeldVault[], curated: ArcOwnerHeldVault[] = ARC_OWNER_HELD_VAULTS, partners: ArcPartner[] = ARC_PARTNERS): ArcOwnerHeldVault[] {
  const entries = new Map(curated.map((c) => [c.address.toLowerCase(), c]))
  const partnerWallets = new Set(partners.map((p) => p.wallet.toLowerCase()))
  return vaults.map((v) => {
    const entry = entries.get(v.address.toLowerCase())
    if (entry) return { ...v, ownerKind: entry.ownerKind, note: entry.note }
    return v.ownerKind === 'unstated' && partnerWallets.has(v.owner.toLowerCase()) ? { ...v, ownerKind: 'external' as const, note: PARTNER_OWNER_NOTE } : v
  })
}

const GATEWAY_SETTLED = new Set<GatewaySettlementRecord['outcome']>(['credited', 'completed'])

type Check = { rail: 'gateway' | 'facilitator'; payer: string; usd: number; ts: string; nonce: string; outcome?: string; batchTx?: string }

const usd6 = (n: number) => Number(n.toFixed(6))

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** What a reviewer opens to inspect a flow's outcome, or null when the flow names nothing
 *  and so cannot count: a payment needs its Paid transaction, a refusal its reverted
 *  transaction or a public audit entry. */
function flowEvidence(f: ArcVerifyThenPayFlow): string | null {
  if (f.txHash && TX_HASH.test(f.txHash)) return f.txHash
  if (f.outcome === 'refused' && f.evidenceUrl?.startsWith('https://')) return f.evidenceUrl
  return null
}

/** The UTC day of an ISO timestamp, or null when the timestamp does not parse. */
function utcDay(ts: string): string | null {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort()

/**
 * Whether a flow's outcome came after its check. A flow named by a transaction is timed by its
 * block, whose timestamp is whole seconds, while the check's settlement time has milliseconds: a
 * check at 10:00:05.050 and a payment mined at 10:00:05.950 read as 05.050 and 05.000. So that
 * comparison is made at the block's precision. It lets nothing through that the chain did not
 * order: the receipt route has already required the block to come after the verdict's.
 */
function outcomeFollowsCheck(f: ArcVerifyThenPayFlow, checkTs: string): boolean {
  const outcomeAt = Date.parse(f.at)
  const checkedAt = Date.parse(checkTs)
  if (!Number.isFinite(outcomeAt) || !Number.isFinite(checkedAt)) return false
  return outcomeAt >= (f.txHash ? Math.floor(checkedAt / 1000) * 1000 : checkedAt)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The Monday of a UTC day's week, both YYYY-MM-DD. */
function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`)
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10)
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** External use by UTC week, from the first check's week to this read's, with empty weeks kept. */
function weeklyUsage(checks: Check[], nowMs: number, teamOf: Map<string, string>): { weeks: ArcSeasonWeek[]; repeatWallets: string[]; repeatTeams: string[] } {
  const dated = checks.flatMap((c) => {
    const day = utcDay(c.ts)
    return day ? [{ payer: c.payer, day, week: mondayOf(day) }] : []
  })
  if (dated.length === 0) return { weeks: [], repeatWallets: [], repeatTeams: [] }
  const thisWeek = mondayOf(new Date(nowMs).toISOString().slice(0, 10))
  const named = sortedUnique(dated.map((d) => d.week))
  const last = named[named.length - 1] > thisWeek ? named[named.length - 1] : thisWeek
  const weeks: ArcSeasonWeek[] = []
  const seen = new Set<string>()
  for (let w = named[0]; w <= last; w = addDays(w, 7)) {
    const own = dated.filter((d) => d.week === w)
    const activeWallets = sortedUnique(own.map((d) => d.payer))
    const weekEnd = addDays(w, 6)
    weeks.push({
      weekStart: w,
      weekEnd,
      inProgress: nowMs < Date.parse(`${weekEnd}T23:59:59.999Z`),
      checks: own.length,
      activeWallets,
      activeDays: sortedUnique(own.map((d) => d.day)),
      returningWallets: activeWallets.filter((a) => seen.has(a)),
    })
    for (const a of activeWallets) seen.add(a)
  }
  const inWeeks = (key: (payer: string) => string | undefined) => {
    const out = new Map<string, Set<string>>()
    for (const d of dated) {
      const k = key(d.payer)
      if (k) out.set(k, (out.get(k) ?? new Set()).add(d.week))
    }
    return sortedUnique([...out].filter(([, ws]) => ws.size >= 2).map(([k]) => k))
  }
  return { weeks, repeatWallets: inWeeks((a) => a), repeatTeams: inWeeks((a) => teamOf.get(a)) }
}

/** Hours from one timestamp to another, to one decimal: what two calendar dates can hide. */
function hoursApart(first: string, last: string): number | null {
  const a = Date.parse(first)
  const b = Date.parse(last)
  return Number.isFinite(a) && Number.isFinite(b) ? Number(((b - a) / 3_600_000).toFixed(1)) : null
}

/** "2026-10-19 and 2026-10-20, 16.2 hours from the first check to the last". */
function datesPlainly(days: string[], first: string, last: string): string {
  const hours = hoursApart(first, last)
  return `${days.join(days.length === 2 ? ' and ' : ', ')}${hours === null ? '' : `, ${hours} hours from the first check to the last`}`
}

/** What a public report says of a log it could not read. The reason goes to the server's log. */
const LOG_UNREADABLE = 'the log did not answer on this request'

function arcMainnet(): ChainDescriptor {
  const chain = getChainById(ARC_SEASON_CHAIN)
  if (!chain) throw new Error(`the registry no longer has ${ARC_SEASON_CHAIN}; the season report reads its network from there`)
  return chain
}

function side(checks: Check[]): ArcSeasonUsageSide {
  const rail = (name: Check['rail']): ArcSeasonRailTotals => {
    const own = checks.filter((c) => c.rail === name)
    return { checks: own.length, usd: usd6(own.reduce((s, c) => s + c.usd, 0)) }
  }
  return {
    checks: checks.length,
    usd: usd6(checks.reduce((s, c) => s + c.usd, 0)),
    wallets: sortedUnique(checks.map((c) => c.payer)),
    activeDays: sortedUnique(checks.map((c) => utcDay(c.ts)).filter((d): d is string => d !== null)),
    byRail: { gateway: rail('gateway'), facilitator: rail('facilitator') },
  }
}

/** notTeam: the day the founder said each wallet is not a team wallet, by lowercase address. */
function byWallet(checks: Check[], teamOf: Map<string, string>, notTeam: ReadonlyMap<string, string>, linkGroups: readonly (readonly string[])[]): ArcSeasonWallet[] {
  const groups = new Map<string, Check[]>()
  for (const c of checks) {
    const g = groups.get(c.payer) ?? []
    g.push(c)
    groups.set(c.payer, g)
  }
  const partyOf = new Map(partiesAmong(groups.keys(), linkGroups).flatMap((party) => party.map((w) => [w, party] as const)))
  const rows: ArcSeasonWallet[] = []
  for (const [wallet, own] of groups) {
    // Ordered in time, not as strings: a timestamp with a zone offset sorts wrongly as text.
    const times = own
      .map((c) => c.ts)
      .filter((t) => Number.isFinite(Date.parse(t)))
      .sort((x, y) => Date.parse(x) - Date.parse(y))
    const team = teamOf.get(wallet)
    const notTeamSaidOn = team ? undefined : notTeam.get(wallet)
    const linkedWith = (partyOf.get(wallet) ?? []).filter((w) => w !== wallet)
    rows.push({
      wallet,
      ...(team ? { team } : {}),
      identity: team ? 'team' : notTeamSaidOn ? 'not-team' : 'not-identified',
      ...(notTeamSaidOn ? { notTeamSaidOn } : {}),
      ...(linkedWith.length ? { linkedWith } : {}),
      checks: own.length,
      usd: usd6(own.reduce((s, c) => s + c.usd, 0)),
      firstTs: times[0] ?? own[0].ts,
      lastTs: times[times.length - 1] ?? own[own.length - 1].ts,
      activeDays: sortedUnique(own.map((c) => utcDay(c.ts)).filter((d): d is string => d !== null)),
    })
  }
  // Most checks first; ties by who paid first, so the order is stable between reads.
  return rows.sort((a, b) => b.checks - a.checks || a.firstTs.localeCompare(b.firstTs) || a.wallet.localeCompare(b.wallet))
}

/** The launch-day vault, named from the provenance ledger so its address is not restated. */
function launchDayVault(): string | null {
  const arc = PROVENANCE.find((p) => p.chain === ARC_SEASON_CHAIN)
  const vault = arc?.contracts.find((c) => c.name.startsWith('AgentSpendPolicy'))
  return vault?.address ?? null
}

async function readLog<T>(what: string, load: () => Promise<T[]>): Promise<{ rows: T[]; read: ArcSeasonLogRead }> {
  try {
    const rows = await load()
    return { rows, read: { readable: true, rows: rows.length } }
  } catch (e) {
    console.error(`[arc-season] the ${what} could not be read:`, e instanceof Error ? e.message : String(e))
    return { rows: [], read: { readable: false, rows: 0, reason: LOG_UNREADABLE } }
  }
}

/** Each vault with its owner's actions, or with a plain statement of why they are not known. */
async function vaultItemsWithActions(vaults: ArcOwnerHeldVault[], chain: ChainDescriptor, read: ArcSeasonDeps['ownerActions']): Promise<ArcSeasonVaultItem[]> {
  let known = new Map<string, VaultOwnerActions>()
  let failed: string | null = read ? null : 'the owner actions were not read on this request'
  if (read && vaults.length > 0) {
    try {
      known = await read(vaults)
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    }
  }
  const linked = (txs: ActionTx[]): ArcSeasonActionTx[] => txs.map((t) => ({ ...t, explorerUrl: txUrl(chain, t.txHash) }))
  return vaults.map((v) => {
    const actions = known.get(v.address.toLowerCase())
    return {
      ...v,
      explorerUrl: addressUrl(chain, v.address),
      deployExplorerUrl: txUrl(chain, v.deployTx),
      freezeTxs: linked(actions?.freezeTxs ?? []),
      withdrawTxs: linked(actions?.withdrawTxs ?? []),
      actionsRead: actions?.read ?? { state: 'unreadable', scannedToBlock: null, reason: failed ?? 'the owner actions were not read on this request' },
    }
  })
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n)
const withUnit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
/** An address the way the curated notes write it. */
const shortAddress = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

/** A link's transactions with the link a reader opens: an explorer link derived from the registry, or the record's own URL. */
function linkEvidence(rows: readonly ArcLinkEvidence[], chain: ChainDescriptor): ArcSeasonLinkEvidence[] {
  return rows.map((e) => ({ ...e, explorerUrl: e.txHash ? txUrl(chain, e.txHash) : (e.url ?? null) }))
}

/** The day the founder said these wallets of a link belong to one person, when his word on the link covers every one of them. */
function onePersonOn(link: ArcWalletLink, wallets: readonly string[]): { onePersonOn?: string } {
  const said = new Set((link.onePerson?.wallets ?? []).map((w) => w.toLowerCase()))
  return link.onePerson && wallets.every((w) => said.has(w.toLowerCase())) ? { onePersonOn: link.onePerson.saidOn } : {}
}

/**
 * The parties these wallets can be at most: each wallet starts alone, and a group that holds two or more of them joins them.
 * A ceiling, because the chain can merge wallets and can never show that two of them are different people. Lowercased.
 */
export function partiesAmong(wallets: Iterable<string>, groups: readonly (readonly string[])[]): string[][] {
  const parent = new Map<string, string>()
  for (const w of wallets) parent.set(w.toLowerCase(), w.toLowerCase())
  const find = (w: string): string => {
    let root = w
    while (parent.get(root) !== root) root = parent.get(root) as string
    return root
  }
  for (const group of groups) {
    const here = [...new Set(group.map((w) => w.toLowerCase()))].filter((w) => parent.has(w))
    for (const w of here.slice(1)) parent.set(find(w), find(here[0]))
  }
  const byRoot = new Map<string, string[]>()
  for (const w of parent.keys()) byRoot.set(find(w), [...(byRoot.get(find(w)) ?? []), w])
  return [...byRoot.values()]
}

/** How many owner wallets stand behind the counted vaults, and which of them a curated link ties together. A link counts here
 *  only through the wallets that own a counted vault, and only when two or more of them do: a link to a wallet that owns no
 *  counted vault says nothing about this count. With the list of admitted vaults unreadable the list is short, so the summary
 *  says so and states no ceiling. */
export function vaultOwners(
  vaults: readonly ArcOwnerHeldVault[],
  links: readonly ArcWalletLink[],
  chain: ChainDescriptor,
  context: { teams: readonly (readonly string[])[]; external: readonly ArcSeasonWallet[]; incomplete: boolean },
): ArcSeasonVaultOwners {
  const byOwner = new Map<string, { spelled: string; vaults: string[] }>()
  for (const v of vaults) {
    const key = v.owner.toLowerCase()
    const seen = byOwner.get(key) ?? { spelled: v.owner, vaults: [] }
    seen.vaults.push(v.address)
    byOwner.set(key, seen)
  }
  const linked: ArcSeasonOwnerLinkItem[] = links.flatMap((l) => {
    const owners = [...new Set(l.wallets.map((w) => w.toLowerCase()))].filter((w) => byOwner.has(w))
    if (owners.length < 2) return []
    return [
      {
        owners: owners.map((w) => byOwner.get(w)!.spelled),
        vaults: owners.flatMap((w) => byOwner.get(w)!.vaults),
        ...onePersonOn(l, owners),
        tracedOn: l.tracedOn,
        confidence: l.confidence,
        note: l.note,
        evidence: linkEvidence(l.evidence, chain),
      },
    ]
  })
  const groups = [...links.map((l) => l.wallets), ...context.teams]
  const distinct = byOwner.size
  const parties = partiesAmong(byOwner.keys(), groups).length
  const lead = `${withUnit(vaults.length, 'vault', 'vaults')} from ${withUnit(distinct, 'owner wallet', 'owner wallets')}`
  // A link alone says the owners may be one party. The founder's word, where he gave it, is said as his, with its day.
  const linkClauses = linked.map(
    (l) => `${inWords(l.owners.length)} of the owner wallets are linked on chain, ${l.onePersonOn ? `and the founder said on ${l.onePersonOn} that they belong to one person` : 'so they may be one party'}`,
  )
  const ceiling = linked.length > 0 && !context.incomplete ? `: at most ${withUnit(parties, 'party', 'parties')}` : ''
  const short = context.incomplete ? ' The list of admitted vaults could not be read, so there may be more.' : ''

  // A party that both stands behind a counted vault and paid checks: the same wallets read through the same groups.
  const paying = new Map(context.external.map((w) => [w.wallet, w]))
  const alsoPaid = partiesAmong([...byOwner.keys(), ...paying.keys()], groups).flatMap((party) => {
    const owners = party.filter((w) => byOwner.has(w))
    const payers = party.filter((w) => paying.has(w))
    if (owners.length === 0 || payers.length === 0) return []
    const vaultsOfParty = owners.flatMap((w) => byOwner.get(w)!.vaults)
    const checks = payers.reduce((n, w) => n + paying.get(w)!.checks, 0)
    return [
      {
        vaults: vaultsOfParty,
        wallets: payers,
        checks,
        note: `The party behind ${vaultsOfParty.length === 1 ? 'vault' : 'vaults'} ${vaultsOfParty.map(shortAddress).join(' and ')} also paid ${withUnit(checks, 'external check', 'external checks')}, counted under Milestone 2 and never here.`,
      },
    ]
  })
  return { distinct, parties: context.incomplete ? null : parties, linked, alsoPaid, summary: `${[lead, ...linkClauses].join('; ')}${ceiling}.${short}` }
}

/** Who stands behind the external checks: distinct wallets, the parties they can be at most, and what anyone has said of them. */
function externalPayers(
  external: readonly ArcSeasonWallet[],
  links: readonly ArcWalletLink[],
  chain: ChainDescriptor,
  context: { teams: readonly (readonly string[])[]; incomplete: boolean },
): ArcSeasonPayers {
  const paying = new Map(external.map((w) => [w.wallet, w]))
  const totalChecks = external.reduce((n, w) => n + w.checks, 0)
  const linked: ArcSeasonPayerLinkItem[] = links.flatMap((l) => {
    const wallets = [...new Set(l.wallets.map((w) => w.toLowerCase()))].filter((w) => paying.has(w))
    if (wallets.length < 2) return []
    const teamNames = [...new Set(wallets.map((w) => paying.get(w)!.team))]
    return [
      {
        wallets,
        checks: wallets.reduce((n, w) => n + paying.get(w)!.checks, 0),
        ...(teamNames.length === 1 && teamNames[0] ? { team: teamNames[0] } : {}),
        ...onePersonOn(l, wallets),
        tracedOn: l.tracedOn,
        confidence: l.confidence,
        note: l.note,
        evidence: linkEvidence(l.evidence, chain),
      },
    ]
  })
  const parties = partiesAmong(paying.keys(), [...links.map((l) => l.wallets), ...context.teams])
  const whoPaid = {
    team: { wallets: 0, checks: 0 },
    'not-team': { wallets: 0, checks: 0 },
    'not-identified': { wallets: 0, checks: 0 },
  }
  for (const w of external) {
    whoPaid[w.identity].wallets += 1
    whoPaid[w.identity].checks += w.checks
  }
  const clusters = parties
    .filter((party) => party.length >= 2)
    .map((party) => {
      const checks = party.reduce((n, w) => n + paying.get(w)!.checks, 0)
      const teamNames = [...new Set(party.map((w) => paying.get(w)!.team))]
      return { size: party.length, checks, team: teamNames.length === 1 ? teamNames[0] : undefined }
    })
    .sort((a, b) => b.checks - a.checks)
  const lead = `${withUnit(totalChecks, 'check', 'checks')} from ${withUnit(external.length, 'wallet', 'wallets')}`
  // A log that could not be read is said first: with it down, no wallet found is not the same as none paid.
  const summary = context.incomplete
    ? external.length === 0
      ? 'No external wallet was found in the logs that could be read on this request, and that says nothing about a log that could not be read.'
      : `${lead} in the logs that could be read, so more wallets may have paid.`
    : external.length === 0
      ? 'No external wallet has paid a check yet.'
      : clusters.length === 0
        ? `${lead}${external.length > 1 ? ', and no two of them are linked by a trace or a shared team' : ''}.`
        : `${lead}, at most ${withUnit(parties.length, 'party', 'parties')}: ${clusters
            .map((c) => (c.team ? `${c.team}'s ${inWords(c.size)} wallets paid ${c.checks}` : `${inWords(c.size)} wallets linked on chain paid ${c.checks}`))
            .join(', and ')}.`
  return { wallets: external.length, parties: context.incomplete ? null : parties.length, linked, whoPaid, summary }
}

/** Said on the vault count, because a vault that stopped after its deploy never counts and an owner should know why. */
const VAULT_COUNTS_ONCE = 'A vault counts once its agent key has an end date, the second confirmation on /app/vault/arc: a deploy that stopped before that, or a deploy on Arc Testnet, is not counted.'

/** Who has received gas support is curated from the operating wallet's own sends. Said with its date, so it reads as what it is. */
const GAS_SUPPORT_NOTE = `Owners without USDC on Arc can receive up to 0.08 USDC from our operating wallet for the network fees. ${ARC_GAS_SUPPORT.owners === 0 ? 'None has so far' : `${ARC_GAS_SUPPORT.owners} owner(s) have so far`}, as read from that wallet's sends on ${ARC_GAS_SUPPORT.readOn}, and any such transfer is public on chain; the deploy is still signed by the owner's own wallet.`

/** A season can hold dozens of recorded DENYs. The report lists a few here and counts them all. */
const REFUSAL_ITEMS_SHOWN = 5

export async function arcSeasonReport(deps: ArcSeasonDeps): Promise<ArcSeasonReport> {
  const chain = arcMainnet()
  const now = deps.now ?? Date.now
  const partners = deps.partners ?? ARC_PARTNERS
  const curatedVaults = deps.vaults ?? ARC_OWNER_HELD_VAULTS
  const refusals = deps.refusals ?? ARC_REFUSALS

  const gateway = await readLog('Gateway settlement log', deps.gatewayRows)
  const facilitator = await readLog('facilitator settlement log', deps.facilitatorRows)
  const skippedRows: ArcSeasonSkippedRow[] = []
  const loadFlowRows = deps.flowRows
  const flowKeys: ArcFlowKeys[] = []
  const recordedFlows = loadFlowRows ? await readLog('verify-then-pay flow log', () => loadFlowRows((row) => skippedRows.push(row), (keys) => flowKeys.push(keys))) : null
  const flows = mergeFlows(deps.flows ?? ARC_VERIFY_THEN_PAY_FLOWS, recordedFlows?.rows ?? [])
  for (const f of flows) if (f.vault && f.vaultKeys) flowKeys.push({ vault: f.vault, operator: f.vaultKeys.operator, ...(f.payer ? { payer: f.payer } : {}) })
  const skippedVaults: ArcSeasonSkippedVault[] = []
  const loadAdmitted = deps.admittedVaults
  const admittedVaults = loadAdmitted ? await readLog('list of admitted vaults', () => loadAdmitted((row) => skippedVaults.push(row))) : null
  const vaults = labelOwners(mergeVaults(curatedVaults, admittedVaults?.rows ?? []), curatedVaults, partners)
  const vaultsByKind: Record<ArcOwnerKind, number> = { team: 0, external: 0, unstated: 0 }
  for (const v of vaults) vaultsByKind[v.ownerKind] += 1
  const unstatedVaults = vaultsByKind.unstated
  const vaultItems = await vaultItemsWithActions(vaults, chain, deps.ownerActions)
  const ownerActions = {
    freezes: vaultItems.reduce((n, v) => n + v.freezeTxs.length, 0),
    withdrawals: vaultItems.reduce((n, v) => n + v.withdrawTxs.length, 0),
    vaultsNotFullyRead: vaultItems.filter((v) => v.actionsRead.state !== 'complete').length,
  }

  const checks: Check[] = [
    ...gateway.rows
      .filter((r) => GATEWAY_SETTLED.has(r.outcome) && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'gateway', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts, nonce: r.authNonce, outcome: r.outcome, ...(r.tx && TX_HASH.test(r.tx) ? { batchTx: r.tx } : {}) })),
    ...facilitator.rows
      .filter((r) => r.outcome === 'settled' && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'facilitator', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts, nonce: r.authNonce })),
  ]
  // The agent keys flows recorded on vaults of this kind. Matched on the vault's own address and never on its
  // owner: anyone can deploy a vault that names a team wallet as owner and their own key as operator.
  const flowKeysOn = (kind: ArcOwnerKind) => {
    const addresses = new Set(vaults.filter((v) => v.ownerKind === kind).map((v) => v.address.toLowerCase()))
    return flowKeys.filter((k) => addresses.has(k.vault.toLowerCase()))
  }
  // A vault labeled 'team' is a person on our team, in their own wallet. We never held that key,
  // which is what the vault metric counts, and the wallet is still not one "we do not control" for
  // Milestone 2, so a check it pays is ours. So is one the agent key they run pays, and the approval
  // page offers only a check that key paid for, so that is the key a team member's hand-off comes from.
  const teamWallets = vaults.filter((v) => v.ownerKind === 'team').map((v) => v.owner)
  // The launch-day vault is ours whoever its key is now: its owner is our operating wallet, and only that wallet can set its
  // operator, which the row read from the chain. So a key it has rotated to is ours before anyone has committed its address.
  const launchVault = launchDayVault()
  const launchDayKeys = launchVault ? flowKeys.filter((k) => k.vault.toLowerCase() === launchVault.toLowerCase()).map((k) => k.operator) : []
  const ourPayeeList = deps.ourPayees ?? ARC_OUR_PAYEES
  const mine = new Set(
    [...deps.internalPayers.gateway, ...deps.internalPayers.facilitator, ...(deps.committedOurs ?? []), ...ourPayeeList.map((p) => p.address), ...teamWallets, ...flowKeysOn('team').map((k) => k.operator), ...launchDayKeys].map((a) => a.toLowerCase()),
  )
  const internalChecks = checks.filter((c) => mine.has(c.payer))
  const externalChecks = checks.filter((c) => !mine.has(c.payer))

  const teamOf = new Map(partners.map((p) => [p.wallet.toLowerCase(), p.team]))
  const walletLinks = deps.walletLinks ?? ARC_WALLET_LINKS
  const ourSideLinks = deps.ourSideLinks ?? ARC_OUR_SIDE_LINKS
  const notTeamPayers = new Map((deps.notTeamPayers ?? ARC_NOT_TEAM_PAYERS).map((p) => [p.wallet.toLowerCase(), p.saidOn]))
  // One team under one name is one party, whether or not anyone traced a link between its wallets.
  const teamGroups = [...new Set(partners.map((p) => p.team))].map((team) => partners.filter((p) => p.team === team).map((p) => p.wallet.toLowerCase()))
  const linkGroups = [...walletLinks.map((l) => l.wallets), ...teamGroups]
  const external = byWallet(externalChecks, teamOf, notTeamPayers, linkGroups)
  const walletStats = new Map(external.map((w) => [w.wallet, w]))
  // What a log that could not be read does to the rest of the report: every number it feeds is a
  // lower limit, and no sentence may say that nothing happened.
  const unreadableSettlementLogs = [
    ...(gateway.read.readable ? [] : ['Circle Gateway settlement log']),
    ...(facilitator.read.readable ? [] : ['facilitator settlement log']),
  ]
  const settlementsIncomplete = unreadableSettlementLogs.length > 0
  const flagIncomplete = (incomplete: boolean) => (incomplete ? { incomplete: true as const } : {})
  const settlementsCaveat = settlementsIncomplete
    ? `The ${unreadableSettlementLogs.join(' and the ')} could not be read on this request, so this is a lower limit and not a statement that nothing more happened. `
    : ''

  const vaultListUnread = Boolean(admittedVaults && !admittedVaults.read.readable)
  const owners = vaultOwners(vaults, walletLinks, chain, { teams: teamGroups, external, incomplete: vaultListUnread })
  const payers = externalPayers(external, walletLinks, chain, { teams: teamGroups, incomplete: settlementsIncomplete })
  // Each vault's keys as this read knows them: the owner a counted vault carries or a flow's own record names, and every
  // operator the flow log or a flow's record names. Linked wallets are said to be one party as fact only when they are one
  // vault's owner and its agent keys: a link alone can be of medium strength, and two owners may be one party or two.
  const keysByVault = new Map<string, { vault: string; owners: Set<string>; operators: Set<string> }>()
  const keysOfVault = (vault: string) => {
    const known = keysByVault.get(vault.toLowerCase()) ?? { vault, owners: new Set<string>(), operators: new Set<string>() }
    keysByVault.set(vault.toLowerCase(), known)
    return known
  }
  for (const v of vaults) keysOfVault(v.address).owners.add(v.owner.toLowerCase())
  for (const f of flows) if (f.vault && f.vaultKeys) keysOfVault(f.vault).owners.add(f.vaultKeys.owner.toLowerCase())
  for (const k of flowKeys) keysOfVault(k.vault).operators.add(k.operator.toLowerCase())
  /** The vault whose owner is one of these wallets and whose agent keys are all the others, or null. */
  const oneVaultOf = (wallets: readonly string[]) =>
    [...keysByVault.values()].find((k) => {
      const owners = wallets.filter((w) => k.owners.has(w))
      return owners.length === 1 && wallets.every((w) => owners.includes(w) || k.operators.has(w))
    }) ?? null
  // Linked wallets no named team stands behind are said apart from the rest, because a share of the checks that large may be
  // one party. Each is said with what anyone has said of its wallets: nobody, or the founder on one day that none of them is a
  // team wallet; a party whose wallets were spoken for on different terms is left to the who-paid line. It is one party as
  // fact through one vault's keys; otherwise one person on the founder's word, as his and with its day, where he gave it;
  // otherwise it may be one party.
  const saidOfParty = (l: ArcSeasonPayerLinkItem): string | null => {
    const rows = l.wallets.map((w) => walletStats.get(w))
    if (rows.every((w) => w?.identity === 'not-identified')) return 'nobody has identified'
    const days = new Set(rows.map((w) => (w?.identity === 'not-team' ? w.notTeamSaidOn : undefined)))
    const [day] = days
    return days.size === 1 && day ? `whose wallets the founder said on ${day} are not team wallets` : null
  }
  const partyLine = (l: ArcSeasonPayerLinkItem, who: string): string => {
    const rest = `the other ${externalChecks.length - l.checks} come from ${withUnit(external.length - l.wallets.length, 'wallet', 'wallets')}.`
    const vault = oneVaultOf(l.wallets)
    if (!vault && l.onePersonOn) return ` ${l.checks} of the ${externalChecks.length} come from one party ${who}: ${l.wallets.map(shortAddress).join(' and ')}, linked on chain, and one person on the founder's word of ${l.onePersonOn}; ${rest}`
    if (!vault) return ` ${l.checks} of the ${externalChecks.length} come from wallets linked on chain, which may be one party ${who}: ${l.wallets.map(shortAddress).join(' and ')}; ${rest}`
    const keys = [...l.wallets.filter((w) => vault.owners.has(w)), ...l.wallets.filter((w) => !vault.owners.has(w))]
    const agentKeys = keys.length === 2 ? 'agent key' : `${inWords(keys.length - 1)} agent keys`
    return ` ${l.checks} of the ${externalChecks.length} come from one party ${who}: ${keys.map(shortAddress).join(' and ')}, the owner and ${agentKeys} of vault ${shortAddress(vault.vault)}, linked on chain; ${rest}`
  }
  const partyLines = payers.linked.flatMap((l) => {
    const who = l.team ? null : saidOfParty(l)
    return who ? [partyLine(l, who)] : []
  })
  // The founder's word that a wallet is not a team wallet, by the day he gave it, so each statement reads with its own date.
  const notTeamByDay = sortedUnique(external.flatMap((w) => (w.notTeamSaidOn ? [w.notTeamSaidOn] : []))).map((day) => {
    const own = external.filter((w) => w.notTeamSaidOn === day)
    return { day, wallets: own.length, checks: own.reduce((n, w) => n + w.checks, 0) }
  })
  const whoPaidClauses = [
    ...(payers.whoPaid.team.wallets > 0 ? [`${withUnit(payers.whoPaid.team.checks, 'check', 'checks')} from ${withUnit(payers.whoPaid.team.wallets, 'wallet', 'wallets')} of named teams`] : []),
    ...notTeamByDay.map((d) => `${withUnit(d.checks, 'check', 'checks')} from ${withUnit(d.wallets, 'wallet', 'wallets')} the founder said on ${d.day} are not team wallets`),
    ...(payers.whoPaid['not-identified'].wallets > 0 ? [`${withUnit(payers.whoPaid['not-identified'].checks, 'check', 'checks')} from ${withUnit(payers.whoPaid['not-identified'].wallets, 'wallet', 'wallets')} nobody has identified`] : []),
  ]
  // The same, said of the wallets no team is attributed: each statement of the founder's with its day, then the wallets nobody
  // has spoken for, if any.
  const unattributedSaid =
    notTeamByDay.length > 0
      ? ` ${[
          ...notTeamByDay.map((d, i) => `${d.wallets}${i === 0 ? ' of them' : ''} (${withUnit(d.checks, 'check', 'checks')}) the founder said on ${d.day} are not team wallets`),
          ...(payers.whoPaid['not-identified'].wallets > 0
            ? [`${payers.whoPaid['not-identified'].wallets} (${withUnit(payers.whoPaid['not-identified'].checks, 'check', 'checks')}) nobody has identified, each counted as external until someone says otherwise`]
            : []),
        ].join('; ')}.`
      : ''

  // Partners, each with what its wallet actually paid. A team can pay from more than one
  // wallet, so team-level metrics count distinct team names.
  const teams: ArcSeasonTeam[] = partners.flatMap((p) => {
    const stats = walletStats.get(p.wallet.toLowerCase())
    return stats ? [{ ...stats, team: p.team, publicReference: p.publicReference }] : []
  })
  const liveTeams = sortedUnique(teams.map((t) => t.team))
  // A team's days are counted across all its wallets: a team that pays from one wallet on Monday
  // and another on Tuesday was active on two days, and neither wallet alone was.
  const teamDays = liveTeams.map((team) => {
    const own = teams.filter((t) => t.team === team)
    const times = own.flatMap((t) => [t.firstTs, t.lastTs]).filter((t) => Number.isFinite(Date.parse(t))).sort((x, y) => Date.parse(x) - Date.parse(y))
    return { team, activeDays: sortedUnique(own.flatMap((t) => t.activeDays)), firstTs: times[0] ?? own[0].firstTs, lastTs: times[times.length - 1] ?? own[0].lastTs }
  })
  const severalDays = teamDays.filter((t) => t.activeDays.length >= 2).map((t) => t.team)
  const publicNames = sortedUnique(teams.filter((t) => t.publicReference).map((t) => t.team))
  const unattributed = external.filter((w) => !w.team)

  const gatewayChecks = checks.filter((c) => c.rail === 'gateway')
  const ownGateway = gatewayChecks.filter((c) => mine.has(c.payer))
  const gatewayInternal = ownGateway.length
  const gatewayExternal = gatewayChecks.length - gatewayInternal

  // A flow counts once per check and once per payment transaction, only on one of our own
  // settled Gateway checks, only when it names the payee and its outcome did not come before
  // the check, and only with something a reviewer can open. A flow that names its payer links only to that payer's
  // check, because a nonce is unique per payer and not across payers. An external check is
  // left to Milestone 2.
  const ownByNonce = new Map(ownGateway.map((c) => [c.nonce.toLowerCase(), c]))
  // The Gateway log keeps its newest rows only. A check older than the oldest row of a full
  // log lost its row to that trim, so a recorded flow for it links by the settlement its own
  // record holds. Anything newer has its row in the log, or never had one, and links by the
  // log alone; an unreadable log links nothing either way.
  const cap = deps.gatewayCap ?? GATEWAY_SETTLEMENTS_CAP
  const retainedTimes = gateway.rows.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t))
  const retainedFrom = gateway.read.readable && gateway.rows.length >= cap && retainedTimes.length ? Math.min(...retainedTimes) : null
  const agedOutCheck = (f: ArcVerifyThenPayFlow): Check | null => {
    const e = f.check
    if (!e || retainedFrom === null) return null
    if (e.network !== chain.caip2 || !GATEWAY_SETTLED.has(e.outcome as GatewaySettlementRecord['outcome']) || !mine.has(e.payer.toLowerCase())) return null
    const t = Date.parse(e.ts)
    if (!Number.isFinite(t) || t >= retainedFrom) return null
    return { rail: 'gateway', payer: e.payer.toLowerCase(), usd: 0, ts: e.ts, nonce: f.checkNonce.toLowerCase() }
  }
  const linkedTxs = new Set<string>()
  // One pass of the linking rules against one set of checks. Milestone 1 and Milestone 2 share
  // linkedTxs, so one transaction can never stand behind a flow in both.
  const linkFlows = (byNonce: Map<string, Check>, fallback: (f: ArcVerifyThenPayFlow) => Check | null) => {
    const out = new Map<string, { flow: ArcVerifyThenPayFlow; check: Check; fromLog: boolean }>()
    for (const f of flows) {
      const nonce = f.checkNonce.toLowerCase()
      const inLog = byNonce.get(nonce)
      const check = inLog ?? fallback(f)
      if (!check || out.has(nonce) || !ADDRESS.test(f.payee) || flowEvidence(f) === null) continue
      if (f.payer !== undefined && f.payer.toLowerCase() !== check.payer) continue
      const tx = f.txHash?.toLowerCase()
      if (tx && linkedTxs.has(tx)) continue
      if (outcomeFollowsCheck(f, check.ts)) {
        out.set(nonce, { flow: f, check, fromLog: Boolean(inLog) })
        if (tx) linkedTxs.add(tx)
      }
    }
    return out
  }
  const linkedRows = linkFlows(ownByNonce, agedOutCheck)
  const linkedFlows = new Map([...linkedRows].map(([nonce, l]) => [nonce, l.flow]))
  const agedOut = [...linkedRows.values()].filter((l) => !l.fromLog).length
  const linked: Record<ArcFlowOutcome, number> = { paid: 0, refused: 0 }
  for (const f of linkedFlows.values()) linked[f.outcome] += 1
  const linkedInLog = linkedFlows.size - agedOut
  // The same rules against external Gateway checks. A flow the loop above took is not looked at
  // twice: its nonce names one of our checks, or it names its payer and the payer does not match.
  const externalByNonce = new Map(gatewayChecks.filter((c) => !mine.has(c.payer)).map((c) => [c.nonce.toLowerCase(), c]))
  const externalRows = linkFlows(externalByNonce, () => null)

  const windowMs = ARC_SEASON_TARGETS.activeWindowDays * 24 * 60 * 60 * 1000
  const since = new Date(now() - windowMs).toISOString()
  const activeWallets = sortedUnique(
    externalChecks.filter((c) => Number.isFinite(Date.parse(c.ts)) && Date.parse(c.ts) >= Date.parse(since)).map((c) => c.payer),
  )

  // A payee that is ours, or the vault's own key: the flow is real and counts, and a reviewer
  // should not have to work out from addresses that nobody else was going to be paid.
  const ourAddresses = new Set([...mine, ...(deps.ourPayTo ?? []).map((a) => a.toLowerCase())])
  const ourPayees = new Map(ourPayeeList.map((p) => [p.address.toLowerCase(), p.why]))
  const payeeInternal = (f: ArcVerifyThenPayFlow): string | null => {
    const payee = f.payee.toLowerCase()
    if (payee === f.vaultKeys?.owner.toLowerCase()) return "the payee is this vault's owner"
    if (payee === f.vaultKeys?.operator.toLowerCase()) return "the payee is this vault's operator"
    if (ourPayees.has(payee)) return ourPayees.get(payee) as string
    return ourAddresses.has(payee) ? 'the payee is one of our own wallets' : null
  }
  const counted = new Set(vaults.map((v) => v.address.toLowerCase()))
  const vaultKindOf = (f: ArcVerifyThenPayFlow): ArcFlowVaultKind => {
    if (!f.vault) return 'not-recorded'
    const vault = f.vault.toLowerCase()
    if (launchVault && vault === launchVault.toLowerCase()) return 'launch-day'
    return counted.has(vault) ? 'owner-held' : 'other'
  }
  const flowItem = ({ flow: f, check, fromLog }: { flow: ArcVerifyThenPayFlow; check: Check; fromLog: boolean }): ArcSeasonFlowItem => {
    // The record's own copy of the check is what it was when the check settled: as "credited" it
    // would contradict the row once the batch lands, so an item shows the row as it stands now.
    const { check: asRecorded, ...rest } = f
    const why = payeeInternal(f)
    return {
      ...rest,
      explorerUrl: f.txHash && TX_HASH.test(f.txHash) ? txUrl(chain, f.txHash) : null,
      vaultKind: vaultKindOf(f),
      checkSettlement: fromLog
        ? { outcome: check.outcome ?? 'credited', readFrom: 'gateway-log', ...(check.batchTx ? { batchTx: check.batchTx, batchExplorerUrl: txUrl(chain, check.batchTx) } : {}) }
        : { outcome: asRecorded?.outcome ?? 'credited', readFrom: 'flow-record' },
      ...(why ? { payeeInternal: why } : {}),
    }
  }
  // How a payee is tied to the wallet that paid for its check, read from the check row itself: the two are both keys of the
  // flow's vault, a curated link holds both, or both are true. A payee that is only the vault's own key is not tied to a payer
  // outside the vault: anyone can buy a check that names any vault. Said on external flows, where a reader would otherwise
  // take the payment for one to somebody else.
  const vaultKeysOf = (f: ArcVerifyThenPayFlow) => (f.vaultKeys ? [f.vaultKeys.owner.toLowerCase(), f.vaultKeys.operator.toLowerCase()] : [])
  const payeeTie = ({ flow: f, check }: { flow: ArcVerifyThenPayFlow; check: Check }): ArcPayeeTie[] => {
    const payee = f.payee.toLowerCase()
    const keys = vaultKeysOf(f)
    const byKeys = keys.includes(payee) && keys.includes(check.payer)
    const byLink = walletLinks.some((l) => {
      const inLink = new Set(l.wallets.map((w) => w.toLowerCase()))
      return inLink.has(payee) && inLink.has(check.payer)
    })
    return [...(byKeys ? ['vault-keys' as const] : []), ...(byLink ? ['link' as const] : [])]
  }
  const linkedList = [...linkedFlows.values()]
  const flowsByVault: Record<ArcFlowVaultKind, number> = { 'launch-day': 0, 'owner-held': 0, other: 0, 'not-recorded': 0 }
  for (const f of linkedList) flowsByVault[vaultKindOf(f)] += 1
  // A flow through a vault outside the counted list is "other", and with the list unreadable that
  // says nothing about whose vault it is, so no sentence may rule an owner's vault out.
  const admittedUnreadable = Boolean(admittedVaults && !admittedVaults.read.readable)
  const everyFlowOnLaunchVault = linkedList.length > 0 && flowsByVault['launch-day'] === linkedList.length
  const flowLogUnreadable = Boolean(recordedFlows && !recordedFlows.read.readable)
  const flowsIncomplete = !gateway.read.readable || flowLogUnreadable
  // The agent keys of team vaults come from the flow log, and so does a key the launch-day vault rotated to before anyone
  // committed it, so with the log down one could be counted as external. That makes a number too high, not too low, so it is
  // not `incomplete`. Said on every number that reads external checks, wherever there is one. The launch-day vault is always
  // there to rotate, and whether its key now is committed takes a chain read this report does not make, so it is said on
  // every outage of the log rather than never.
  const keysFromLog = [...(vaultsByKind.team > 0 ? ['a vault labeled team'] : []), ...(launchVault ? ['the launch-day vault'] : [])]
  const keysOf = keysFromLog.length > 1 ? `${keysFromLog[0]}, or of ${keysFromLog[1]},` : keysFromLog[0]
  const teamKeysUnknown = flowLogUnreadable && keysFromLog.length > 0
  const flagTeamKeys = (count: number) => (teamKeysUnknown && count > 0 ? { mayIncludeTeamKeys: true as const } : {})
  const teamKeysCaveat = (count: number) =>
    teamKeysUnknown && count > 0 ? ` The verify-then-pay flow log could not be read on this request, so the agent key of ${keysOf} could be counted as external until it answers.` : ''
  const externalFlowItems = [...externalRows.values()].map((row): ArcSeasonFlowItem => {
    const tie = payeeTie(row)
    return { ...flowItem(row), ...(tie.length > 0 ? { payeeTiedToPayer: true as const, payeeTiedBy: tie } : {}) }
  })
  const teamFlowCount = externalFlowItems.filter((f) => f.payer && teamOf.has(f.payer.toLowerCase())).length
  // Only a flow that paid is a payment: a refused one moved nothing, so it is said apart. Each paid flow is said once, by its
  // payee: ours first; then one party, when the payer and the payee are both keys of the vault and a curated link holds both;
  // then perhaps one party, through the vault's keys alone, because a vault's owner can name anyone's wallet as its operator,
  // or through a curated link alone; then the vault's own key paid from a check someone outside the vault bought; then anyone
  // else.
  const externalPaid = externalFlowItems.filter((f) => f.outcome === 'paid')
  const externalRefused = externalFlowItems.filter((f) => f.outcome === 'refused').length
  const paidTo = { ours: 0, oneParty: 0, keysOnly: 0, linkOnly: 0, vaultKeyFromOutside: 0, other: 0 }
  for (const f of externalPaid) {
    const payee = f.payee.toLowerCase()
    const by = f.payeeTiedBy ?? []
    if (ourAddresses.has(payee)) paidTo.ours += 1
    else if (by.includes('vault-keys') && by.includes('link')) paidTo.oneParty += 1
    else if (by.includes('vault-keys')) paidTo.keysOnly += 1
    else if (by.includes('link')) paidTo.linkOnly += 1
    else if (vaultKeysOf(f).includes(payee)) paidTo.vaultKeyFromOutside += 1
    else paidTo.other += 1
  }
  const paidClauses = [
    ...(paidTo.oneParty > 0 ? [`${paidTo.oneParty} paid the vault's own owner or operator from a check one of the same vault's keys paid for, and a traced link ties the two, so ${paidTo.oneParty === 1 ? 'it is' : 'each is'} one party paying itself`] : []),
    ...(paidTo.keysOnly > 0 ? [`${paidTo.keysOnly} paid the vault's own owner or operator from a check one of the same vault's keys paid for, and no traced link ties the two, so ${paidTo.keysOnly === 1 ? 'it' : 'they'} may be one party paying itself, since a vault's owner can name anyone's wallet as its operator`] : []),
    ...(paidTo.linkOnly > 0 ? [`${paidTo.linkOnly} paid a wallet a traced link ties to the wallet that paid for the check, so ${paidTo.linkOnly === 1 ? 'it' : 'they'} may be one party paying itself`] : []),
    ...(paidTo.vaultKeyFromOutside > 0 ? [`${paidTo.vaultKeyFromOutside} paid the vault's own owner or operator from a check a wallet outside the vault's keys paid for`] : []),
    ...(paidTo.ours > 0 ? [`${paidTo.ours} paid one of our own wallets or agents`] : []),
    ...(paidTo.other > 0 ? [`${paidTo.other} paid a wallet that neither the vault's keys nor a traced link ties to the wallet that paid for the check`] : []),
  ]
  const weekly = weeklyUsage(externalChecks, now(), teamOf)
  // A wallet that paid and also owns a vault nobody identified, or runs as its agent key, could be
  // one of ours, and the chain cannot say. It still counts as external, and it is said. Not of a wallet
  // the partner list names, because then someone has said. And a key only on a flow it paid for itself:
  // a vault can name anyone's wallet as its operator, and that must not plant this sentence on them. A
  // team vault's keys above are not held to that: there the label is ours, and it is the vault that says.
  const unstatedOwners = new Set(vaults.filter((v) => v.ownerKind === 'unstated').map((v) => v.owner.toLowerCase()))
  const unstatedAgentKeys = new Set(flowKeysOn('unstated').filter((k) => k.payer?.toLowerCase() === k.operator.toLowerCase()).map((k) => k.operator.toLowerCase()))
  const externalVaultOwners = external.filter((w) => !w.team && unstatedOwners.has(w.wallet)).length
  const externalAgentKeys = external.filter((w) => !w.team && unstatedAgentKeys.has(w.wallet) && !unstatedOwners.has(w.wallet)).length
  const internalPayeeFlows = linkedList.filter((f) => payeeInternal(f) !== null).length
  // The after-program count is wallets. A team or a linked party with two wallets is said once, and which ones, in one sentence.
  const activeParties = partiesAmong(activeWallets, linkGroups)
  const activeClusters = activeParties.filter((party) => party.length >= 2)
  const activeClauses = activeClusters.map((party) => {
    const teamNames = [...new Set(party.map((w) => teamOf.get(w)))]
    return teamNames.length === 1 && teamNames[0] ? `${teamNames[0]}'s ${inWords(party.length)} wallets are one team` : `${inWords(party.length)} wallets are linked on chain`
  })
  const activeLinkedSummary = settlementsIncomplete
    ? 'It counts wallets, not parties, and a log that could not be read leaves the parties unknown.'
    : activeClusters.length === 0
      ? `It counts wallets, not parties: ${withUnit(activeWallets.length, 'wallet', 'wallets')}${activeWallets.length > 1 ? ', and no two of them are linked by a trace or a shared team' : ''}.`
      : `It counts wallets, not parties: ${withUnit(activeWallets.length, 'wallet', 'wallets')}, at most ${withUnit(activeParties.length, 'party', 'parties')}, because ${activeClauses.join(' and ')}.`
  const refusedPayees = new Set(linkedList.filter((f) => f.outcome === 'refused').map((f) => f.payee.toLowerCase())).size

  // A recorded DENY is an inspectable refusal: it has a public record, and it is what the metric
  // asks for. Filling this by hand-committed entry left it unmet while the flows sat in checks.
  const curatedEvidence = new Set(refusals.map((r) => r.evidenceUrl).filter(Boolean))
  const recordedDenials: ArcRefusal[] = linkedList.flatMap((f) => {
    if (f.outcome !== 'refused' || f.txHash || !f.evidenceUrl || curatedEvidence.has(f.evidenceUrl)) return []
    const why = payeeInternal(f)
    return [{ kind: 'deny-before-signing' as const, evidenceUrl: f.evidenceUrl, at: f.at, note: f.note, ...(why ? { payeeInternal: why } : {}) }]
  })
  // A recorded policy revert is one by the same definition: a vault transaction that reverted on chain, with its hash, that the
  // receipt route read back. A curated entry for the same hash is the same refusal.
  const curatedHashes = new Set(refusals.flatMap((r) => (r.txHash ? [r.txHash.toLowerCase()] : [])))
  const recordedReverts: ArcRefusal[] = linkedList.flatMap((f) => {
    if (f.outcome !== 'refused' || !f.txHash || !TX_HASH.test(f.txHash) || curatedHashes.has(f.txHash.toLowerCase())) return []
    const why = payeeInternal(f)
    return [{ kind: 'vault-policy-on-chain' as const, txHash: f.txHash, at: f.at, note: f.note, ...(why ? { payeeInternal: why } : {}) }]
  })
  // What a re-check today would answer differently, and only that: a DENY dated after the change,
  // or one on an agent of ours that has a platform record, was not answered under the older rule.
  const ourPlatformAgents = new Set(ARC_OUR_PAYEES.map((p) => p.address.toLowerCase()))
  const deniesUnderOldRule = linkedList.filter(
    (f) => f.outcome === 'refused' && !f.txHash && f.evidenceUrl && !curatedEvidence.has(f.evidenceUrl) && Date.parse(f.at) < Date.parse(`${RISK_RULE_CHANGED_ON}T00:00:00.000Z`) && !ourPlatformAgents.has(f.payee.toLowerCase()),
  )
  const namedUnderOldRule = [...new Set(deniesUnderOldRule.map((f) => f.payee.toLowerCase()))]
  const allRefusals = [...refusals, ...recordedReverts, ...recordedDenials]
  const byKind: Record<ArcRefusalKind, number> = { 'vault-policy-on-chain': 0, 'deny-before-signing': 0 }
  for (const r of allRefusals) byKind[r.kind] += 1
  const refusalKindsShown = Object.values(byKind).filter((n) => n > 0).length

  return {
    asOf: new Date(now()).toISOString(),
    chain: ARC_SEASON_CHAIN,
    network: chain.caip2,
    program: ARC_SEASON_PROGRAM,
    logs: {
      gateway: gateway.read,
      facilitator: facilitator.read,
      ...(recordedFlows ? { flows: { ...recordedFlows.read, ...(skippedRows.length ? { skipped: skippedRows } : {}) } } : {}),
      ...(admittedVaults
        ? {
            admittedVaults: {
              readable: admittedVaults.read.readable,
              rows: admittedVaults.read.rows,
              ...(admittedVaults.read.reason ? { reason: admittedVaults.read.reason } : {}),
              ...(skippedVaults.length ? { skipped: skippedVaults } : {}),
            },
          }
        : {}),
    },
    usage: {
      basis:
        'A payer is internal when its address is on either rail\'s published list of our own buyer wallets (the hardcoded KNOWN_INTERNAL_PAYERS plus X402_GATEWAY_INTERNAL_PAYERS and X402_3009_INTERNAL_PAYERS), is an address this repo commits as ours (admission refuses a vault owner from the same addresses, and our own agents are among them), owns a vault labeled team, or is the agent key on a recorded verify-then-pay flow through such a vault or through the launch-day vault, compared case-insensitively; every other payer is external, and a check is a Circle Gateway row credited or completed, or a facilitator row settled, on Arc Mainnet. Everything after the rails\' lists counts as internal in this report only: the rails\' own proof reads the lists alone, and an agent key with no recorded flow through that vault stays external until it is on a list.' + teamKeysCaveat(externalChecks.length),
      internal: side(internalChecks),
      external: { ...side(externalChecks), byWallet: external, ...flagTeamKeys(externalChecks.length) },
    },
    milestone1: {
      title: 'Owner-held spend vaults and verify-then-pay on Arc Mainnet',
      due: ARC_SEASON_PROGRAM.milestone1Due,
      vaults: {
        count: vaults.length,
        target: ARC_SEASON_TARGETS.ownerHeldVaults,
        ...flagIncomplete(Boolean(admittedVaults && !admittedVaults.read.readable)),
        items: vaultItems,
        byKind: vaultsByKind,
        ownerActions,
        owners,
        note:
          (admittedVaults && !admittedVaults.read.readable ? 'The list of admitted vaults could not be read on this request, so any vault it holds is missing from this count until it answers. ' : '') +
          (skippedVaults.length ? `${skippedVaults.length} admitted vault row(s) are not counted; logs.admittedVaults names them and says why. ` : '') +
          (vaults.length === 0
            ? `${admittedVaults && !admittedVaults.read.readable ? '' : 'No owner-held vault yet. '}The launch-day vault${launchVault ? ` ${launchVault}` : ''} was deployed from our server key with our operating wallet as its owner, so it is not owner-held and is not counted. This count fills from vaults deployed by the owner's own wallet, each listed with its deploy hash. ${VAULT_COUNTS_ONCE} The deploy page at /app/vault/arc is one way to do that. ${GAS_SUPPORT_NOTE}`
            : `${vaults.length} of ${ARC_SEASON_TARGETS.ownerHeldVaults} vaults deployed by the owner's own wallet, which is none of the keys of ours it was compared with; GET /api/arc/vaults names any key it could not be compared with. ${VAULT_COUNTS_ONCE} ${owners.summary}${owners.linked.length > 0 ? ' Each link was traced by hand, not read live on this request, and the transactions behind it are named with it; the count does not move for it.' : ''}${owners.alsoPaid.length > 0 ? ` ${owners.alsoPaid.map((p) => p.note).join(' ')}` : ''} By whose wallet: ${vaultsByKind.team} of them someone on our own team, in their own wallet; ${vaultsByKind.external} someone outside the team; ${vaultsByKind.unstated} not identified as either. The chain cannot show which tool sent a deploy, so this count rests on the deploy transaction and the vault's code, not on proof that the page at /app/vault/arc was used. The launch-day vault${launchVault ? ` ${launchVault}` : ''} is owned by our operating wallet and is not among them. ${GAS_SUPPORT_NOTE}` +
              (unstatedVaults > 0
                ? ` ${unstatedVaults} of them were admitted automatically after every check passed, with the owner not identified: the checks prove the owner's wallet sent the deploy and is none of the keys it was compared with, and the chain cannot say whose wallet it is, so one could be a team member's. The founder's word that an owner is not a team wallet, given on 2026-11-06 and 2026-11-10, does not cover these.`
                : '') +
              ` Owner wallets have signed ${ownerActions.freezes} freeze(s) and ${ownerActions.withdrawals} withdrawal(s), each hash on its vault.` +
              (ownerActions.vaultsNotFullyRead > 0 ? ` ${ownerActions.vaultsNotFullyRead} vault(s) are not fully read yet, so there may be more; each says why on actionsRead.` : '')),
      },
      checks: {
        count: linkedFlows.size,
        target: ARC_SEASON_TARGETS.gatewayChecks,
        ...flagIncomplete(flowsIncomplete),
        internal: gatewayInternal,
        external: gatewayExternal,
        ...(teamKeysUnknown && gatewayExternal > 0 ? { externalMayIncludeTeamKeys: true as const } : {}),
        linked,
        unlinked: flowsIncomplete ? null : gatewayInternal - linkedInLog,
        agedOut,
        internalPayee: internalPayeeFlows,
        refusedPayees,
        byVault: flowsByVault,
        items: [...linkedRows.values()].map(flowItem),
        rail: 'circle-gateway',
        note:
          (!gateway.read.readable ? 'The Circle Gateway settlement log could not be read on this request, so no check, and no flow linked to one, is counted until it answers. ' : '') +
          (flowLogUnreadable ? 'The verify-then-pay flow log could not be read on this request, so any flow it holds is missing from this count until it answers. ' : '') +
          (skippedRows.length ? `${skippedRows.length} verify-then-pay flow row(s) could not be read and are not counted; logs.flows names them. ` : '') +
          (linkedFlows.size === 0
            ? flowsIncomplete
              ? 'A check counts here only when it opened a flow: a Circle Gateway check on Arc Mainnet paid from our own wallets and followed by a vault payment or an inspectable refusal, linked by the nonce its settlement row is keyed by. EIP-3009 facilitator settlements are reported under usage.'
              : `No verify-then-pay flow yet. A check counts here only when it opened one: a Circle Gateway check on Arc Mainnet paid from our own wallets and followed by a vault payment or an inspectable refusal, linked by the nonce its settlement row is keyed by. ${gatewayInternal} internal Gateway check(s) have settled and none is linked to a vault payment or a refusal yet, so none counts. The ${gatewayExternal} external Gateway check(s) count under Milestone 2, not here, so no check counts twice. EIP-3009 facilitator settlements are reported under usage.`
            : `${linkedFlows.size} of ${ARC_SEASON_TARGETS.gatewayChecks} verify-then-pay flows on Arc Mainnet: a Circle Gateway check paid from our own wallets and followed by ${linked.paid} vault payment(s) and ${linked.refused} refusal(s), each linked by the check's settlement nonce.` +
              (flowsIncomplete ? '' : ` ${gatewayInternal - linkedInLog} internal check(s) have nothing linked and are not counted. The ${gatewayExternal} external Gateway check(s) count under Milestone 2, not here, so no check counts twice.`) +
              ` Circle's intro to this program asks for external use, and these ${linkedFlows.size} flows are not that: they are our own runs, from our own wallets, and they prove the mechanism works. External use is counted separately, under Milestone 2.` +
              ` ${flowsByVault['launch-day']} of the flows ran through the launch-day vault${launchVault ? ` ${launchVault}` : ''}, whose owner and agent keys are both ours, and ${flowsByVault['owner-held']} through an owner-held vault counted in the row above${flowsByVault.other + flowsByVault['not-recorded'] > 0 ? `; ${flowsByVault.other + flowsByVault['not-recorded']} through another vault or with no vault on record` : ''}.` +
              (admittedUnreadable && flowsByVault.other > 0 ? " The list of admitted vaults could not be read on this request, so a flow through another vault could still be through an owner's." : '') +
              (everyFlowOnLaunchVault && !admittedUnreadable ? " So this count and the vault count are separate measures: none of these payments came from an owner's vault." : '') +
              ' A check\'s batch hash proves that Gateway settled a net position on chain, and a batch can carry other parties\' transfers, so it is not a one-to-one payment; a check shown as credited with no batch hash is one Circle holds, and our log has not read a batch for it yet.' +
              (agedOut > 0
                ? ` ${agedOut} of the flows link by the settlement their own flow record holds: the Gateway log keeps its newest ${cap} rows, and their check is older than the oldest row it still has.`
                : '') +
              (internalPayeeFlows > 0
                ? ` ${internalPayeeFlows} of the flows name a payee that is ours (our own wallet, our own agent or the vault's own key), labeled payeeInternal on each item: our own runs, not payments to anyone else.${internalPayeeFlows === linkedFlows.size ? ' That is every flow.' : ''} The refused flows name ${refusedPayees} distinct payee(s).`
                : '')),
      },
      refusals: {
        count: refusalKindsShown,
        target: ARC_SEASON_TARGETS.inspectableRefusals,
        ...flagIncomplete(flowsIncomplete),
        // The curated entries and the first few recorded ones: every recorded one is on checks.items.
        items: [...refusals, ...recordedReverts.slice(0, REFUSAL_ITEMS_SHOWN), ...recordedDenials.slice(0, REFUSAL_ITEMS_SHOWN)].map((r) => ({ ...r, explorerUrl: r.txHash ? txUrl(chain, r.txHash) : null })),
        byKind,
        note:
          (flowsIncomplete ? 'A log the recorded refusals are read from could not be read on this request, so any refusal it holds is missing from this count until it answers. ' : '') +
          (allRefusals.length === 0
            ? 'No inspectable refusal yet. The launch-day refusal (a 0.50 USDC payment above autoApproveMax) was a simulation that returned the contract\'s typed AboveAutoApprove error and broadcast nothing, so it has no hash and is not counted. A refusal counts once it is a reverted vault transaction with a hash, or a DENY verdict that stopped a payment before signing with an audit entry anyone can open.'
            : `${refusalKindsShown} of the ${ARC_SEASON_TARGETS.inspectableRefusals} kinds committed to: ${byKind['vault-policy-on-chain']} vault-policy refusal(s) on chain and ${byKind['deny-before-signing']} DENY result(s) stopped before signing, read from the public flow records. The launch-day simulated refusal is not among them.` +
              (recordedReverts.length > REFUSAL_ITEMS_SHOWN ? ` ${recordedReverts.length - REFUSAL_ITEMS_SHOWN} more recorded revert(s) are on checks.items.` : '') +
              (recordedDenials.length > REFUSAL_ITEMS_SHOWN ? ` ${recordedDenials.length - REFUSAL_ITEMS_SHOWN} more DENY record(s) are on checks.items.` : '') +
              (deniesUnderOldRule.length > 0
                ? ` ${deniesUnderOldRule.length} recorded DENY result(s), dated before ${RISK_RULE_CHANGED_ON}, name ${namedUnderOldRule.join(' and ')}, which holds no platform record. Each stands as it was answered, and was correct under the rule of its day, when a payee with no platform record got DENY. That rule changed on ${RISK_RULE_CHANGED_ON}: such a payee now gets WARN, so a reviewer who checks ${namedUnderOldRule.length === 1 ? 'that wallet' : 'those wallets'} again today sees WARN. Nothing recorded here was changed, and no count moved.`
                : '')),
      },
      evidence: ARC_SEASON_EVIDENCE_URL,
    },
    milestone2: {
      title: 'First external agents verifying and paying on Arc Mainnet',
      due: ARC_SEASON_PROGRAM.milestone2Due,
      externalTeamsLive: {
        count: liveTeams.length,
        target: ARC_SEASON_TARGETS.externalTeamsLive,
        ...flagIncomplete(settlementsIncomplete),
        teams,
        note:
          settlementsCaveat +
          (liveTeams.length === 0
            ? `${settlementsIncomplete ? '' : 'No external team live yet. '}A team is listed only after its wallet has paid a check on Arc Mainnet; the wallet is then attributed here by name.`
            : `${liveTeams.length} of ${ARC_SEASON_TARGETS.externalTeamsLive} external teams have paid at least one check on Arc Mainnet from a wallet attributed to them: ${teamDays
                .map((d) => `${d.team}, ${withUnit(teams.filter((t) => t.team === d.team).reduce((n, t) => n + t.checks, 0), 'check', 'checks')} from ${withUnit(teams.filter((t) => t.team === d.team).length, 'wallet', 'wallets')}`)
                .join('; ')}. That is all this row means: a team counts once one of its wallets has paid one check, and it says nothing about how much a team uses it.${teamFlowCount === 0 && !flowsIncomplete ? ' No named team has run a verify-then-pay flow yet.' : ''}`),
      },
      externalChecks: {
        count: externalChecks.length,
        target: ARC_SEASON_TARGETS.externalChecks,
        ...flagIncomplete(settlementsIncomplete),
        ...flagTeamKeys(externalChecks.length),
        payers,
        note:
          settlementsCaveat +
          (externalChecks.length === 0
            ? settlementsIncomplete
              ? 'A check counts here when a wallet outside our own paid it, on either rail.'
              : 'No paid check from a wallet outside our own yet. Every check settled so far came from our own buyer wallets, labeled internal above.'
            : `${externalChecks.length} of ${ARC_SEASON_TARGETS.externalChecks} paid checks from wallets A-Identity does not control, on either rail. ${payers.summary} By who stands behind them: ${whoPaidClauses.join('; ')}.${partyLines.join('')}`) +
          (externalVaultOwners > 0
            ? ` ${externalVaultOwners} of these wallet(s) also own a vault admitted with the owner not identified, so one could be a team member's: the chain cannot say, and each counts as external until someone says otherwise.`
            : '') +
          (externalAgentKeys > 0
            ? ` ${externalAgentKeys} of these wallet(s) are the agent key on a flow through a vault admitted with the owner not identified, so one could be a team member's: the chain cannot say, and each counts as external until someone says otherwise.`
            : '') +
          teamKeysCaveat(externalChecks.length),
      },
      teamActiveOnSeveralDays: {
        count: severalDays.length,
        target: ARC_SEASON_TARGETS.teamsActiveOnSeveralDays,
        ...flagIncomplete(settlementsIncomplete),
        teams: severalDays,
        byTeam: teamDays,
        // The dates are stated because two UTC dates can be hours apart, and a reader should judge that.
        note:
          settlementsCaveat +
          (severalDays.length === 0
            ? settlementsIncomplete
              ? 'A team counts here once its wallets, taken together, have paid on two or more distinct UTC days.'
              : 'No external team has paid on two or more distinct UTC days yet.'
            : `${severalDays.length} external team(s) paid on two or more distinct UTC days, counted across all of a team's wallets: ${teamDays
                .filter((t) => t.activeDays.length >= 2)
                .map((t) => `${t.team} on ${datesPlainly(t.activeDays, t.firstTs, t.lastTs)}`)
                .join('; ')}.`) +
          unattributed
            .filter((w) => w.activeDays.length >= 2)
            .map((w) => ` Wallet ${w.wallet} paid on ${datesPlainly(w.activeDays, w.firstTs, w.lastTs)}, and is attributed to no team, so it does not count here.`)
            .join(''),
      },
      publicReference: {
        count: publicNames.length,
        target: ARC_SEASON_TARGETS.publicReferences,
        ...flagIncomplete(settlementsIncomplete),
        names: publicNames,
        note:
          settlementsCaveat +
          (publicNames.length === 0
            ? `${settlementsIncomplete ? '' : 'No external integration can be named in public yet. '}A team is counted here only when it has paid and has agreed to be referenced.`
            : `${publicNames.length} external integration(s) that paid and agreed to be referenced in public: ${publicNames
                .map((name) => {
                  const namedWith = partners.find((p) => p.team === name && p.namedWith)?.namedWith
                  return namedWith ? `${name}, with ${namedWith}` : name
                })
                .join('; ')}. The reference is this page and the Milestone 2 report, where each is named as an integration; no other public page is linked here.`),
      },
      externalFlows: {
        count: externalFlowItems.length,
        linked: { paid: externalPaid.length, refused: externalRefused },
        items: externalFlowItems,
        ...flagIncomplete(flowsIncomplete),
        note:
          (flowsIncomplete ? 'The Circle Gateway settlement log or the verify-then-pay flow log could not be read on this request, so this list may be short. ' : '') +
          (externalFlowItems.length === 0
            ? `${flowsIncomplete ? '' : 'No external verify-then-pay flow has reached a vault payment or a refusal yet. '}A flow appears here when a wallet outside our own pays a Circle Gateway check and the route then records its vault payment or a refusal. A payment waiting for its owner has a public record at its flow URL and counts as neither until the owner acts. An external check with no flow here still counts as a paid check above.`
            : `${withUnit(externalFlowItems.length, 'verify-then-pay flow', 'verify-then-pay flows')} opened by a check from a wallet A-Identity does not control, by the same linking rules as Milestone 1 and counted apart from it: ${externalPaid.length} paid and ${externalRefused} refused${externalRefused > 0 ? ', and a refused flow paid nothing' : ''}.${paidClauses.length > 0 ? ` Of the flows that paid: ${paidClauses.join('; ')}.` : ''}`),
      },
      unattributed: {
        wallets: unattributed.length,
        checks: unattributed.reduce((s, w) => s + w.checks, 0),
        ...flagTeamKeys(unattributed.length),
        note:
          unattributed.length === 0
            ? settlementsIncomplete
              ? `The ${unreadableSettlementLogs.join(' and the ')} could not be read on this request, so this says nothing about wallets it holds.`
              : 'Every external wallet that paid is attributed to a team, or none has paid.'
            : `${unattributed.length} external wallet(s) paid ${unattributed.reduce((s, w) => s + w.checks, 0)} check(s) without being attributed to a team. They count as external checks, external wallets and external flows, and toward no team metric.${unattributedSaid}${teamKeysCaveat(unattributed.length)}`,
      },
    },
    afterProgram: {
      activeExternalWallets: {
        count: activeWallets.length,
        target: ARC_SEASON_TARGETS.activeExternalWallets,
        ...flagIncomplete(settlementsIncomplete),
        ...flagTeamKeys(activeWallets.length),
        windowDays: ARC_SEASON_TARGETS.activeWindowDays,
        since,
        wallets: activeWallets,
        parties: settlementsIncomplete ? null : activeParties.length,
        linkedSummary: activeLinkedSummary,
      },
      weekly: {
        ...flagIncomplete(settlementsIncomplete),
        ...flagTeamKeys(weekly.weeks.length),
        ...weekly,
        note:
          settlementsCaveat +
          (weekly.weeks.length === 0
            ? `${settlementsIncomplete ? '' : 'No external check to report by week yet. '}Each UTC week will list its external checks, active wallets, active days and the wallets that came back from an earlier week.`
            : `External use per UTC week, Monday to Sunday, from the first external check to this read, on either rail. Active wallets are wallets, not parties: a team or a linked party that pays from two wallets counts twice. A wallet is a repeat wallet when it paid in two or more different weeks, and a team when its wallets did: ${weekly.repeatWallets.length} wallet(s) and ${weekly.repeatTeams.length} team(s) so far.${teamKeysCaveat(weekly.weeks.length)}`),
      },
      note: `After the program the reference is ${ARC_SEASON_TARGETS.activeExternalWallets} external wallets with a settled check inside the last ${ARC_SEASON_TARGETS.activeWindowDays} days, measured on a rolling window from the time of each read. This number is that window as of this read, not the measurement itself, which starts after ${ARC_SEASON_PROGRAM.measuredThrough}. ${activeLinkedSummary}${teamKeysCaveat(activeWallets.length)}`,
    },
    linkedWallets: {
      tracedOn: ARC_LINK_TRACE.tracedOn,
      reads: ARC_LINK_TRACE.reads,
      groups: walletLinks.map((l) => ({ ...l, evidence: linkEvidence(l.evidence, chain) })),
      ourSide: ourSideLinks.map((x) => ({ ...x, evidence: linkEvidence(x.evidence ?? [], chain) })),
      limits: ARC_LINK_TRACE.limits,
    },
    note: `Targets are the Deliverable 1 commitments as revised by Circle on 2026-10-19; counts are read from the settlement logs and the admitted vault list on every request, and the curated lists (vaults, refusals, partners) fill only when the evidence exists. Links between wallets are curated as well: traced by hand on a date, not read live, and they move no count. The date on each milestone is the target the team set; the program measures them through ${ARC_SEASON_PROGRAM.measuredThrough}, its last day, and traction can extend past that.`,
  }
}
