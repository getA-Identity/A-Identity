# A-Identity at the Arbitrum Open House Singapore Buildathon

Before an AI agent pays on Robinhood Chain or Arbitrum One, three questions should have
answers: who gets paid, is the dollar real, and how much may the agent spend. A-Identity
answers all three at the moment of payment, on mainnet, with a receipt or a live read
behind every claim.

On 2026-09-30, 900 tokens on Robinhood Chain's public explorer had the symbol USDG or the
name "Global Dollar"; 45 of them showed more than 10,000 holders, and the biggest,
`0xA913C4C2F28AA7b0B15A7C6008a6e19Ff8Bf85c0`, showed 194,589 against the real USDG's
401,824. A symbol is not an identity. That is the problem this entry is about.

## Try it

- [a-identity.xyz/check/robinhood](https://a-identity.xyz/check/robinhood): paste a token,
  a wallet, an agent id or an x402 link. [/check/arbitrum](https://a-identity.xyz/check/arbitrum)
  is the same check for Arbitrum One and native Circle USDC.
- For agents: `GET https://a-identity.xyz/api/robinhood/check?q=<input>` (no key), the
  reason codes at `/api/robinhood/check/codes`, or the MCP tool `evm_pay_check` on
  `https://a-identity.xyz/mcp`.
- The evidence: [/proof/robinhood](https://a-identity.xyz/proof/robinhood) and
  [/proof/arbitrum](https://a-identity.xyz/proof/arbitrum) list every transaction we claim
  and re-read agent #0 and agent #1259 from the chain on every load.

## Built during the Buildathon (Sep 14 - Oct 4, 2026)

| Commit or tx | Date | What |
| --- | --- | --- |
| `1ac21dd5` | 2026-10-01 | Our facilitator read only x402 v1's `maxAmountRequired`, so every stock v2 request failed; it reads v2's `amount` now. `/api/facilitator/supported` quoted one chain's minimum on every chain (Arbitrum showed 21000 while its own 402 asks 6000); each chain carries its own now. `/api/facilitator/proof` summed gas across chains with different gas units; it reports gas per network now. Our buyer script refuses to sign a challenge for a token the chain does not settle in. |
| `f7f97a4d` | 2026-10-01 | The pay check: `GET /api/robinhood/check`, `/api/arbitrum/check` and the MCP tool `evm_pay_check`. Token, wallet, agent id or x402 link, answered from the live chain with stable reason codes. |
| `8870ba99` | 2026-10-01 | `/check/robinhood` and `/check/arbitrum`, the same check for people. |
| `96a61409` | 2026-10-01 | Public copy corrected where it overclaimed (see "Bugs found and fixed"). |
| renew `0xc68bf160...d769`, split `0x47d60109...7304` | 2026-10-01 | Robinhood Chain vault: session key renewed to 2026-11-15, agent key split from the owner key. |
| renew `0x237457f6...960a`, split `0x1e40db36...c0fc` | 2026-10-01 | Arbitrum One vault: the same. |
| `47a57d45` | 2026-09-16 | Gas ceilings follow each chain's gas unit, and the daily gas budget is kept per network. Written for the rail on every chain, including these two. |
| `7ca6c63a` | 2026-09-25 | An agent's registration date comes from its mint block, not from the day it was read. Applies to agent #0 and #1259. |

What the pay check does, in detail:

- **A token.** It must be the settlement dollar our chain registry names (Paxos USDG on
  Robinhood Chain, native Circle USDC on Arbitrum One), and its EIP-712 signing domain must
  reproduce the token's live `DOMAIN_SEPARATOR`. USDG exposes no `version()`, so the domain
  is proven from candidates, never pasted. A token that copies the name and symbol is a
  fake; one that only shares the symbol (Arbitrum's bridged USDC.e) is "not the dollar this
  chain settles in", never "fake". The answer always names where the real one is.
- **A wallet.** Does it hold an ERC-8004 agent id on this chain, and was it ever used.
- **An agent id.** Is it registered, and does the registration file it points to list
  that id back. Token #1 on Robinhood Chain was minted 7 seconds after our #0, pointing at
  our agent card; the check flags it.
- **An x402 link.** Which asset its 402 challenge asks for, which signing domain it hands
  the buyer, and who it pays.
- **The chain.** It reads `arbChainID()` from the ArbSys precompile at `0x64` (4663 and
  42161) instead of trusting a name.
- **Safety of the check itself.** A pasted link is fetched with the address screen inside
  the connection's own DNS lookup, so DNS rebinding cannot reach a private network, and
  redirects are not followed. Nothing unproven is called safe: an unprovable domain reads
  "Could not verify", and a registration is labeled identity, not a review.

## Already there before Sep 14 (the baseline, not claimed as Buildathon work)

- 2026-08-12: agent **#0** minted on Robinhood Chain mainnet's canonical ERC-8004
  IdentityRegistry, tx `0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e`.
- 2026-08-13: our x402 facilitator settling in USDG on Robinhood Chain; agent **#1259** on
  Arbitrum One, tx `0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3`.
- 2026-08-28: the two AgentSpendPolicy vaults deployed, Robinhood Chain
  `0x05a6aad7124c2f1c7b82b03e0bbe3867bc500073` and Arbitrum One
  `0xac6c5c9af62bc482ffeef882a6ac4678513be6db`.

## Numbers (2026-10-01)

- 1,471 unit tests declared across 98 files, all passing, plus 48 end-to-end and 149
  guardrail assertions against a running server.
- Vault policy on both chains: 1 USDG or USDC a day and 0.25 per payment for the agent key;
  above that the contract refuses with `AboveAutoApprove` and the payment is the owner's to make.
- Each vault operation on 2026-10-01 cost about 31,000 gas, about 0.0000006 ETH.

## Bugs found and fixed

We audited our own Arbitrum and Robinhood Chain surfaces during the Buildathon. What we
found was wrong, and is now fixed:

- Both mainnet vaults' session keys had lapsed on 2026-09-04, so every agent payment
  reverted, while the proof pages still described a working 7-day key. Renewed, and the
  agent key now differs from the owner key, which it did not before.
- The facilitator rejected every stock x402 v2 request (the `amount` field).
- `/supported` advertised one chain's minimum on every chain.
- The proof's gas total added Arc's USDC-denominated gas to ETH gas; 99% of the figure was
  the former.
- Nine public surfaces said no published facilitator served Robinhood Chain. Others do.
  The surfaces now say why we run our own instead: one code path and one receipt standard
  on every chain we sell on.
- A doc called agent #0 "the first agent ever registered on this chain". It is the first
  token the canonical registry minted, which is narrower and true.

## Known limits

- Every settlement so far is our own buyer wallet paying our own address. It shows the
  rail works, not that there is demand, and the proof pages label it internal.
- We did not deploy the ERC-8004 registries; their authors did.
- The vault owner is a server-held key, and the contract has no owner transfer. The split
  limits what the agent key can do; it does not make the owner a hardware wallet.
- There is no ValidationRegistry in this mainnet registry family, so a KYA result cannot
  be anchored on chain here.
- These are L2s: we wait for confirmations and record the block, and we do not claim
  Ethereum finality.
- A-Identity also runs on Arc, Base, Stellar and Algorand. This page is only about
  Robinhood Chain and Arbitrum One.

## Prior art

Other x402 facilitators serve Robinhood Chain, hosted and open-source, some predating our
August launch; Coinbase and thirdweb serve Arbitrum One. Gasless EIP-3009 relaying on USDG
predates us. Other projects verify stock tokens by bytecode and deployer. We do not claim
to be first at any of these. What this entry combines is the payment moment: who, is the
dollar real, and how much, in one flow, on mainnet.

## Verify it yourself

```bash
# The impostor with the most holders, and the real USDG.
curl -s 'https://a-identity.xyz/api/robinhood/check?q=0xA913C4C2F28AA7b0B15A7C6008a6e19Ff8Bf85c0'
curl -s 'https://a-identity.xyz/api/robinhood/check?q=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'

# Agent #0, and the clone minted 7 seconds later.
curl -s 'https://a-identity.xyz/api/robinhood/check?q=%230'
curl -s 'https://a-identity.xyz/api/robinhood/check?q=%231'

# Each chain's own minimum, and gas per network.
curl -s https://a-identity-backend.onrender.com/api/facilitator/supported
curl -s https://a-identity-backend.onrender.com/api/facilitator/proof

# The vault's agent key and its expiry, read from the chain (operator() and sessionKeyExpiry()).
cast call 0x05a6aad7124c2f1c7b82b03e0bbe3867bc500073 'operator()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xac6c5c9af62bc482ffeef882a6ac4678513be6db 'sessionKeyExpiry()(uint256)' --rpc-url https://arb1.arbitrum.io/rpc
```

Source: [github.com/getA-Identity/A-Identity](https://github.com/getA-Identity/A-Identity).
The pay check is in `mcp/src/evm-pay-check/`, the rail in `mcp/src/x402-3009/`, the vault in
`mcp/contracts/AgentSpendPolicy.sol`.
