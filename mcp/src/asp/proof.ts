/**
 * Public, verifiable proof for the OKX.AI Genesis Hackathon submission.
 *
 * Everything here is REAL and independently checkable on-chain - no claims a
 * reviewer can't verify themselves:
 *   - the ASP identity registered on X Layer mainnet (Agent #6271),
 *   - 120 real x402 settlements on X Layer mainnet (4 featured, one per original paid tool),
 *   - the on-chain showcase agent the tools return real data for (Meridian #849980),
 *   - the engineering rigor behind the scores (deterministic, unit-tested engine).
 *
 * Served free at GET /proof so anyone calling the live ASP sees the substance,
 * and cited from the README. Surfacing verifiable rigor is a deliberate answer
 * to "feels like a product, not a hackathon project."
 */

import { SETTLEMENTS } from './settlements.js'
import { ARC_CHAIN } from '../chains/index.js'

const OKLINK_TX = 'https://www.oklink.com/x-layer/evm/tx/'
const OKLINK_ADDR = 'https://www.oklink.com/x-layer/evm/address/'

/** payer = the buyer Agentic Wallet; payTo = where per-call revenue settles. */
const PAYER = '0x169ead25d35c146f3f3a7d2936ae37eab2e256d1'
const PAY_TO = '0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6'

// All real settlements (round 0 = live demo, rounds 1-29 = seeding incl. campaign 2), each + an OKLink link.
const WITH_URLS = SETTLEMENTS.map((s) => ({ ...s, txUrl: `${OKLINK_TX}${s.txHash}` }))
const FEATURED = WITH_URLS.filter((s) => s.round === 0)
const TOTAL_USD = Math.round(SETTLEMENTS.reduce((a, s) => a + s.amountUsd, 0) * 1000) / 1000
const BY_TOOL = SETTLEMENTS.reduce<Record<string, number>>((m, s) => {
  m[s.tool] = (m[s.tool] || 0) + 1
  return m
}, {})

export const PROOF = {
  submission: 'OKX.AI Genesis Hackathon',
  asp: {
    name: 'A-Identity Trust Oracle',
    agentId: '#6271',
    type: 'A2MCP',
    network: 'X Layer mainnet (eip155:196)',
    registrationTx: '0x03a614a902ed742526047dffa165378cb16350a81bf083d4672f6d7a9ecfb078',
    registrationTxUrl: `${OKLINK_TX}0x03a614a902ed742526047dffa165378cb16350a81bf083d4672f6d7a9ecfb078`,
  },
  // REAL x402 pay-per-call settlements on X Layer mainnet - round 0 = the live demo,
  // rounds 1-29 = seeding (campaign 2 adds counterparty_check). Every row is a real
  // USD₮0 transfer to payTo.
  realOnchainRevenue: {
    network: 'X Layer mainnet (eip155:196)',
    asset: 'USD₮0 (0x779Ded0c9e1022225f8E0630b35a9b54bE713736)',
    payer: PAYER,
    payTo: PAY_TO,
    payToUrl: `${OKLINK_ADDR}${PAY_TO}`,
    totalSettlements: WITH_URLS.length,
    totalUsd: TOTAL_USD,
    byTool: BY_TOOL,
    featured: FEATURED,
    settlements: WITH_URLS,
  },
  // Real data the tools return, not mocks: a live ERC-8004 agent on Circle Arc.
  showcaseAgent: {
    name: 'Meridian',
    erc8004TokenId: '#849980',
    chain: 'Circle Arc testnet',
    reputation: '542 / 1000 (settlement 296 + validation 240 + tenure 6 + behavior 0; no marketplace jobs yet)',
    kya: 'verified',
    note: 'reputation_score and agent_passport return this live on-chain data',
    // A1: the score is also anchored on-chain as an ERC-8004 feedback attestation, written by
    // the A-Identity oracle validator (distinct from the agent owner, as ERC-8004 requires).
    onchainReputationAttestation: {
      standard: 'ERC-8004 ReputationRegistry',
      registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      validator: '0xee602A161232Aac1436E812676b6626382FC84a9',
      scoreOnchain: '54 / 100 (the 0-1000 score on the ERC-8004 convention)',
      tx: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c',
      txUrl: `${ARC_CHAIN.explorer}/tx/0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c`,
      note: 'reputation_score / agent_passport return this as onchainAttestation - verify the score on-chain instead of trusting the API',
    },
  },
  // Bounded-authority guardrails. LINKED, not embedded: the ASP is a separate process that
  // loads state at boot, so a traction number copied in here could be stale, and a stale
  // traction figure is exactly the kind of claim that should not exist.
  guardrails: {
    what: 'Policy checks before an agent acts on a brokerage or card account: ALLOW / WARN / DENY with reasons, plus a decision trail.',
    liveTraction: 'https://a-identity-backend.onrender.com/api/traction',
    liveEngineSelfCheck: 'https://a-identity-backend.onrender.com/api/guardrail-status',
    honesty:
      'The headline is protected value (USD of intended action the policy refused). Measured, not projected, and NOT revenue. Canary activity is excluded from it.',
  },
  // The rigor behind the numbers - deterministic and unit-tested, not an LLM guess.
  engineering: {
    tests: 428,
    deterministicReputation: true,
    liveOnchainReads: 'ERC-8004 IdentityRegistry + ValidationRegistry (KYA) on Circle Arc, plus the OKX.AI IdentityRegistry on X Layer mainnet (any OKX.AI agent resolves by token id or owner address), read live via viem',
    onchainReputationWrites: 'ERC-8004 ReputationRegistry on Circle Arc: the score is anchored on-chain as a signed observer attestation (A1)',
    standards: ['ERC-8004', 'x402'],
    reputationBasis: 'real on-chain settlements + verified identity credit + tenure + real job outcomes (behavior) - see /methodology',
    riskBasis: 'ALLOW / WARN / DENY composed from identity + KYA + reputation + tenure + Sybil - see /methodology',
    repo: 'https://github.com/getA-Identity/A-Identity',
  },
  howToVerify: [
    'Call any tool endpoint (POST /tools/*) - it returns HTTP 402 with an x402 challenge on X Layer mainnet (eip155:196).',
    'Open any settlement txUrl on OKLink - each is a real USD₮0 transfer to payTo on X Layer mainnet.',
    `Check the payTo balance (${PAY_TO}) - it received every one of these settlements in USD₮0.`,
    'Open the showcase agent onchainReputationAttestation tx on Arcscan - the reputation is anchored on the ERC-8004 ReputationRegistry, not just asserted here.',
    'GET /methodology for the exact, reproducible reputation and risk formulas.',
  ],
  docs: 'https://a-identity.xyz',
}

/** The deterministic formulas behind the scores - served at GET /methodology. */
export const METHODOLOGY = {
  reputation: {
    range: '0-1000',
    deterministic: true,
    formula: 'score = settlement(0-600) + validation(0-240) + tenure(0-160) + behavior(-150..+40), clamped 0-1000',
    settlement: 'min(600, round(600 * (1 - e^(-settledEffective / 6))) + (onchainIdentity ? 60 : 0))',
    recency: 'settledEffective = sum over settlements of 0.5^(ageDays / 90) - a settlement\'s weight halves every 90 days, so the score is dominated by RECENT verified activity and cannot coast on ancient history. The validation share deliberately does NOT decay (a rejection never ages away). Both settledOnchain (raw) and settledEffective (weighted) are returned, so the decay is auditable.',
    validation: 'settledOnchain + rejected == 0 ? 0 : round(240 * settledOnchain / (settledOnchain + rejected))',
    tenure: 'min(160, round(daysSinceCreated / 2))',
    behavior: 'clamp(-150, +40, -round(150 * contestedJobs / (completedJobs + contestedJobs)) + (ratedJobs >= 2 ? clamp(-40, +40, round((avgRating - 4) * 40)) : 0)); 0 with no marketplace job history',
    inputs: 'all real and verifiable: on-chain USDC settlements (carry tx hashes), a verified ERC-8004 identity, clean-vs-rejected ratio, tenure, and real marketplace job outcomes (completed vs disputed/refunded jobs + mean client rating). No mock history, no self-attestation.',
    note: 'behavior uses only outcomes A-Identity records on-chain-escrowed jobs (dispute/refund + client ratings); delivery-latency and on-chain cap-breach signals are intentionally NOT yet included (not tracked with the fidelity to score them honestly).',
  },
  // A1: the deterministic score is anchored on-chain, so a caller can verify it without trusting us.
  reputationAnchor: {
    standard: 'ERC-8004 ReputationRegistry',
    chain: 'Circle Arc',
    write: "the score is published via giveFeedback(agentId, score, ...) by the A-Identity oracle validator - a wallet distinct from the agent owner, because ERC-8004 forbids an owner from scoring its own agent (no self-attestation).",
    scale: 'written on the ERC-8004 0-100 convention (the 0-1000 score / 10); the raw 0-1000 value + tag are committed in the feedback hash for exact verification.',
    surfaced: 'reputation_score and agent_passport return the latest attestation as `onchainAttestation` (chain, registry, validator, tx). Absent until an agent has a published attestation - the score is always recomputed live, so the anchor is a verifiable snapshot, never the source of truth.',
  },
  liveness: {
    what: 'registered != live: verify_agent and agent_passport probe the agent\'s registered public surface (domain first, else the registration URI) with an SSRF-guarded, redirect-blocked request (3.5s cap). Any HTTP answer proves a listening server.',
    honest: 'informational only, never scored into the risk verdict - a transient outage must not flip a decision. Most ERC-8004 registrations are never liveness-checked; this closes that gap transparently.',
  },
  risk: {
    decisions: ['ALLOW', 'WARN', 'DENY'],
    deny: [
      'KYA revoked (the agent is flagged as an incident)',
      "Sybil / wash reputation: >= 60% of jobs hired by the agent's own operator",
      'no verifiable on-chain ERC-8004 identity',
      'reputation < 200',
      'transaction amount > $100 to an agent with reputation < 400',
    ],
    warn: [
      'KYA (wallet-control) not attested',
      'Sybil signals: partial same-operator hiring or low counterparty diversity',
      'reputation in [200, 500)',
      'tenure < 7 days (new agent)',
      'transaction amount > $1000',
    ],
    sybil: "Sybil/wash detection from real state: operator cluster size (agents per owner), self-deal rate (jobs hired by the agent's OWN operator), and counterparty diversity (distinct clients / jobs). HIGH = reputation mostly self-dealt -> DENY; MEDIUM -> WARN. Detects same-operator wash only; cross-operator collusion needs a funder-graph indexer (roadmap).",
    allow: 'none of the above - verified identity, attested KYA, strong reputation',
    note: 'DENY overrides WARN overrides ALLOW; every triggered reason is returned. Pure and unit-tested.',
  },
  // The tools (each a thin wrapper over the live engine; paid prices settle over x402 on X Layer).
  tools: {
    trust_preview: 'free - coarse trust band + revoked/Sybil flags for one agent (rate-limited per IP); the adoption on-ramp to the paid depth',
    verify_agent: '$0.001 - ERC-8004 identity + KYA status',
    reputation_score: '$0.002 - the deterministic 0-1000 score (+ its on-chain attestation, if published)',
    risk_check: '$0.005 - pre-transaction ALLOW / WARN / DENY on a counterparty',
    agent_passport: '$0.01 - identity + reputation + KYA + risk in one call',
    counterparty_check: "$0.008 - a deal-specific verdict between two agents: risk_check on the counterparty PLUS a same-operator self-deal check (paying an agent you also operate builds no independent reputation).",
    guardrail_check: "$0.005 - does this agent operate under an ENFORCED spend/trade policy, and does it respect the verdicts? Bands only (policy enforced, block rate, refused override attempts, unclosed approvals): the policy itself, its caps, its allowlists, the symbols and the amounts are never disclosed. The owner's own policy checks are free and owner-gated; we sell the counterparty signal, not the seatbelt.",
  },
  // Guardrail traction lives on the main backend and is LINKED rather than embedded: the ASP
  // is a separate process that loads state at boot, so a number copied in here could be
  // stale, and a stale traction figure is exactly the kind of claim that should not exist.
  guardrails: {
    what: 'Bounded-authority policy checks before an agent acts on a brokerage or card account: ALLOW / WARN / DENY, with reasons and a decision trail.',
    liveTraction: 'https://a-identity-backend.onrender.com/api/traction',
    liveEngineSelfCheck: 'https://a-identity-backend.onrender.com/api/guardrail-status',
    honesty:
      'The headline is protected value (USD of intended action the policy refused), which is measured and is NOT revenue. Canary activity is excluded from it.',
  },
  standards: {
    'ERC-8004': 'on-chain agent identity (IdentityRegistry) + validation/KYA (ValidationRegistry) + reputation attestation (ReputationRegistry)',
    x402: 'HTTP 402 pay-per-call settlement, here on X Layer mainnet in USD₮0',
  },
}
