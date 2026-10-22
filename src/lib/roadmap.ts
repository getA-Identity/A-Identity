/**
 * The roadmap, as data.
 *
 * One file feeds two surfaces: /roadmap (routes/Roadmap.tsx) and the ROADMAP.md at the
 * repository root, which scripts/gen-roadmap.mjs generates from this file and
 * `npm run check:roadmap` keeps current. The rules the roadmap keeps are ROADMAP_PRINCIPLES
 * below, and the generator enforces the ones a script can check: a shipped item has a date
 * and evidence, a committed item has a due date, and next and later carry no date at all.
 *
 * READ BY A SCRIPT WITHOUT A COMPILER. gen-roadmap.mjs does not import this module; it
 * slices each `export const NAME ... = <literal>` below out of the source text and evaluates
 * the literal as plain JavaScript. So inside the exported literals: single-quoted strings,
 * no template literals, no references to other constants, no `as const` or `satisfies`,
 * and the closing bracket of each exported array on its own line at column 0. The types and
 * the helpers under the data are free to use anything; the script never reads them.
 *
 * Every shipped item traces to a commit or to the provenance ledger
 * (mcp/src/chains/provenance.ts); the chain facts come from the generated registry mirror
 * (lib/chains.ts) at render time and are never typed here.
 */
import type { ChainId } from './chains'

export type RoadmapStatus = 'shipped' | 'in-progress' | 'committed' | 'next' | 'later'

export type RoadmapTrackId =
  | 'identity'
  | 'spending-limits'
  | 'payment-rails'
  | 'chains'
  | 'platform'
  | 'trust-security'
  | 'ecosystem'

export type RoadmapStatusMeta = { id: RoadmapStatus; label: string; rule: string }

export type RoadmapTrack = { id: RoadmapTrackId; label: string; blurb: string }

/**
 * A place to check a claim. `href` takes one of three shapes, resolved by `resolveEvidence`
 * here and by the same rule in scripts/gen-roadmap.mjs:
 *   - a path on this site, starting with a slash (`/proof/arc`, `/api/arc/season`);
 *   - an absolute https URL (a docs page, a program page);
 *   - a path in this repository (`mcp/src/cctp-stellar.ts`), which the page turns into a
 *     GitHub link and the generated ROADMAP.md leaves relative, so GitHub resolves it.
 */
export type RoadmapLink = { label: string; href: string }

export type RoadmapItem = {
  id: string
  title: string
  /** One or two lines. The card shows it whole; `details` folds. */
  summary: string
  status: RoadmapStatus
  track: RoadmapTrackId
  /** The UTC day it landed, ISO. Required when shipped, and only then. */
  date?: string
  /** The due date in the program agreement, ISO. Committed items only. */
  due?: string
  evidence?: RoadmapLink[]
  /** Registry ids, where a chain is the point of the item. */
  chains?: ChainId[]
  /** The longer text, for the fold and for the markdown. */
  details?: string
}

/** The day this data was last revised. The page's dateline and the markdown header. */
export const ROADMAP_UPDATED = '2026-10-22'

export const ROADMAP_SITE = 'https://a-identity.xyz'

/** The same repository as SOCIALS.github in brand.ts, restated because the generator
 *  cannot follow an import. */
export const ROADMAP_REPO = 'https://github.com/getA-Identity/A-Identity'

export const ROADMAP_PRINCIPLES: readonly string[] = [
  'Dates appear only on things that already happened. Nothing in Next or Later carries a target date, because a date we cannot keep is worth less than an honest ordering.',
  'Shipped means on chain or in the repository, with the day it landed and a place to check it: a proof page, a transaction, a file.',
  'In progress means work is underway now. Committed means a dated program milestone we signed, with its live progress published rather than promised.',
  'Chain counts and statuses are read from the chain registry, never typed on this page.',
  'The same data renders this page and the ROADMAP.md on GitHub, so the two cannot drift.',
]

export const ROADMAP_STATUSES: readonly RoadmapStatusMeta[] = [
  {
    id: 'shipped',
    label: 'Shipped',
    rule: 'On chain or in the repository, with the day it landed and a place to check it.',
  },
  {
    id: 'in-progress',
    label: 'In progress',
    rule: 'Work underway now. No completion date, on purpose.',
  },
  {
    id: 'committed',
    label: 'Committed',
    rule: 'A program milestone we signed, with the due date in the agreement. Progress is published live, not promised.',
  },
  {
    id: 'next',
    label: 'Next',
    rule: 'What follows the current work, in order and undated.',
  },
  {
    id: 'later',
    label: 'Later',
    rule: 'Direction, undated. Known and wanted, not scheduled.',
  },
]

export const ROADMAP_TRACKS: readonly RoadmapTrack[] = [
  {
    id: 'identity',
    label: 'Identity',
    blurb: 'Passports, registries and KYA: who an agent is, read live rather than typed.',
  },
  {
    id: 'spending-limits',
    label: 'Spending limits',
    blurb: 'The AgentSpendPolicy vaults and session keys: caps enforced where the money sits.',
  },
  {
    id: 'payment-rails',
    label: 'Payment rails',
    blurb: 'x402 facilitators, Circle Gateway nanopayments, CCTP, and the rails still to come.',
  },
  {
    id: 'chains',
    label: 'Chains',
    blurb: 'Networks entering the registry, and the bar each one met before it was called live.',
  },
  {
    id: 'platform',
    label: 'Platform and console',
    blurb: 'The site, the console, the API and the docs that people and agents use.',
  },
  {
    id: 'trust-security',
    label: 'Trust and security',
    blurb: 'Audits, proofs, hardening, and the ops work that keeps the claims true.',
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    blurb: 'Programs, listings and partners: where the product meets other teams.',
  },
]

/** Where a reader goes to change this list. The Discord invite is the permanent one
 *  brand.ts publishes as SOCIALS.discord. */
export const ROADMAP_INFLUENCE: readonly RoadmapLink[] = [
  { label: 'Open a GitHub issue', href: 'https://github.com/getA-Identity/A-Identity/issues' },
  { label: 'Find us in Discord', href: 'https://discord.gg/ak4rC3p7Tz' },
  { label: 'Talk to the founders', href: '/contact' },
  { label: 'The rule for new chains', href: 'CONTRIBUTING.md' },
]

export const ROADMAP_ITEMS: readonly RoadmapItem[] = [
  // ── Shipped, newest first ──────────────────────────────────────────────────────────
  {
    id: 'manifesto-rebuilt',
    title: 'The manifesto, rebuilt as a reference',
    summary:
      'Four pillars, ten principles each tied to the mechanism that keeps it, the 2026 landscape read against dated sources, and four refusals the code enforces.',
    status: 'shipped',
    track: 'platform',
    date: '2026-10-22',
    evidence: [{ label: 'Read the manifesto', href: '/manifesto' }],
    details:
      'Written for investors, grant programs, partners and researchers as much as for developers. Every landscape row states only what we could verify, with the date we read it, and the section is a map of approaches rather than a scoreboard.',
  },
  {
    id: 'feedback-widget',
    title: 'A feedback button on every page',
    summary:
      'A note from any page, the console included, reaches the team inbox. The widget says it was delivered only after the email provider accepted it, and falls back to a mailto link when the server holds no key.',
    status: 'shipped',
    track: 'platform',
    date: '2026-10-22',
    evidence: [
      { label: 'The server side', href: 'mcp/src/feedback.ts' },
      { label: 'The widget', href: 'src/components/FeedbackWidget.tsx' },
    ],
  },
  {
    id: 'stats-proof-one-list',
    title: '/stats and /proof read one list of settlement logs',
    summary:
      'The two pages used to carry their own lists of which logs exist and drifted apart. One module now feeds both, and a log that fails to answer is an error on the page, never a zero.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-10-22',
    evidence: [
      { label: 'Network stats', href: '/stats' },
      { label: 'The proof index', href: '/proof' },
      { label: 'The shared spec', href: 'src/lib/settlement-logs.ts' },
    ],
  },
  {
    id: 'arc-season-report',
    title: 'Arc Acceleration Season progress, computed from the logs',
    summary:
      'GET /api/arc/season reports progress against each success metric from the settlement logs on every request, external usage counted apart from our own. /proof/arc shows the block, and the partner guide tells a team how to be counted.',
    status: 'shipped',
    track: 'ecosystem',
    date: '2026-10-19',
    chains: ['arc-mainnet'],
    evidence: [
      { label: 'The live report', href: '/api/arc/season' },
      { label: 'Arc proof', href: '/proof/arc' },
      { label: 'Partner guide', href: 'https://a-identity.mintlify.site/chains/arc-integration' },
    ],
    details:
      'The three lists a human curates (owner-held vaults, inspectable refusals, partner wallets) are exported as data and were empty on 2026-10-19: a vault counts only when its owner key is one we never held, a refusal only when a reviewer can inspect it, and a team only after its wallet has paid a check.',
  },
  {
    id: 'circle-alliance',
    title: 'Member of the Circle Alliance Program',
    summary:
      'The landing\'s Member of band and the footer line read one memberships list, and only programs that have admitted us are on it.',
    status: 'shipped',
    track: 'ecosystem',
    date: '2026-10-19',
    evidence: [
      { label: 'The program', href: 'https://www.circle.com/alliance-program' },
      { label: 'The band on the landing', href: '/' },
    ],
  },
  {
    id: 'proof-reread-2026-10-11',
    title: 'Every proof surface re-read against its chain',
    summary:
      'Each provenance entry was read live again on 2026-10-11 and the caveats moved with the facts: the ERC-8004 family\'s ValidationRegistry is deployed on six mainnets but not wired, so KYA stays off-chain everywhere we sell, and X Layer sells nothing since the OKX.AI delisting.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-10-11',
    chains: ['arc-mainnet', 'base', 'arbitrum', 'rhchain', 'xlayer', 'celo', 'stellar'],
    evidence: [{ label: 'The proof index', href: '/proof' }],
  },
  {
    id: 'stellar-sow2-d3',
    title: 'Stellar SoW 2, D3: an owner action signed by a device passkey',
    summary:
      'A passkey created in the browser is the one signer of a smart account, under our verifier instance of OpenZeppelin\'s audited v0.7.2 code, and that account owns the vault. The owner froze it with the passkey and paid no fee.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-10-04',
    chains: ['stellar-testnet'],
    evidence: [
      { label: 'The passkey vault page', href: '/stellar?network=testnet' },
      { label: 'Stellar proof', href: '/proof/stellar' },
      { label: 'Why D3 was chosen', href: 'https://a-identity.mintlify.site/chains/stellar-d3-selection' },
      { label: 'The recovery position', href: 'https://a-identity.mintlify.site/chains/stellar-passkey-recovery' },
    ],
    details:
      'The smart account and the vault were published in the accounts table before any owner action. The 2026-09-19 passkey runs were rehearsals driven by software keys in our own script and are labeled as such; D3 is the first owner action on this ledger signed by a device we do not control. The owner\'s attempt to add a second device did not reach the ledger, so the account still has one signer, which the recovery page says plainly.',
  },
  {
    id: 'stellar-sow2-d2',
    title: 'Stellar SoW 2, D2: owner actions from a browser wallet',
    summary:
      'The D2 vault\'s owner, a key generated inside Freighter, froze the vault and withdrew from it in the live panel, each transaction signed whole in the wallet. The owner key was published before any owner action.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-10-03',
    chains: ['stellar-testnet'],
    evidence: [
      { label: 'Stellar proof', href: '/proof/stellar' },
      { label: 'Build on Stellar', href: 'https://a-identity.mintlify.site/chains/stellar' },
    ],
    details:
      'The vault runs the v0.1.1 code, instantiated against the code entry already on the ledger rather than re-uploaded. Testnet resets periodically, so a D2 vault is evidence that the flow works on the ledger at the time shown; the hashes and dates are what survive a reset.',
  },
  {
    id: 'stellar-sow2-d1',
    title: 'Stellar SoW 2, D1: a live, read-only vault panel',
    summary:
      '/app/vault/stellar reads any AgentSpendPolicy vault by contract address with no wallet and no account, every value stamped with the ledger it was read at.',
    status: 'shipped',
    track: 'platform',
    date: '2026-10-03',
    chains: ['stellar-testnet', 'stellar'],
    evidence: [
      { label: 'Open the live vault panel', href: '/app/vault/stellar' },
      { label: 'Stellar proof', href: '/proof/stellar' },
    ],
    details:
      'Checked the same day against the raw ledger storage of the flagship testnet vault and the D2 vault: every policy field and both balances matched. The panel sits in the console shell but outside the sign-in gate, because a vault\'s state is a public read.',
  },
  {
    id: 'evm-vault-foundry',
    title: 'The EVM vault gets a Foundry suite, and CI proves the suite notices',
    summary:
      'Unit, fuzz and invariant tests for AgentSpendPolicy.sol, plus a control job that deletes each guard in a temporary copy and requires the suite to turn red.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-10-03',
    evidence: [
      { label: 'The suite', href: 'mcp/test-sol' },
      { label: 'The workflow', href: '.github/workflows/solidity.yml' },
    ],
  },
  {
    id: 'soroban-v011',
    title: 'Soroban vault v0.1.1: one refusal ladder for pay, owner_pay and withdraw',
    summary:
      'settle checks the amount first, so the three entrypoints refuse in the same order (audit finding A3-02). The code entry is on testnet and new testnet vaults instantiate against it instead of re-uploading the wasm.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-10-02',
    chains: ['stellar-testnet'],
    evidence: [
      { label: 'The release record', href: 'soroban/releases/stellar-testnet-v0.1.1-2026-10-03.json' },
      { label: 'Stellar proof', href: '/proof/stellar' },
    ],
  },
  {
    id: 'check-robinhood-arbitrum',
    title: '/check/robinhood and /check/arbitrum: is it the real USDG, and who gets paid',
    summary:
      'Before an agent pays an x402 challenge on Robinhood Chain or Arbitrum One, one box answers whether the offered token is the real USDG or USDC and names the payee. A chain read that does not come back decides nothing.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-10-01',
    chains: ['rhchain', 'arbitrum'],
    evidence: [
      { label: 'Check on Robinhood Chain', href: '/check/robinhood' },
      { label: 'Check on Arbitrum One', href: '/check/arbitrum' },
    ],
  },
  {
    id: 'evm-vault-keys-separated',
    title: 'Agent keys split from owner keys on the Robinhood Chain and Arbitrum One vaults',
    summary:
      'Both vaults have a working agent key again, and it is no longer the owner key: the operator may only pay inside the policy, and the session keys are valid to 2026-11-15.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-10-01',
    chains: ['rhchain', 'arbitrum'],
    evidence: [
      { label: 'Robinhood Chain proof', href: '/proof/robinhood' },
      { label: 'Arbitrum One proof', href: '/proof/arbitrum' },
    ],
  },
  {
    id: 'trust-mcp-xlm',
    title: '@a-identity/trust-mcp: pay for a check with XLM from Claude Code',
    summary:
      'One prompt gives anyone\'s Claude Code a wallet of its own. A single XLM deposit on Stellar is turned into what the Algorand checks cost, and the buy command spends it on checks on its own; the agent picks what to check and nothing is paid for twice.',
    status: 'shipped',
    track: 'ecosystem',
    date: '2026-09-28',
    chains: ['stellar', 'algorand'],
    evidence: [
      { label: 'The package', href: 'trust-mcp' },
      { label: 'The MCP server', href: 'https://a-identity.mintlify.site/developers/mcp-server' },
    ],
  },
  {
    id: 'check-algorand',
    title: '/check: paste an Algorand address, get one answer',
    summary:
      'Before you pay an Algorand address, ask whether it looks safe: one box and one plain answer, written for someone who has never heard of an AI agent. The detailed report costs five dollars, bought from your own Algorand wallet, and the page says who pays.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-09-26',
    chains: ['algorand'],
    evidence: [
      { label: 'Run a check', href: '/check' },
      { label: 'Algorand on A-Identity', href: '/algorand' },
    ],
  },
  {
    id: 'arc-mainnet-vault-hardening',
    title: 'Arc Mainnet vault: agent key split from owner key, source verified',
    summary:
      'The vault\'s operator is a separate agent key, its source is verified on Sourcify as an exact match of creation and runtime bytecode, and settlements went through Arc\'s predeployed Memo and Multicall3From contracts with mainnet receipts.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-09-25',
    chains: ['arc-mainnet'],
    evidence: [{ label: 'Arc proof', href: '/proof/arc' }],
  },
  {
    id: 'stellar-rail-tooling',
    title: 'A SEP-1 stellar.toml, a Soroswap quote labeled as a quote, and the stock x402 payload',
    summary:
      'The Stellar rail accepts the payload shape a stock @x402/stellar client sends, the site publishes a stellar.toml that also states what it does not claim, and the passkey page quotes a swap off the Soroswap router live, saying plainly it is only a quote.',
    status: 'shipped',
    track: 'payment-rails',
    date: '2026-09-20',
    chains: ['stellar', 'stellar-testnet'],
    evidence: [
      { label: 'stellar.toml', href: '/.well-known/stellar.toml' },
      { label: 'The Stellar page', href: '/stellar' },
    ],
  },
  {
    id: 'passkey-vault-testnet',
    title: 'A WebAuthn passkey can own an on-chain spend vault',
    summary:
      '/stellar runs the passkey vault demo end to end in the browser on testnet: a passkey-owned smart account deploys and owns an AgentSpendPolicy vault, and every owner call dispatches to the account\'s __check_auth.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-09-19',
    chains: ['stellar-testnet'],
    evidence: [
      { label: 'The Stellar page', href: '/stellar' },
      { label: 'Build on Stellar', href: 'https://a-identity.mintlify.site/chains/stellar' },
    ],
    details:
      'The runs that day were rehearsals signed by a software P-256 key in our own script, and the proof page records them as such. The first owner action from a device passkey outside our systems is D3, on 2026-10-04.',
  },
  {
    id: 'arc-mainnet-live',
    title: 'Arc Mainnet live on the day it opened',
    summary:
      'Agent #0 on the canonical ERC-8004 registry, the registry\'s first mint, is ours. An AgentSpendPolicy vault holds real USDC under dust caps, and paid trust calls settled on both rails that day: our own EIP-3009 facilitator and Circle Gateway nanopayments.',
    status: 'shipped',
    track: 'chains',
    date: '2026-09-16',
    chains: ['arc-mainnet'],
    evidence: [
      { label: 'Arc on A-Identity', href: '/arc' },
      { label: 'Arc proof', href: '/proof/arc' },
    ],
    details:
      'Gas on Arc is USDC itself, so every cost on the proof page is an exact dollar figure with no price feed. The operating wallet was funded by burning native USDC on Base through CCTP V2 with Circle\'s Forwarding Service, which minted it on Arc without any Arc gas of ours. The chain entered the registry as its own descriptor and was live on the bar every other chain met.',
  },
  {
    id: 'stellar-ops-red-on-empty',
    title: 'The weekly Stellar ops job goes red on an empty vault',
    summary:
      'The pubnet vault was found empty, refilled, and its live policy documented. The weekly workflow now fails when a vault balance reads zero, alongside its warnings on archival, key-role overlap and allowlist drift.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-09-16',
    chains: ['stellar'],
    evidence: [
      { label: 'The workflow', href: '.github/workflows/stellar-ops.yml' },
      { label: 'Stellar proof', href: '/proof/stellar' },
    ],
  },
  {
    id: 'stellar-owner-controls',
    title: 'Stellar owner controls, a third-party registry read, and the ops calendar',
    summary:
      'The console shows live Soroban vault state and prepares the owner calls for the owner to sign with their own Stellar wallet, so the server never holds that key. A per-agent testnet vault is provisioned against the existing code entry, with pubnet gated behind an environment flag.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-09-15',
    chains: ['stellar', 'stellar-testnet'],
    evidence: [
      { label: 'Build on Stellar', href: 'https://a-identity.mintlify.site/chains/stellar' },
      { label: 'The key inventory', href: 'SECURITY.md' },
    ],
    details:
      'TrionLabs\' Stellar 8004 registry is read, read-only and labeled third-party: a pointer rather than an anchor. RPC reads fail over across the registry\'s fallback list while sendTransaction deliberately never does, the x402 fee is reported as bid and charged separately instead of as one number, and a weekly ops workflow warns on vault archival, key-role overlap and allowlist drift.',
  },
  {
    id: 'cctp-stellar-evm',
    title: 'CCTP between Stellar and EVM, proven both ways',
    summary:
      'Native USDC burned on Arc testnet and minted on Stellar testnet through Circle\'s CctpForwarder, and the reverse leg burned on Stellar and minted back on Arc, driven by our own code because Bridge Kit has no Stellar adapter.',
    status: 'shipped',
    track: 'payment-rails',
    date: '2026-09-10',
    chains: ['arc', 'stellar-testnet'],
    evidence: [
      { label: 'The driver', href: 'mcp/src/cctp-stellar.ts' },
      { label: 'Build on Stellar', href: 'https://a-identity.mintlify.site/chains/stellar' },
    ],
    details:
      'A Stellar recipient rides in the hook data, because a direct mint to an account is unrecoverable. Mainnet stays opt-in only, capped, and returns a labeled prepared no-op wherever the keys are absent.',
  },
  {
    id: 'wallet-signin-all-families',
    title: 'Wallet sign-in and linking on every chain family',
    summary:
      'An owner signs in, or links a wallet to an existing account, with an EVM personal_sign, a Stellar SEP-43 signMessage through Stellar Wallets Kit, or an Algorand signed zero-value self-payment. One account can carry wallets from several families at once.',
    status: 'shipped',
    track: 'identity',
    date: '2026-09-09',
    chains: ['base', 'stellar', 'algorand'],
    evidence: [{ label: 'Sign in', href: '/login' }],
    details:
      'This is what lets an EVM-anchored passport and a Stellar signing key belong to one owner.',
  },
  {
    id: 'algorand-live',
    title: 'Algorand went live on its first mainnet sale',
    summary:
      'The second non-EVM ecosystem, promoted the same day on a real payment: x402 v2 exact in native Circle USDC, the buyer signing a fee-zero transfer inside a pooled-fee atomic group through the GoPlausible facilitator, and no sale counted until our own indexer read returned the transfer.',
    status: 'shipped',
    track: 'chains',
    date: '2026-08-30',
    chains: ['algorand', 'algorand-testnet'],
    evidence: [
      { label: 'Algorand proof', href: '/proof/algorand' },
      { label: 'Algorand on A-Identity', href: '/algorand' },
    ],
    details:
      'The AgentSpendPolicy vault landed with it as the policy\'s third implementation (Solidity, then Rust on Soroban, now Algorand Python): no update or delete handler, real USDC under a 1 USDC daily cap, walked through the same settle-refuse-freeze-override ladder as the Stellar releases.',
  },
  {
    id: 'base-live',
    title: 'Base went live',
    summary:
      'Agent #73232 on the canonical ERC-8004 registries, deployed by their authors, and x402 settling in native Circle USDC through the same first-party EIP-3009 facilitator that serves Robinhood Chain and Arbitrum One.',
    status: 'shipped',
    track: 'chains',
    date: '2026-08-28',
    chains: ['base'],
    evidence: [{ label: 'Base proof', href: '/proof/base' }],
    details:
      'The operating wallets were funded from Stellar pubnet USDC through a NEAR Intents swap, and that funding trail is published rather than left as a gap. The canonical registry pair was verified by matching each proxy\'s implementation code against Arbitrum One, because Arc\'s three registry addresses also have code on Base and delegate to a non-canonical implementation.',
  },
  {
    id: 'stellar-x402-pubnet',
    title: 'The Stellar x402 rail sells on pubnet',
    summary:
      'First mainnet sale at ledger 64155370, 0.001 USDC through our own facilitator, the buyer signing a Soroban authorization entry and paying no fee.',
    status: 'shipped',
    track: 'payment-rails',
    date: '2026-08-27',
    chains: ['stellar'],
    evidence: [{ label: 'Stellar proof', href: '/proof/stellar' }],
    details:
      'Recorded with the part that did not work: two earlier attempts bid the 100-stroop minimum that testnet always accepts, lost pubnet\'s inclusion auction and sat invisible until they expired. The rail now bids the fee market\'s own rate with headroom. This is what turned stellar from a vault-only story into a selling rail.',
  },
  {
    id: 'invalidpayee-backport',
    title: 'The payee-validity gate backported to the Solidity vault',
    summary:
      'Audit finding G-1: the Soroban and Algorand ports refused a payee equal to the vault itself while the Solidity original accepted it and burned the cap against a payment that went nowhere. The Solidity now declares InvalidPayee and reverts with it in pay, ownerPay and withdraw.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-08-27',
    evidence: [{ label: 'The contract', href: 'mcp/contracts/AgentSpendPolicy.sol' }],
    details:
      'Three implementations of one policy model are a strength only while they agree, and on this gate they now do.',
  },
  {
    id: 'stellar-pubnet-vault',
    title: 'Stellar pubnet vault deployed, holding real USDC',
    summary:
      'The same wasm as testnet, byte for byte, holding real Circle USDC under a 1 USDC daily cap and a 0.25 USDC auto-approve ceiling, an order of magnitude under the testnet vault because this one holds real money.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-08-24',
    chains: ['stellar'],
    evidence: [{ label: 'Stellar proof', href: '/proof/stellar' }],
    details:
      'Four settlements, a freeze and unfreeze pair, and an owner override are on the ledger, with spent_today coming to rest exactly at the cap. The owner account was raised to a 2-of-3 multisig on 2026-08-25, after an audit finding pointed out that a permanent owner behind a single key is a single point of total loss.',
  },
  {
    id: 'stellar-testnet-rail',
    title: 'The Stellar testnet rail went end to end',
    summary:
      'AgentSpendPolicy in Rust on Soroban (daily cap, auto-approve ceiling, allowlist, freeze, session key, typed errors, no upgrade entrypoint), plus our own Soroban x402 facilitator settling in SEP-41 USDC with the buyer paying no network fee.',
    status: 'shipped',
    track: 'payment-rails',
    date: '2026-08-15',
    chains: ['stellar-testnet'],
    evidence: [
      { label: 'Stellar proof', href: '/proof/stellar' },
      { label: 'The artifacts, as JSON', href: '/api/proof/stellar' },
    ],
    details:
      'Both halves are on the ledger: an under-limit payment settled and an over-limit one was refused on chain with DailyCapExceeded. The first non-EVM rail here, and the only one where the spend limit is enforced by a contract before the payment exists.',
  },
  {
    id: 'arbitrum-live',
    title: 'Arbitrum One went live',
    summary:
      'Agent #1259 on the canonical ERC-8004 registry, and x402 settling in native Circle USDC through our own EIP-3009 facilitator, with a per-chain fee derived from measured gas rather than guessed.',
    status: 'shipped',
    track: 'chains',
    date: '2026-08-13',
    chains: ['arbitrum'],
    evidence: [{ label: 'Arbitrum One proof', href: '/proof/arbitrum' }],
  },
  {
    id: 'robinhood-live',
    title: 'Robinhood Chain live, with agent #0',
    summary:
      'The canonical identity and reputation registries verified live on mainnet, and agent #0, the registry\'s first mint, is ours since 2026-08-12. Mainnet went live on 2026-08-13 once the x402 rail settled there in USDG, because the chain publishes no canonical Circle USDC.',
    status: 'shipped',
    track: 'chains',
    date: '2026-08-13',
    chains: ['rhchain', 'rhchain-testnet'],
    evidence: [
      { label: 'Robinhood Chain proof', href: '/proof/robinhood' },
      { label: 'Check on Robinhood Chain', href: '/check/robinhood' },
    ],
    details:
      'The testnet came first, on 2026-08-11: the full canonical registry set is live there, with the missing ValidationRegistry implementation deployed by replaying the canonical Safe Singleton Factory calldata, and agent #0 minted there too. It stays beta as the rehearsal rail.',
  },
  {
    id: 'celo-live',
    title: 'Celo mainnet live',
    summary:
      'ERC-8004 identity and reputation reads wired, agent #9759, and the trust tools selling over the first-party Celo x402 facilitator in native USDC, with gas payable in stablecoins.',
    status: 'shipped',
    track: 'chains',
    date: '2026-08-09',
    chains: ['celo', 'celo-sepolia'],
    evidence: [
      { label: 'The Celo settlement log', href: '/celo-proof' },
      { label: 'Celo proof', href: '/proof/celo' },
    ],
  },
  {
    id: 'spend-preflight',
    title: 'Spend preflight and a velocity circuit breaker',
    summary:
      'A dry run of the whole policy ladder with zero mutation, so a payment can be asked whether it would pass before anything is signed, and a brake on burst spending that trips on velocity rather than on the cap alone.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-08-09',
    evidence: [{ label: 'The policy module', href: 'mcp/src/policy/README.md' }],
  },
  {
    id: 'merchant-check',
    title: 'merchant_check: counterparty verification for agentic checkouts',
    summary:
      'Commerce-grade verification of a merchant-side agent before a checkout, as an MCP tool and over REST, returning ALLOW, WARN or DENY with reasons.',
    status: 'shipped',
    track: 'trust-security',
    date: '2026-08-09',
    evidence: [{ label: 'The MCP server', href: 'https://a-identity.mintlify.site/developers/mcp-server' }],
  },
  {
    id: 'platform-split',
    title: 'The backend split into layered platform/ and http/ modules',
    summary:
      'Two monoliths became a layered platform with route-group handlers, the layer graph enforced by a test, and a unit suite whose size is asserted by a test rather than quoted here.',
    status: 'shipped',
    track: 'platform',
    date: '2026-08-09',
    evidence: [
      { label: 'The layering test', href: 'mcp/src/platform/layering.test.ts' },
      { label: 'The module map', href: 'mcp/README.md' },
    ],
  },
  {
    id: 'marketplace-escrow',
    title: 'A trusted agent marketplace on Arc: verify, hire, work, release',
    summary:
      'Hire a verified agent with the payment held in an ERC-8183 escrow on Arc testnet until the work is delivered and released, with a composite leaderboard and public agent certificates.',
    status: 'shipped',
    track: 'ecosystem',
    date: '2026-07-19',
    chains: ['arc'],
    evidence: [
      { label: 'The marketplace module', href: 'mcp/src/marketplace.ts' },
      { label: 'The Trust Explorer', href: '/explorer' },
    ],
  },
  {
    id: 'vault-session-keys',
    title: 'Session keys, the Arc Memo audit trail, and Multicall3From batch settlement',
    summary:
      'Time-bounded session keys, both vault-native and as a real ERC-4337 UserOp through a Kernel smart account; an on-chain Memo entry for every agent settlement; and batched settlement in one atomic transaction through Arc\'s Multicall3From.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-07-19',
    chains: ['arc'],
    evidence: [
      { label: 'The contract', href: 'mcp/contracts/AgentSpendPolicy.sol' },
      { label: 'Arc proof', href: '/proof/arc' },
    ],
  },
  {
    id: 'okx-trust-oracle',
    title: 'The paid Trust Oracle listed on OKX.AI, on X Layer',
    summary:
      'Six paid x402 tools plus a free preview, sold through OKX\'s x402 layer in USDT0 on X Layer mainnet: 120 real settlements between 2026-07-17 and 2026-07-24, every one paid by our own buyer wallet, published with transaction hashes.',
    status: 'shipped',
    track: 'ecosystem',
    date: '2026-07-17',
    chains: ['xlayer'],
    evidence: [
      { label: 'The settlement proof', href: 'https://a-identity-asp.onrender.com/proof' },
      { label: 'The proof index', href: '/proof' },
    ],
    details:
      'OKX.AI delisted the listing on 2026-09-26. The gateway answers in free mode and nothing sells on X Layer now; the identity reads there stay live.',
  },
  {
    id: 'evm-vault-first',
    title: 'The first AgentSpendPolicy vault: on-chain spend limits on Arc',
    summary:
      'A per-agent vault whose caps, auto-approve ceiling, allowlist and freeze are enforced by the contract, so an agent\'s authority is bounded where the money sits rather than in a prompt.',
    status: 'shipped',
    track: 'spending-limits',
    date: '2026-07-10',
    chains: ['arc'],
    evidence: [{ label: 'The contract', href: 'mcp/contracts/AgentSpendPolicy.sol' }],
  },

  // ── In progress ────────────────────────────────────────────────────────────────────
  {
    id: 'fee-payer-separation',
    title: 'Separate the testnet fee payer from the testnet vault operator',
    summary:
      'The pubnet half is done: since 2026-09-15 the pubnet fee payer is a dedicated XLM-only account, proven by the production sale it broadcast, so the key that may call vault.pay no longer pays for every settlement. On testnet the two Stellar roles still share one key, which is test money.',
    status: 'in-progress',
    track: 'trust-security',
    chains: ['stellar-testnet'],
    evidence: [{ label: 'The key inventory', href: 'SECURITY.md' }],
  },
  {
    id: 'ops-hardening',
    title: 'Ops hardening: secret rotation, off the free tier, rate limits off process-local state',
    summary:
      'Post-event secret rotation, the backend off the free tier for demo reliability, and the rate-limit buckets out of process memory: the one piece of runtime state Postgres did not absorb, so a horizontally scaled deploy would still multiply every limit by the instance count.',
    status: 'in-progress',
    track: 'trust-security',
    evidence: [{ label: 'The rate buckets today', href: 'mcp/src/rate-budget.ts' }],
  },

  // ── Committed: program milestones with the due dates in the agreement ─────────────
  {
    id: 'arc-season-m1',
    title: 'Arc Acceleration Season M1: owner-held vaults from the browser, and verifyThenPay',
    summary:
      'Five AgentSpendPolicy vaults on Arc Mainnet deployed from the browser with an owner key A-Identity never holds, 100 verify-then-pay checks settled through Circle Gateway nanopayments, and two refusals anyone can inspect: a vault-policy revert with a hash, and a DENY that stopped a payment before signing.',
    status: 'committed',
    track: 'spending-limits',
    due: '2026-11-05',
    chains: ['arc-mainnet'],
    evidence: [
      { label: 'Live progress', href: '/proof/arc' },
      { label: 'The computed report', href: '/api/arc/season' },
      { label: 'Partner guide', href: 'https://a-identity.mintlify.site/chains/arc-integration' },
    ],
    details:
      'A vault counts only when its owner key is one we never held, so the launch-day vault, owned by our operating wallet, does not. The browser deployer is planned at /app/vault/arc. Targets are the Deliverable 1 commitments as Circle revised them on 2026-10-19; the counts are read from the settlement logs on every request, and the curated lists are empty until the evidence exists.',
  },
  {
    id: 'arc-season-m2',
    title: 'Arc Acceleration Season M2: the first external agents verifying and paying on Arc Mainnet',
    summary:
      'Two external teams live, 30 paid checks from wallets we do not control, one team active on more than one day, and one integration we may reference in public.',
    status: 'committed',
    track: 'ecosystem',
    due: '2026-11-06',
    chains: ['arc-mainnet'],
    evidence: [
      { label: 'Live progress', href: '/proof/arc' },
      { label: 'The computed report', href: '/api/arc/season' },
      { label: 'Partner guide', href: 'https://a-identity.mintlify.site/chains/arc-integration' },
    ],
    details:
      'A wallet is external by default and attributed to a team by name only on request, and only after it has paid a check on Arc Mainnet. Deliverable 2, the progress report Circle judges, is due 2026-10-30 and is the same computed report.',
  },

  // ── Next: ordered, undated ─────────────────────────────────────────────────────────
  {
    id: 'mpp-session-mode',
    title: 'MPP session mode on the main backend',
    summary:
      'Open a funded session, make many vouchered trust checks, settle on close. Research and recommendation are done; the prototype follows the Arc x402 rail\'s durable-store discipline.',
    status: 'next',
    track: 'payment-rails',
  },
  {
    id: 'xlayer-sells-again',
    title: 'X Layer: a rail that sells again',
    summary:
      'Identity reads on X Layer are live; the paid listing was delisted on 2026-09-26 and nothing sells there now. The payment rail returns as one deliberate listing update, with the OKX payment-surface expansion (subscription-style monitoring, an escrow-gated tool, batched settlement) bundled into it.',
    status: 'next',
    track: 'payment-rails',
    chains: ['xlayer'],
  },
  {
    id: 'preflight-in-console',
    title: 'Spend preflight in the console',
    summary:
      'The API is live. The Permissions screen gets a would-this-pass panel that runs the whole ladder with zero mutation before anything is signed.',
    status: 'next',
    track: 'platform',
  },
  {
    id: 'non-evm-identity',
    title: 'A readable identity story for the non-EVM rails',
    summary:
      'ERC-8004 is EVM-only, so a passport on Stellar or Algorand is bridged from an EVM chain rather than anchored. The pointer half shipped on 2026-09-15: TrionLabs\' Stellar 8004 registry is read, read-only and labeled third-party, and A-Identity is agent 25 on its testnet instance.',
    status: 'next',
    track: 'identity',
    chains: ['stellar', 'algorand'],
    details:
      'Three things remain, and none of them is a registry of our own called a standard. Mainnet registration is blocked on the registry\'s owner, because their mainnet instance simulated as archived and restoring somebody else\'s contract is their call, not ours. Algorand still has no registry we can verify. And KYA remains unanchorable on both chains, which the point of sale has to keep saying out loud.',
  },

  // ── Later: direction, undated ──────────────────────────────────────────────────────
  {
    id: 'settlement-router',
    title: 'Cross-protocol settlement router',
    summary:
      'One quote layer answering 402s with the union of rails we accept (x402 exact, Nanopayments, MPP session) and routing settlement.',
    status: 'later',
    track: 'payment-rails',
  },
  {
    id: 'avalanche',
    title: 'Avalanche, the only planned entry in the registry',
    summary:
      'The descriptor is there and the canonical ERC-8004 identity and reputation registries are already live on the chain, deployed by their authors. What is missing is ours: an agent on them and a rail pointed at them. It stays planned until both exist, because a descriptor is not an integration.',
    status: 'later',
    track: 'chains',
    chains: ['avalanche'],
  },
  {
    id: 'sybil-cross-operator',
    title: 'Cross-operator Sybil detection',
    summary: 'Funder-graph provenance, beyond the same-operator wash detection the score already applies.',
    status: 'later',
    track: 'trust-security',
  },
  {
    id: 'per-party-escrow',
    title: 'Per-party escrow signing in the marketplace',
    summary:
      'Today the platform signer is the escrow party. Each party signing from its own wallet is the goal.',
    status: 'later',
    track: 'ecosystem',
  },
  {
    id: 'frontend-debt',
    title: 'Frontend debt',
    summary:
      'RegisterForm state to a single reducer, and the sitemap generator decoupled from the blog source text so content can be split freely.',
    status: 'later',
    track: 'platform',
  },
]

// ── Helpers. The generator never reads below this line. ──────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** `2026-10` or `2026-10-19` to `October 2026`. String work only, so the prerendered
 *  snapshot and the browser agree regardless of locale or zone. */
export function monthLabel(iso: string): string {
  const [year, month] = iso.split('-')
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`
}

export const statusMeta = (id: RoadmapStatus): RoadmapStatusMeta =>
  ROADMAP_STATUSES.find((s) => s.id === id) ?? { id, label: id, rule: '' }

export const trackMeta = (id: RoadmapTrackId): RoadmapTrack =>
  ROADMAP_TRACKS.find((t) => t.id === id) ?? { id, label: id, blurb: '' }

/** Shipped items, newest first. Same-day items keep their order in the file. */
export function shippedItems(items: readonly RoadmapItem[] = ROADMAP_ITEMS): RoadmapItem[] {
  return items
    .filter((i) => i.status === 'shipped')
    .slice()
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
}

export type ShippedMonth = { key: string; label: string; items: RoadmapItem[] }

/** Shipped items grouped by month, newest month first, for the timeline. */
export function shippedByMonth(items: readonly RoadmapItem[]): ShippedMonth[] {
  const months: ShippedMonth[] = []
  for (const item of shippedItems(items)) {
    const key = (item.date ?? '').slice(0, 7)
    const last = months[months.length - 1]
    if (last && last.key === key) last.items.push(item)
    else months.push({ key, label: monthLabel(key), items: [item] })
  }
  return months
}

export function countByStatus(items: readonly RoadmapItem[]): Record<RoadmapStatus, number> {
  const counts: Record<RoadmapStatus, number> = {
    shipped: 0,
    'in-progress': 0,
    committed: 0,
    next: 0,
    later: 0,
  }
  for (const item of items) counts[item.status] += 1
  return counts
}

export type EvidenceKind = 'route' | 'site-file' | 'external' | 'repo'

/**
 * Where an evidence link goes. A route is rendered through the router; a site file (an
 * API answer, a well-known document) and anything external open in a new tab; a
 * repository path becomes a GitHub link.
 */
export function resolveEvidence(href: string): { href: string; kind: EvidenceKind } {
  if (href.startsWith('https://')) return { href, kind: 'external' }
  if (href.startsWith('/api/') || href.startsWith('/.well-known/')) return { href, kind: 'site-file' }
  if (href.startsWith('/')) return { href, kind: 'route' }
  return { href: `${ROADMAP_REPO}/blob/main/${href}`, kind: 'repo' }
}
