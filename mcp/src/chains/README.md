# The chains module: how a blockchain gets added here

Source files in this module used to cite `MULTICHAIN-STRATEGY.md`, which is gitignored.
Anyone who cloned this repository was sent to a document they could not open, and the
reader most likely to follow that pointer is exactly the one adding a chain. This file is
the tracked replacement, and it says what the code actually relies on.

`docs-citations.test.ts` fails the build if a tracked source cites a path a reader cannot
open, so this cannot quietly rot again.

---

## The one-line thesis

Config is data, logic is chain-agnostic, and each chain is a thin adapter behind one
interface. Adding a chain should be a data edit plus, at most, one adapter, never a
rewrite of product logic.

## The five decisions the code is built on

1. **One chain registry.** Every chain is a single typed descriptor in `registry.ts`:
   RPC, explorer, native token, contract addresses, feature flags, lifecycle status.
   Nothing else in the codebase hardcodes a chain id, an RPC host or an address, and
   `no-hardcoded-chains.test.ts` fails the build when something does. That test exists
   because an audit found Arc's chain id, RPC host, CAIP-2 id, USDC address and CCTP
   domain restated across eight modules, each one a place a second chain would have had
   to be wired by hand, and a place a value could drift without anyone noticing.

2. **A chain-agnostic core with per-VM adapters.** Product logic is written once against
   normalized types. Only a thin adapter per VM family may import a chain SDK: `evm/`
   imports viem, and a Stellar adapter would import stellar-sdk. `createEvmAdapter(descriptor)`
   returns the full set of on-chain operations parameterized entirely by the descriptor,
   which is why a new EVM chain gets identity, escrow, settlement and vaults with no new
   code path.

3. **CAIP identifiers everywhere.** Chains are CAIP-2 (`eip155:4663`), accounts are
   CAIP-10, assets are CAIP-19. The namespace is the router key, and native ids like a
   numeric EVM chain id are derived fields, not the primary key. `caip.ts` owns the
   parsing, and the registry validates at import time that a descriptor's CAIP-2 id and
   its `evmChainId` agree.

4. **Honest lifecycle status.** `live` means wired end to end and carrying real traffic.
   `beta` means real and reachable but not the whole loop. `planned` means the descriptor
   exists so onboarding is a data edit, and nothing is deployed. A promotion is meant to
   be a deliberate edit: it touches `registry.ts` and two test expectation lists, and
   nothing else, because everything public is derived from the registry rather than
   restated. If a third file needs editing to promote a chain, that file is restating the
   registry and belongs behind one of the drift tests.

5. **One address, many chains, where it is actually possible.** Deterministic deployers
   let the same contract carry the same address on every EVM chain, which is what makes
   one agent id mean the same thing wherever it is resolved. This only holds where the
   deployer is genuinely present, so `contracts.create2Factory` is set only where an
   `eth_getCode` call confirmed it, never assumed from the fact that it is usually there.
   Deploying against an absent factory fails in a confusing way, which is the failure this
   discipline avoids. Note that the canonical ERC-8004 registries were deployed through
   the Safe Singleton Factory rather than the Arachnid CREATE2 factory, and the two are
   different addresses with different calldata conventions.

## What a descriptor may and may not claim

The registry is read by payment code, so a wrong value here moves money to the wrong
place. Three rules follow from that:

- **Assert only what was observed.** Every address in a descriptor was confirmed with a
  live call, and several carry a `verified` note recording how and when. An address
  copied from a documentation page is not evidence.
- **`contracts.usdc` means canonical Circle USDC and nothing else.** It is the slot every
  generic USDC path reads: `payUsdc`, the ERC-8183 escrow approve, the AgentSpendPolicy
  vault constructor. A chain can have a real settlement token and no canonical USDC, which
  is exactly Robinhood Chain, and that token belongs in `settlementTokens` where it is
  named for what it is. Putting it in `usdc` would silently repoint contracts that were
  never tested against it.
- **Absence is information.** A chain with no ValidationRegistry cannot anchor a KYA
  result, and the honest output there is "not anchorable here", not a count of zero. The
  two read the same to a machine and mean opposite things to a person.

## Adding a chain

1. Add a descriptor to `registry.ts`. Confirm every address with a live call first, and
   write down what you confirmed in the comment or the `verified` field.
2. If the chain is a new VM family, add an adapter under `chains/<ecosystem>/`. If it is
   EVM, there is nothing to write.
3. `cd mcp && npm run gen:chains` to regenerate `src/lib/chains.ts`, which is byte-pinned
   against the registry by `frontend-sync.test.ts`.
4. Update `public/.well-known/ai-agent-manifest.json`, which is hand-maintained but has
   three arrays pinned to registry order by the same test.
5. `cd mcp && npm test`. The drift tests will tell you what else disagrees: enums, unions,
   published prose, the docs chain overview, `.env.example`.

## The layering rule

`platform/` is layered, with core at the bottom, and a module imports only lower layers;
`layering.test.ts` enforces the graph. `chains/index.ts` is the public surface of this
module: import chains and the EVM adapter from there rather than reaching into a file.

## Where the seam is mirrored

`policy/registry.ts` and `callers/registry.ts` are the same shape applied to different
problems: many callers, one core, and the variation pushed into data. If you are adding a
surface or a caller rather than a chain, read those alongside this.
