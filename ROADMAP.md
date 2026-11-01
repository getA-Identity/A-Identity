# A-Identity roadmap

What shipped, what is underway, what we have committed to, and what comes next, in that
order. Dates appear on things that already happened and on the program milestones we
signed, nowhere else. Every shipped item names the day it landed and a place to check it.
The same data renders https://a-identity.xyz/roadmap.

Updated 2026-10-22.

## How to read this

- **Shipped**: On chain or in the repository, with the day it landed and a place to check
  it.
- **In progress**: Work underway now. No completion date, on purpose.
- **Committed**: A program milestone we signed, with the due date in the agreement.
  Progress is published live, not promised.
- **Next**: What follows the current work, in order and undated.
- **Later**: Direction, undated. Known and wanted, not scheduled.

The rules this document keeps:

1. Dates appear only on things that already happened. Nothing in Next or Later carries a
   target date, because a date we cannot keep is worth less than an honest ordering.
2. Shipped means on chain or in the repository, with the day it landed and a place to
   check it: a proof page, a transaction, a file.
3. In progress means work is underway now. Committed means a dated program milestone we
   signed, with its live progress published rather than promised.
4. Chain counts and statuses are read from the chain registry, never typed on this page.
5. The same data renders this page and the ROADMAP.md on GitHub, so the two cannot drift.

## At a glance

| Track | Shipped | In progress | Committed | Next | Later |
| --- | ---: | ---: | ---: | ---: | ---: |
| Identity | 1 | 0 | 0 | 1 | 0 |
| Spending limits | 12 | 0 | 1 | 0 | 0 |
| Payment rails | 4 | 0 | 0 | 2 | 1 |
| Chains | 6 | 0 | 0 | 0 | 1 |
| Platform and console | 4 | 0 | 0 | 1 | 1 |
| Trust and security | 7 | 2 | 0 | 0 | 1 |
| Ecosystem | 5 | 0 | 1 | 0 | 1 |
| **All tracks** | **39** | **2** | **2** | **4** | **5** |

Chains in the registry: 9 live (Arc Mainnet, Circle Arc (Testnet), Stellar, Algorand,
Base, Robinhood Chain, Arbitrum One, OKX X Layer, Celo), 4 beta (Stellar Testnet, Algorand
Testnet, Robinhood Chain Testnet, Celo Sepolia (Testnet)), 1 planned (Avalanche C-Chain).
Read from `mcp/src/chains/registry.ts` through its generated mirror, never typed here.

## Shipped

Newest first. Each item names the day it landed and where to check it.

### October 2026

- **The manifesto, rebuilt as a reference** (2026-10-22; Platform and console)

  Four pillars, ten principles each tied to the mechanism that keeps it, the 2026
  landscape read against dated sources, and four refusals the code enforces.

  Written for investors, grant programs, partners and researchers as much as for
  developers. Every landscape row states only what we could verify, with the date we read
  it, and the section is a map of approaches rather than a scoreboard.

  Evidence: [Read the manifesto](https://a-identity.xyz/manifesto).

- **A feedback button on every page** (2026-10-22; Platform and console)

  A note from any page, the console included, reaches the team inbox. The widget says it
  was delivered only after the email provider accepted it, and falls back to a mailto link
  when the server holds no key.

  Evidence: [The server side](mcp/src/feedback.ts), [The widget](src/components/FeedbackWidget.tsx).

- **/stats and /proof read one list of settlement logs** (2026-10-22; Trust and security)

  The two pages used to carry their own lists of which logs exist and drifted apart. One
  module now feeds both, and a log that fails to answer is an error on the page, never a
  zero.

  Evidence: [Network stats](https://a-identity.xyz/stats), [The proof index](https://a-identity.xyz/proof), [The shared spec](src/lib/settlement-logs.ts).

- **Arc Acceleration Season progress, computed from the logs** (2026-10-19; Ecosystem)

  GET /api/arc/season reports progress against each success metric from the settlement
  logs on every request, external usage counted apart from our own. /proof/arc shows the
  block, and the partner guide tells a team how to be counted.

  The three lists a human curates (owner-held vaults, inspectable refusals, partner
  wallets) are exported as data and were empty on 2026-10-19: a vault counts only when its
  owner key is one we never held, a refusal only when a reviewer can inspect it, and a
  team only after its wallet has paid a check.

  Chains: Arc Mainnet. Evidence: [The live report](https://a-identity.xyz/api/arc/season), [Arc proof](https://a-identity.xyz/proof/arc), [Partner guide](https://a-identity.mintlify.site/chains/arc-integration).

- **Member of the Circle Alliance Program** (2026-10-19; Ecosystem)

  The landing's Member of band and the footer line read one memberships list, and only
  programs that have admitted us are on it.

  Evidence: [The program](https://www.circle.com/alliance-program), [The band on the landing](https://a-identity.xyz/).

- **Every proof surface re-read against its chain** (2026-10-11; Trust and security)

  Each provenance entry was read live again on 2026-10-11 and the caveats moved with the
  facts: the ERC-8004 family's ValidationRegistry is deployed on six mainnets but not
  wired, so KYA stays off-chain everywhere we sell, and X Layer sells nothing since the
  OKX.AI delisting.

  Chains: Arc Mainnet, Base, Arbitrum One, Robinhood Chain, OKX X Layer, Celo, Stellar. Evidence: [The proof index](https://a-identity.xyz/proof).

- **Stellar SoW 2, D3: an owner action signed by a device passkey** (2026-10-04; Spending limits)

  A passkey created in the browser is the one signer of a smart account, under our
  verifier instance of OpenZeppelin's audited v0.7.2 code, and that account owns the
  vault. The owner froze it with the passkey and paid no fee.

  The smart account and the vault were published in the accounts table before any owner
  action. The 2026-09-19 passkey runs were rehearsals driven by software keys in our own
  script and are labeled as such; D3 is the first owner action on this ledger signed by a
  device we do not control. The owner's attempt to add a second device did not reach the
  ledger, so the account still has one signer, which the recovery page says plainly.

  Chains: Stellar Testnet. Evidence: [The passkey vault page](https://a-identity.xyz/stellar?network=testnet), [Stellar proof](https://a-identity.xyz/proof/stellar), [Why D3 was chosen](https://a-identity.mintlify.site/chains/stellar-d3-selection), [The recovery position](https://a-identity.mintlify.site/chains/stellar-passkey-recovery).

- **Stellar SoW 2, D2: owner actions from a browser wallet** (2026-10-03; Spending limits)

  The D2 vault's owner, a key generated inside Freighter, froze the vault and withdrew
  from it in the live panel, each transaction signed whole in the wallet. The owner key
  was published before any owner action.

  The vault runs the v0.1.1 code, instantiated against the code entry already on the
  ledger rather than re-uploaded. Testnet resets periodically, so a D2 vault is evidence
  that the flow works on the ledger at the time shown; the hashes and dates are what
  survive a reset.

  Chains: Stellar Testnet. Evidence: [Stellar proof](https://a-identity.xyz/proof/stellar), [Build on Stellar](https://a-identity.mintlify.site/chains/stellar).

- **Stellar SoW 2, D1: a live, read-only vault panel** (2026-10-03; Platform and console)

  /app/vault/stellar reads any AgentSpendPolicy vault by contract address with no wallet
  and no account, every value stamped with the ledger it was read at.

  Checked the same day against the raw ledger storage of the flagship testnet vault and
  the D2 vault: every policy field and both balances matched. The panel sits in the
  console shell but outside the sign-in gate, because a vault's state is a public read.

  Chains: Stellar Testnet, Stellar. Evidence: [Open the live vault panel](https://a-identity.xyz/app/vault/stellar), [Stellar proof](https://a-identity.xyz/proof/stellar).

- **The EVM vault gets a Foundry suite, and CI proves the suite notices** (2026-10-03; Trust and security)

  Unit, fuzz and invariant tests for AgentSpendPolicy.sol, plus a control job that deletes
  each guard in a temporary copy and requires the suite to turn red.

  Evidence: [The suite](mcp/test-sol), [The workflow](.github/workflows/solidity.yml).

- **Soroban vault v0.1.1: one refusal ladder for pay, owner_pay and withdraw** (2026-10-02; Spending limits)

  settle checks the amount first, so the three entrypoints refuse in the same order (audit
  finding A3-02). The code entry is on testnet and new testnet vaults instantiate against
  it instead of re-uploading the wasm.

  Chains: Stellar Testnet. Evidence: [The release record](soroban/releases/stellar-testnet-v0.1.1-2026-10-03.json), [Stellar proof](https://a-identity.xyz/proof/stellar).

- **/check/robinhood and /check/arbitrum: is it the real USDG, and who gets paid** (2026-10-01; Trust and security)

  Before an agent pays an x402 challenge on Robinhood Chain or Arbitrum One, one box
  answers whether the offered token is the real USDG or USDC and names the payee. A chain
  read that does not come back decides nothing.

  Chains: Robinhood Chain, Arbitrum One. Evidence: [Check on Robinhood Chain](https://a-identity.xyz/check/robinhood), [Check on Arbitrum One](https://a-identity.xyz/check/arbitrum).

- **Agent keys split from owner keys on the Robinhood Chain and Arbitrum One vaults** (2026-10-01; Spending limits)

  Both vaults have a working agent key again, and it is no longer the owner key: the
  operator may only pay inside the policy, and the session keys are valid to 2026-11-15.

  Chains: Robinhood Chain, Arbitrum One. Evidence: [Robinhood Chain proof](https://a-identity.xyz/proof/robinhood), [Arbitrum One proof](https://a-identity.xyz/proof/arbitrum).

### September 2026

- **@a-identity/trust-mcp: pay for a check with XLM from Claude Code** (2026-09-28; Ecosystem)

  One prompt gives anyone's Claude Code a wallet of its own. A single XLM deposit on
  Stellar is turned into what the Algorand checks cost, and the buy command spends it on
  checks on its own; the agent picks what to check and nothing is paid for twice.

  Chains: Stellar, Algorand. Evidence: [The package](trust-mcp), [The MCP server](https://a-identity.mintlify.site/developers/mcp-server).

- **/check: paste an Algorand address, get one answer** (2026-09-26; Trust and security)

  Before you pay an Algorand address, ask whether it looks safe: one box and one plain
  answer, written for someone who has never heard of an AI agent. The detailed report
  costs five dollars, bought from your own Algorand wallet, and the page says who pays.

  Chains: Algorand. Evidence: [Run a check](https://a-identity.xyz/check), [Algorand on A-Identity](https://a-identity.xyz/algorand).

- **Arc Mainnet vault: agent key split from owner key, source verified** (2026-09-25; Spending limits)

  The vault's operator is a separate agent key, its source is verified on Sourcify as an
  exact match of creation and runtime bytecode, and settlements went through Arc's
  predeployed Memo and Multicall3From contracts with mainnet receipts.

  Chains: Arc Mainnet. Evidence: [Arc proof](https://a-identity.xyz/proof/arc).

- **A SEP-1 stellar.toml, a Soroswap quote labeled as a quote, and the stock x402 payload** (2026-09-20; Payment rails)

  The Stellar rail accepts the payload shape a stock @x402/stellar client sends, the site
  publishes a stellar.toml that also states what it does not claim, and the passkey page
  quotes a swap off the Soroswap router live, saying plainly it is only a quote.

  Chains: Stellar, Stellar Testnet. Evidence: [stellar.toml](https://a-identity.xyz/.well-known/stellar.toml), [The Stellar page](https://a-identity.xyz/stellar).

- **A WebAuthn passkey can own an on-chain spend vault** (2026-09-19; Spending limits)

  /stellar runs the passkey vault demo end to end in the browser on testnet: a
  passkey-owned smart account deploys and owns an AgentSpendPolicy vault, and every owner
  call dispatches to the account's __check_auth.

  The runs that day were rehearsals signed by a software P-256 key in our own script, and
  the proof page records them as such. The first owner action from a device passkey
  outside our systems is D3, on 2026-10-04.

  Chains: Stellar Testnet. Evidence: [The Stellar page](https://a-identity.xyz/stellar), [Build on Stellar](https://a-identity.mintlify.site/chains/stellar).

- **Arc Mainnet live on the day it opened** (2026-09-16; Chains)

  Agent #0 on the canonical ERC-8004 registry, the registry's first mint, is ours. An
  AgentSpendPolicy vault holds real USDC under dust caps, and paid trust calls settled on
  both rails that day: our own EIP-3009 facilitator and Circle Gateway nanopayments.

  Gas on Arc is USDC itself, so every cost on the proof page is an exact dollar figure
  with no price feed. The operating wallet was funded by burning native USDC on Base
  through CCTP V2 with Circle's Forwarding Service, which minted it on Arc without any Arc
  gas of ours. The chain entered the registry as its own descriptor and was live on the
  bar every other chain met.

  Chains: Arc Mainnet. Evidence: [Arc on A-Identity](https://a-identity.xyz/arc), [Arc proof](https://a-identity.xyz/proof/arc).

- **The weekly Stellar ops job goes red on an empty vault** (2026-09-16; Trust and security)

  The pubnet vault was found empty, refilled, and its live policy documented. The weekly
  workflow now fails when a vault balance reads zero, alongside its warnings on archival,
  key-role overlap and allowlist drift.

  Chains: Stellar. Evidence: [The workflow](.github/workflows/stellar-ops.yml), [Stellar proof](https://a-identity.xyz/proof/stellar).

- **Stellar owner controls, a third-party registry read, and the ops calendar** (2026-09-15; Spending limits)

  The console shows live Soroban vault state and prepares the owner calls for the owner to
  sign with their own Stellar wallet, so the server never holds that key. A per-agent
  testnet vault is provisioned against the existing code entry, with pubnet gated behind
  an environment flag.

  TrionLabs' Stellar 8004 registry is read, read-only and labeled third-party: a pointer
  rather than an anchor. RPC reads fail over across the registry's fallback list while
  sendTransaction deliberately never does, the x402 fee is reported as bid and charged
  separately instead of as one number, and a weekly ops workflow warns on vault archival,
  key-role overlap and allowlist drift.

  Chains: Stellar, Stellar Testnet. Evidence: [Build on Stellar](https://a-identity.mintlify.site/chains/stellar), [The key inventory](SECURITY.md).

- **CCTP between Stellar and EVM, proven both ways** (2026-09-10; Payment rails)

  Native USDC burned on Arc testnet and minted on Stellar testnet through Circle's
  CctpForwarder, and the reverse leg burned on Stellar and minted back on Arc, driven by
  our own code because Bridge Kit has no Stellar adapter.

  A Stellar recipient rides in the hook data, because a direct mint to an account is
  unrecoverable. Mainnet stays opt-in only, capped, and returns a labeled prepared no-op
  wherever the keys are absent.

  Chains: Circle Arc (Testnet), Stellar Testnet. Evidence: [The driver](mcp/src/cctp-stellar.ts), [Build on Stellar](https://a-identity.mintlify.site/chains/stellar).

- **Wallet sign-in and linking on every chain family** (2026-09-09; Identity)

  An owner signs in, or links a wallet to an existing account, with an EVM personal_sign,
  a Stellar SEP-43 signMessage through Stellar Wallets Kit, or an Algorand signed
  zero-value self-payment. One account can carry wallets from several families at once.

  This is what lets an EVM-anchored passport and a Stellar signing key belong to one
  owner.

  Chains: Base, Stellar, Algorand. Evidence: [Sign in](https://a-identity.xyz/login).

### August 2026

- **Algorand went live on its first mainnet sale** (2026-08-30; Chains)

  The second non-EVM ecosystem, promoted the same day on a real payment: x402 v2 exact in
  native Circle USDC, the buyer signing a fee-zero transfer inside a pooled-fee atomic
  group through the GoPlausible facilitator, and no sale counted until our own indexer
  read returned the transfer.

  The AgentSpendPolicy vault landed with it as the policy's third implementation
  (Solidity, then Rust on Soroban, now Algorand Python): no update or delete handler, real
  USDC under a 1 USDC daily cap, walked through the same settle-refuse-freeze-override
  ladder as the Stellar releases.

  Chains: Algorand, Algorand Testnet. Evidence: [Algorand proof](https://a-identity.xyz/proof/algorand), [Algorand on A-Identity](https://a-identity.xyz/algorand).

- **Base went live** (2026-08-28; Chains)

  Agent #73232 on the canonical ERC-8004 registries, deployed by their authors, and x402
  settling in native Circle USDC through the same first-party EIP-3009 facilitator that
  serves Robinhood Chain and Arbitrum One.

  The operating wallets were funded from Stellar pubnet USDC through a NEAR Intents swap,
  and that funding trail is published rather than left as a gap. The canonical registry
  pair was verified by matching each proxy's implementation code against Arbitrum One,
  because Arc's three registry addresses also have code on Base and delegate to a
  non-canonical implementation.

  Chains: Base. Evidence: [Base proof](https://a-identity.xyz/proof/base).

- **The Stellar x402 rail sells on pubnet** (2026-08-27; Payment rails)

  First mainnet sale at ledger 64155370, 0.001 USDC through our own facilitator, the buyer
  signing a Soroban authorization entry and paying no fee.

  Recorded with the part that did not work: two earlier attempts bid the 100-stroop
  minimum that testnet always accepts, lost pubnet's inclusion auction and sat invisible
  until they expired. The rail now bids the fee market's own rate with headroom. This is
  what turned stellar from a vault-only story into a selling rail.

  Chains: Stellar. Evidence: [Stellar proof](https://a-identity.xyz/proof/stellar).

- **The payee-validity gate backported to the Solidity vault** (2026-08-27; Spending limits)

  Internal review finding G-1: the Soroban and Algorand ports refused a payee equal to the
  vault itself while the Solidity original accepted it and burned the cap against a
  payment that went nowhere. The Solidity now declares InvalidPayee and reverts with it in
  pay, ownerPay and withdraw.

  Three implementations of one policy model are a strength only while they agree, and on
  this gate they now do.

  Evidence: [The contract](mcp/contracts/AgentSpendPolicy.sol).

- **Stellar pubnet vault deployed, holding real USDC** (2026-08-24; Spending limits)

  The same wasm as testnet, byte for byte, holding real Circle USDC under a 1 USDC daily
  cap and a 0.25 USDC auto-approve ceiling, an order of magnitude under the testnet vault
  because this one holds real money.

  Four settlements, a freeze and unfreeze pair, and an owner override are on the ledger,
  with spent_today coming to rest exactly at the cap. The owner account was raised to a
  2-of-3 multisig on 2026-08-25, after an audit finding pointed out that a permanent owner
  behind a single key is a single point of total loss.

  Chains: Stellar. Evidence: [Stellar proof](https://a-identity.xyz/proof/stellar).

- **The Stellar testnet rail went end to end** (2026-08-15; Payment rails)

  AgentSpendPolicy in Rust on Soroban (daily cap, auto-approve ceiling, allowlist, freeze,
  session key, typed errors, no upgrade entrypoint), plus our own Soroban x402 facilitator
  settling in SEP-41 USDC with the buyer paying no network fee.

  Both halves are on the ledger: an under-limit payment settled and an over-limit one was
  refused on chain with DailyCapExceeded. The first non-EVM rail here, and the only one
  where the spend limit is enforced by a contract before the payment exists.

  Chains: Stellar Testnet. Evidence: [Stellar proof](https://a-identity.xyz/proof/stellar), [The artifacts, as JSON](https://a-identity.xyz/api/proof/stellar).

- **Arbitrum One went live** (2026-08-13; Chains)

  Agent #1259 on the canonical ERC-8004 registry, and x402 settling in native Circle USDC
  through our own EIP-3009 facilitator, with a per-chain fee derived from measured gas
  rather than guessed.

  Chains: Arbitrum One. Evidence: [Arbitrum One proof](https://a-identity.xyz/proof/arbitrum).

- **Robinhood Chain live, with agent #0** (2026-08-13; Chains)

  The canonical identity and reputation registries verified live on mainnet, and agent #0,
  the registry's first mint, is ours since 2026-08-12. Mainnet went live on 2026-08-13
  once the x402 rail settled there in USDG, because the chain publishes no canonical
  Circle USDC.

  The testnet came first, on 2026-08-11: the full canonical registry set is live there,
  with the missing ValidationRegistry implementation deployed by replaying the canonical
  Safe Singleton Factory calldata, and agent #0 minted there too. It stays beta as the
  rehearsal rail.

  Chains: Robinhood Chain, Robinhood Chain Testnet. Evidence: [Robinhood Chain proof](https://a-identity.xyz/proof/robinhood), [Check on Robinhood Chain](https://a-identity.xyz/check/robinhood).

- **Celo mainnet live** (2026-08-09; Chains)

  ERC-8004 identity and reputation reads wired, agent #9759, and the trust tools selling
  over the first-party Celo x402 facilitator in native USDC, with gas payable in
  stablecoins.

  Chains: Celo, Celo Sepolia (Testnet). Evidence: [The Celo settlement log](https://a-identity.xyz/celo-proof), [Celo proof](https://a-identity.xyz/proof/celo).

- **Spend preflight and a velocity circuit breaker** (2026-08-09; Spending limits)

  A dry run of the whole policy ladder with zero mutation, so a payment can be asked
  whether it would pass before anything is signed, and a brake on burst spending that
  trips on velocity rather than on the cap alone.

  Evidence: [The policy module](mcp/src/policy/README.md).

- **merchant_check: counterparty verification for agentic checkouts** (2026-08-09; Trust and security)

  Commerce-grade verification of a merchant-side agent before a checkout, as an MCP tool
  and over REST, returning ALLOW, WARN or DENY with reasons.

  Evidence: [The MCP server](https://a-identity.mintlify.site/developers/mcp-server).

- **The backend split into layered platform/ and http/ modules** (2026-08-09; Platform and console)

  Two monoliths became a layered platform with route-group handlers, the layer graph
  enforced by a test, and a unit suite whose size is asserted by a test rather than quoted
  here.

  Evidence: [The layering test](mcp/src/platform/layering.test.ts), [The module map](mcp/README.md).

### July 2026

- **A trusted agent marketplace on Arc: verify, hire, work, release** (2026-07-19; Ecosystem)

  Hire a verified agent with the payment held in an ERC-8183 escrow on Arc testnet until
  the work is delivered and released, with a composite leaderboard and public agent
  certificates.

  Chains: Circle Arc (Testnet). Evidence: [The marketplace module](mcp/src/marketplace.ts), [The Trust Explorer](https://a-identity.xyz/explorer).

- **Session keys, the Arc Memo audit trail, and Multicall3From batch settlement** (2026-07-19; Spending limits)

  Time-bounded session keys, both vault-native and as a real ERC-4337 UserOp through a
  Kernel smart account; an on-chain Memo entry for every agent settlement; and batched
  settlement in one atomic transaction through Arc's Multicall3From.

  Chains: Circle Arc (Testnet). Evidence: [The contract](mcp/contracts/AgentSpendPolicy.sol), [Arc proof](https://a-identity.xyz/proof/arc).

- **The paid Trust Oracle listed on OKX.AI, on X Layer** (2026-07-17; Ecosystem)

  Six paid x402 tools plus a free preview, sold through OKX's x402 layer in USDT0 on X
  Layer mainnet: 120 real settlements between 2026-07-17 and 2026-07-24, every one paid by
  our own buyer wallet, published with transaction hashes.

  OKX.AI delisted the listing on 2026-09-26. The gateway answers in free mode and nothing
  sells on X Layer now; the identity reads there stay live.

  Chains: OKX X Layer. Evidence: [The settlement proof](https://a-identity-asp.onrender.com/proof), [The proof index](https://a-identity.xyz/proof).

- **The first AgentSpendPolicy vault: on-chain spend limits on Arc** (2026-07-10; Spending limits)

  A per-agent vault whose caps, auto-approve ceiling, allowlist and freeze are enforced by
  the contract, so an agent's authority is bounded where the money sits rather than in a
  prompt.

  Chains: Circle Arc (Testnet). Evidence: [The contract](mcp/contracts/AgentSpendPolicy.sol).

## In progress

Work underway now. No completion dates, on purpose.

- **Separate the testnet fee payer from the testnet vault operator** (Trust and security)

  The pubnet half is done: since 2026-09-15 the pubnet fee payer is a dedicated XLM-only
  account, proven by the production sale it broadcast, so the key that may call vault.pay
  no longer pays for every settlement. On testnet the two Stellar roles still share one
  key, which is test money.

  Chains: Stellar Testnet. Evidence: [The key inventory](SECURITY.md).

- **Ops hardening: secret rotation, off the free tier, rate limits off process-local state** (Trust and security)

  Post-event secret rotation, the backend off the free tier for demo reliability, and the
  rate-limit buckets out of process memory: the one piece of runtime state Postgres did
  not absorb, so a horizontally scaled deploy would still multiply every limit by the
  instance count.

  Evidence: [The rate buckets today](mcp/src/rate-budget.ts).

## Committed

Program milestones with the due dates in the agreement. These are the only future dates in
this document, and the progress against them is published live at
https://a-identity.xyz/proof/arc and https://a-identity.xyz/api/arc/season rather than
promised here.

- **Arc Acceleration Season M1: owner-held vaults from the browser, and verifyThenPay** (due 2026-11-05; Spending limits)

  Five AgentSpendPolicy vaults on Arc Mainnet deployed from the browser with an owner key
  A-Identity never holds, 100 verify-then-pay checks settled through Circle Gateway
  nanopayments, and two refusals anyone can inspect: a vault-policy revert with a hash,
  and a DENY that stopped a payment before signing.

  A vault counts only when its owner key is one we never held, so the launch-day vault,
  owned by our operating wallet, does not. The browser deployer is live at /app/vault/arc,
  and no owner-held vault exists yet. Targets are the Deliverable 1 commitments as Circle
  revised them on 2026-10-19; the counts are read from the settlement logs on every
  request, and the curated lists fill only when the evidence exists.

  Chains: Arc Mainnet. Evidence: [Live progress](https://a-identity.xyz/proof/arc), [The computed report](https://a-identity.xyz/api/arc/season), [Partner guide](https://a-identity.mintlify.site/chains/arc-integration).

- **Arc Acceleration Season M2: the first external agents verifying and paying on Arc Mainnet** (due 2026-11-06; Ecosystem)

  Two external teams live, 30 paid checks from wallets we do not control, one team active
  on more than one day, and one integration we may reference in public.

  A wallet is external by default and attributed to a team by name only on request, and
  only after it has paid a check on Arc Mainnet. Deliverable 2, the progress report Circle
  judges, is due 2026-10-30 and is the same computed report.

  Chains: Arc Mainnet. Evidence: [Live progress](https://a-identity.xyz/proof/arc), [The computed report](https://a-identity.xyz/api/arc/season), [Partner guide](https://a-identity.mintlify.site/chains/arc-integration).

## Next

What follows the current work, in order. Undated, deliberately.

- **MPP session mode on the main backend** (Payment rails)

  Open a funded session, make many vouchered trust checks, settle on close. Research and
  recommendation are done; the prototype follows the Arc x402 rail's durable-store
  discipline.

- **X Layer: a rail that sells again** (Payment rails)

  Identity reads on X Layer are live; the paid listing was delisted on 2026-09-26 and
  nothing sells there now. The payment rail returns as one deliberate listing update, with
  the OKX payment-surface expansion (subscription-style monitoring, an escrow-gated tool,
  batched settlement) bundled into it.

  Chains: OKX X Layer.

- **Spend preflight in the console** (Platform and console)

  The API is live. The Permissions screen gets a would-this-pass panel that runs the whole
  ladder with zero mutation before anything is signed.

- **A readable identity story for the non-EVM rails** (Identity)

  ERC-8004 is EVM-only, so a passport on Stellar or Algorand is bridged from an EVM chain
  rather than anchored. The pointer half shipped on 2026-09-15: TrionLabs' Stellar 8004
  registry is read, read-only and labeled third-party, and A-Identity is agent 25 on its
  testnet instance.

  Three things remain, and none of them is a registry of our own called a standard.
  Mainnet registration is blocked on the registry's owner, because their mainnet instance
  simulated as archived and restoring somebody else's contract is their call, not ours.
  Algorand still has no registry we can verify. And KYA remains unanchorable on both
  chains, which the point of sale has to keep saying out loud.

  Chains: Stellar, Algorand.

## Later

Direction rather than schedule: known and wanted, not dated.

- **Cross-protocol settlement router** (Payment rails)

  One quote layer answering 402s with the union of rails we accept (x402 exact,
  Nanopayments, MPP session) and routing settlement.

- **Avalanche, the only planned entry in the registry** (Chains)

  The descriptor is there and the canonical ERC-8004 identity and reputation registries
  are already live on the chain, deployed by their authors. What is missing is ours: an
  agent on them and a rail pointed at them. It stays planned until both exist, because a
  descriptor is not an integration.

  Chains: Avalanche C-Chain.

- **Cross-operator Sybil detection** (Trust and security)

  Funder-graph provenance, beyond the same-operator wash detection the score already
  applies.

- **Per-party escrow signing in the marketplace** (Ecosystem)

  Today the platform signer is the escrow party. Each party signing from its own wallet is
  the goal.

- **Frontend debt** (Platform and console)

  RegisterForm state to a single reducer, and the sitemap generator decoupled from the
  blog source text so content can be split freely.

## How to influence this

- [Open a GitHub issue](https://github.com/getA-Identity/A-Identity/issues)
- [Find us in Discord](https://discord.gg/ak4rC3p7Tz)
- [Talk to the founders](https://a-identity.xyz/contact)
- [The rule for new chains](CONTRIBUTING.md)

A chain lands as a registry entry plus at most one adapter, never as scattered special
cases; CONTRIBUTING.md carries the rule. An issue that names the chain, the rail and the
evidence you would expect to see is the fastest way to move an item up this list.

---

Generated from `src/lib/roadmap.ts` by `scripts/gen-roadmap.mjs`; do not edit by hand.
Edit the data file, run `node scripts/gen-roadmap.mjs`, and `npm run check:roadmap` fails
the build while this file is stale. The same data renders the page at
https://a-identity.xyz/roadmap.
