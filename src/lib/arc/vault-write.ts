/**
 * Every write the Arc vault page makes, built in this browser and signed in the owner's wallet.
 *
 * A-Identity holds no key here and signs nothing. Each write goes through the same three
 * steps, and nothing reaches a wallet unless the first two pass:
 *
 *   1. prepare: refuse what the page never sends (a 0 cap, a 0 expiry, an operator that is the
 *      owner or zero, a withdrawal to the vault or the token), encode the call, SIMULATE it
 *      with eth_call as the owner so a NotOwner or an InvalidPayee shows up before the wallet
 *      opens, estimate gas, and price it at or above Arc's 20 gwei floor.
 *   2. send (send.ts): put the wallet on the vault's chain, read eth_chainId and eth_accounts
 *      AGAIN right before sending, then eth_sendTransaction with explicit gas and fee fields.
 *   3. the receipt, polled across every RPC (TxReceipt.tsx), must carry the expected event
 *      before anything is called settled.
 *
 * Every write on an existing vault first re-reads its code and requires it to be this build with
 * the owner() and usdc() the page showed written into every immutable slot, so the owner on
 * screen is the only key the vault's owner checks obey.
 *
 * Every prepared write is a plain object (contract, function, arguments, network, fee) that
 * the page shows before the wallet is asked, the browser's version of prepared-or-executed.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  getContractAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem'
import type { Chain } from '../chains'
import { AGENT_SPEND_POLICY_ABI, AGENT_SPEND_POLICY_BYTECODE, AGENT_SPEND_POLICY_IMMUTABLES, AGENT_SPEND_POLICY_RUNTIME } from '../contracts/agent-spend-policy'
import { messageOf, TxStop, txStop as stop } from './send'
import {
  RpcUnreachableError,
  isContractAnswer,
  networkName,
  onFirstHost,
  usdcOf,
  type ArcClient,
  type Expectation,
  type VaultEventName,
  type VaultSnapshot,
} from './vault-read'
import {
  OWNER_ACTION_GAS,
  capsRefusal,
  expiryRefusal,
  feeFields,
  formatUnitsExact,
  fundRefusal,
  gasWithMargin,
  isKnownBuild,
  operatorRefusal,
  REVOKED_SESSION_EXPIRY,
  sameAddress,
  sessionExpiryFor,
  sessionSecondsRefusal,
  withdrawRefusal,
} from './vault-rules'

// The send path and its typed failures live in send.ts, where the suite can drive them; the
// page's components keep importing them from here.
export { STEP_LABEL, TxStop, failureOf, sendPrepared, type TxFailure, type TxFailureCode, type TxStep } from './send'

export type TxAction = 'deploy' | 'expiry' | 'fund' | 'freeze' | 'unfreeze' | 'policy' | 'withdraw' | 'extend' | 'revoke' | 'operator'

/** One argument of the prepared call, as shown before signing. */
export type ShownArg = { name: string; value: string; note?: string }

export type PreparedTx = {
  action: TxAction
  /** What it does, in words: "Freeze the vault", "Withdraw 0.5 USDC". */
  what: string
  chain: Chain
  from: Address
  /** null for a deploy: a contract creation has no recipient. */
  to: Address | null
  data: Hex
  /** The call as the page will hand it to the wallet. */
  call: { contract: string; function: string; args: ShownArg[] }
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** gas * maxFeePerGas: the most this transaction can cost, in native wei (USDC at 18 decimals on Arc). */
  maxFeeWei: bigint
  /** What the receipt must carry before this counts as settled. */
  expect: Expectation[]
  /** A deploy: the CREATE address at the nonce read when this was prepared. */
  predicted?: Address
  /** The account's next nonce when this was prepared. The wallet picks the real one. */
  nonce?: number
  /** A session key write: the expiry, from chain time. */
  expiry?: bigint
  preparedAt: number
}

/** A prepared write older than this is prepared again before the wallet sees it: fees and nonces move. */
const PREPARED_TTL_MS = 60_000
export const preparedStale = (p: PreparedTx) => Date.now() - p.preparedAt > PREPARED_TTL_MS

// --- errors ---

/** The revert data somewhere in an error's cause chain, however the host or wallet wrapped it. */
function revertData(e: unknown): Hex | null {
  let x: unknown = e
  for (let i = 0; i < 12 && x && typeof x === 'object'; i++) {
    const o = x as { data?: unknown; cause?: unknown }
    if (typeof o.data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(o.data)) return o.data as Hex
    const inner = o.data && typeof o.data === 'object' ? (o.data as { data?: unknown }).data : undefined
    if (typeof inner === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex
    x = o.cause
  }
  return null
}

/** The contract's own name for a refusal (NotOwner, InvalidPayee, ...), or a revert reason. */
export function contractErrorName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) {
      if (r.data?.errorName) return r.data.errorName
      if (r.reason) return r.reason
    }
  }
  const data = revertData(e)
  if (!data) return null
  for (const abi of [AGENT_SPEND_POLICY_ABI, erc20Abi] as const) {
    try {
      // viem also decodes Solidity's built-in Error(string) and Panic(uint256), which the
      // typed result does not list, so the result is read as the looser shape it really is.
      const d = decodeErrorResult({ abi, data }) as { errorName: string; args?: readonly unknown[] }
      if (d.errorName === 'Error' && typeof d.args?.[0] === 'string') return d.args[0]
      return d.errorName
    } catch {
      /* not this ABI's error */
    }
  }
  return null
}

/** A revert during simulation, named, or the host's own failure passed on. */
function simulationStop(e: unknown, what: string): TxStop {
  if (e instanceof TxStop) return e
  if (isContractAnswer(e)) {
    const name = contractErrorName(e)
    return stop(
      'reverted_in_simulation',
      `The contract refused ${what} in simulation${name ? ` (${name})` : ''}. Nothing was sent and no fee was spent.`,
      name ?? undefined,
    )
  }
  if (e instanceof RpcUnreachableError) return stop('rpc_unreachable', e.message)
  return stop('rpc_unreachable', `The chain could not be read while preparing ${what}: ${messageOf(e)}`)
}

// --- shared preparation ---

function checkedAddress(text: string, role: string): Address {
  const t = text.trim()
  // Strict: a mixed-case address whose checksum does not match is a typo until shown otherwise.
  if (!isAddress(t)) throw stop('refused', `The ${role} address is not a valid EVM address, or its mixed-case checksum does not match. Check it for a typo.`)
  return getAddress(t)
}

/** The nonce this write should get, for noticing a speed-up later. Not worth refusing a write over. */
async function nonceHint(c: ArcClient, from: Address): Promise<number | undefined> {
  try {
    return await c.getTransactionCount({ address: from, blockTag: 'pending' })
  } catch {
    return undefined
  }
}

async function feeQuote(c: ArcClient): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const head = await c.getBlock({ blockTag: 'latest' })
  let tip: bigint | null = null
  try {
    tip = BigInt((await c.request({ method: 'eth_maxPriorityFeePerGas' })) as string)
  } catch {
    tip = 0n
  }
  return feeFields(head.baseFeePerGas ?? null, tip)
}

function usd(wei: bigint, chain: Chain): string {
  return `${formatUnitsExact(wei, chain.nativeCurrency.decimals)} USDC`
}

/** On Arc the balance that pays gas is USDC itself, so it must cover the fee AND what is sent. */
async function assertCovered(c: ArcClient, chain: Chain, from: Address, needWei: bigint, sentWei: bigint): Promise<void> {
  const have = await c.getBalance({ address: from })
  if (have < needWei + sentWei)
    throw stop(
      'insufficient_gas',
      `Your wallet holds ${usd(have, chain)} on ${networkName(chain)}, and this needs up to ${usd(needWei, chain)} for the network fee` +
        `${sentWei > 0n ? ` plus the ${usd(sentWei, chain)} sent` : ''}. On Arc the network fee is paid in USDC.`,
    )
}

/** A vault this page will act on: its code is this build and it holds the registry's USDC. */
function assertOurBuild(v: VaultSnapshot): void {
  if (!v.knownBuild) throw stop('not_this_build', 'This vault does not run the build this page deploys, so this page builds no calls for it.')
  if (!v.usdcMatches) throw stop('not_this_build', "This vault holds a token that is not the registry's USDC, so this page builds no calls for it.")
}

/**
 * The vault's code, read again on the host about to simulate the write, must still be this build
 * with the owner and token the snapshot showed written into every immutable slot. That is what
 * makes "only its owner can take it out" true of the owner on screen.
 */
async function assertCodeStill(c: ArcClient, v: VaultSnapshot): Promise<void> {
  const code = await c.getCode({ address: v.address })
  if (!code || !isKnownBuild(code, AGENT_SPEND_POLICY_RUNTIME, AGENT_SPEND_POLICY_IMMUTABLES, { owner: v.owner, usdc: v.usdc }))
    throw stop('not_this_build', 'The code at this address is not the build this page deploys with the owner and USDC shown. Nothing was sent.')
}

// --- deploy ---

/**
 * Prepare the deploy. `funding` is the USDC the setup sends in its third step: the balance check
 * covers the deploy's fee, the two later steps' fees and that amount, so no setup is started that
 * the owner's wallet cannot finish.
 */
export async function prepareDeploy(
  chain: Chain,
  input: { owner: string; operator: string; dailyCap: bigint; autoApproveMax: bigint; funding: bigint },
): Promise<PreparedTx> {
  const usdc = usdcOf(chain)
  if (!usdc) throw stop('refused', `${chain.name} has no USDC in the registry, so no vault is deployed there.`)
  const owner = checkedAddress(input.owner, 'owner')
  const operator = checkedAddress(input.operator, 'operator')
  const caps = capsRefusal(input.dailyCap, input.autoApproveMax, usdc.decimals)
  if (caps) throw stop('refused', caps)
  const op = operatorRefusal(operator, { owner, usdc: usdc.address })
  if (op) throw stop('refused', op)

  const args = [owner, operator, usdc.address, input.dailyCap, input.autoApproveMax] as const
  const data = encodeDeployData({ abi: AGENT_SPEND_POLICY_ABI, bytecode: AGENT_SPEND_POLICY_BYTECODE, args })
  let r
  try {
    r = await onFirstHost(chain, async (c) => {
      // The simulated deploy returns the runtime it would install. It must be this build:
      // the page only ever deploys the code it can recognize afterwards.
      const sim = await c.call({ account: owner, data })
      const estimate = await c.estimateGas({ account: owner, data })
      const nonce = await c.getTransactionCount({ address: owner, blockTag: 'pending' })
      const fee = await feeQuote(c)
      const gas = gasWithMargin(estimate)
      const later = 2n * OWNER_ACTION_GAS * fee.maxFeePerGas
      const scale = 10n ** BigInt(chain.nativeCurrency.decimals - usdc.decimals)
      await assertCovered(c, chain, owner, gas * fee.maxFeePerGas + later, input.funding > 0n ? input.funding * scale : 0n)
      return { sim: sim.data ?? '0x', nonce, fee, gas }
    })
  } catch (e) {
    throw simulationStop(e, 'the deploy')
  }
  const { sim, nonce, fee, gas } = r.value
  // Exactly this build, with this owner and the registry's USDC in every immutable slot.
  if (!isKnownBuild(sim, AGENT_SPEND_POLICY_RUNTIME, AGENT_SPEND_POLICY_IMMUTABLES, { owner, usdc: usdc.address }))
    throw stop('not_this_build', 'The simulated deploy did not install the build this page carries. Nothing was sent; reload the page.')
  const units = (x: bigint) => `${formatUnitsExact(x, usdc.decimals)} USDC (${x.toString()} units)`
  return {
    action: 'deploy',
    what: `Deploy an AgentSpendPolicy vault on ${networkName(chain)}`,
    chain,
    from: owner,
    to: null,
    data,
    call: {
      contract: 'AgentSpendPolicy (new contract)',
      function: 'constructor',
      args: [
        { name: 'owner', value: owner, note: 'you: the only key that can freeze, change the limits, take USDC out or replace the agent key' },
        { name: 'operator', value: operator, note: "the agent's key: it can pay within the limits, and do nothing else" },
        { name: 'usdc', value: usdc.address, note: `the registry's USDC on ${networkName(chain)}` },
        { name: 'dailyCap', value: units(input.dailyCap), note: 'the most the agent can spend in one UTC day' },
        { name: 'autoApproveMax', value: units(input.autoApproveMax), note: 'the largest single payment the agent can make' },
      ],
    },
    gas,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeeWei: gas * fee.maxFeePerGas,
    expect: [],
    predicted: getContractAddress({ from: owner, nonce: BigInt(nonce) }),
    nonce,
    preparedAt: Date.now(),
  }
}

// --- owner calls ---

export type OwnerCall =
  | { fn: 'setFrozen'; frozen: boolean }
  | { fn: 'setPolicy'; dailyCap: bigint; autoApproveMax: bigint; allowlistEnabled: boolean }
  | { fn: 'extend'; seconds: number }
  | { fn: 'revoke' }
  | { fn: 'setOperator'; operator: string }
  | { fn: 'withdraw'; to: string; amount: bigint }

/**
 * Prepare one owner-only call on a vault this page can verify. The session key's expiry is
 * computed here, from the latest block's timestamp on the same host that simulates the call.
 */
export async function prepareOwnerCall(chain: Chain, v: VaultSnapshot, call: OwnerCall): Promise<PreparedTx> {
  assertOurBuild(v)
  const vault = v.address
  const owner = v.owner

  // Refuse first, before any network: these are the page's rules, not the chain's.
  let operator: Address | null = null
  let to: Address | null = null
  if (call.fn === 'setPolicy') {
    const caps = capsRefusal(call.dailyCap, call.autoApproveMax, v.decimals)
    if (caps) throw stop('refused', caps)
  } else if (call.fn === 'extend') {
    const bad = sessionSecondsRefusal(call.seconds)
    if (bad) throw stop('refused', bad)
  } else if (call.fn === 'setOperator') {
    operator = checkedAddress(call.operator, 'operator')
    const bad = operatorRefusal(operator, { owner, usdc: v.usdc, vault })
    if (bad) throw stop('refused', bad)
  } else if (call.fn === 'withdraw') {
    to = checkedAddress(call.to, 'destination')
    const bad = withdrawRefusal({ to, amount: call.amount, balance: v.balance, vault, usdc: v.usdc, decimals: v.decimals })
    if (bad) throw stop('refused', bad)
  }

  let r
  try {
    r = await onFirstHost(chain, async (c) => {
      await assertCodeStill(c, v)
      let expiry: bigint | undefined
      if (call.fn === 'extend') {
        const head = await c.getBlock({ blockTag: 'latest' })
        const e = sessionExpiryFor(head.timestamp, call.seconds)
        if (e === null) throw stop('refused', 'The new expiry could not be computed from chain time. Nothing was sent.')
        expiry = e
      } else if (call.fn === 'revoke') {
        expiry = REVOKED_SESSION_EXPIRY
      }
      if (expiry !== undefined) {
        const bad = expiryRefusal(expiry)
        if (bad) throw stop('refused', bad)
      }
      const data = encode(call, { expiry, operator, to })
      await c.call({ account: owner, to: vault, data })
      const estimate = await c.estimateGas({ account: owner, to: vault, data })
      const fee = await feeQuote(c)
      const gas = gasWithMargin(estimate)
      await assertCovered(c, chain, owner, gas * fee.maxFeePerGas, 0n)
      return { data, expiry, fee, gas, nonce: await nonceHint(c, owner) }
    })
  } catch (e) {
    throw simulationStop(e, 'this call')
  }
  const { data, expiry, fee, gas, nonce } = r.value
  const { action, what, fn, shown, expect } = describe(call, { vault, owner, usdc: v.usdc, decimals: v.decimals, expiry, operator, to })
  return {
    action,
    what,
    chain,
    from: owner,
    to: vault,
    data,
    call: { contract: `AgentSpendPolicy ${vault}`, function: fn, args: shown },
    gas,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeeWei: gas * fee.maxFeePerGas,
    expect,
    ...(expiry !== undefined ? { expiry } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    preparedAt: Date.now(),
  }
}

/** What an owner call is, in words, and what its receipt must carry. */
function describe(
  call: OwnerCall,
  x: { vault: Address; owner: Address; usdc: Address; decimals: number; expiry?: bigint; operator: Address | null; to: Address | null },
): { action: TxAction; what: string; fn: string; shown: ShownArg[]; expect: Expectation[] } {
  const units = (n: bigint) => `${formatUnitsExact(n, x.decimals)} USDC (${n.toString()} units)`
  const event = (eventName: VaultEventName, args: Record<string, string | bigint | boolean>): Expectation => ({
    kind: 'event',
    address: x.vault,
    eventName,
    args,
  })
  switch (call.fn) {
    case 'setFrozen':
      return {
        action: call.frozen ? 'freeze' : 'unfreeze',
        what: call.frozen ? 'Freeze the vault' : 'Unfreeze the vault',
        fn: 'setFrozen',
        shown: [{ name: 'frozen', value: String(call.frozen) }],
        expect: [event('FrozenSet', { frozen: call.frozen })],
      }
    case 'setPolicy':
      return {
        action: 'policy',
        what: 'Change the policy',
        fn: 'setPolicy',
        shown: [
          { name: 'dailyCap', value: units(call.dailyCap) },
          { name: 'autoApproveMax', value: units(call.autoApproveMax) },
          { name: 'allowlistEnabled', value: String(call.allowlistEnabled) },
        ],
        expect: [event('PolicyUpdated', { dailyCap: call.dailyCap, autoApproveMax: call.autoApproveMax, allowlistEnabled: call.allowlistEnabled })],
      }
    case 'extend':
      return {
        action: 'extend',
        what: 'Set the session key expiry',
        fn: 'setSessionKeyExpiry',
        shown: [{ name: 'expiry', value: String(x.expiry), note: 'UNIX seconds: the latest block time plus the lifetime chosen' }],
        expect: [event('SessionKeyExpirySet', { expiry: x.expiry as bigint })],
      }
    case 'revoke':
      return {
        action: 'revoke',
        what: 'Revoke the session key',
        fn: 'setSessionKeyExpiry',
        shown: [{ name: 'expiry', value: REVOKED_SESSION_EXPIRY.toString(), note: 'a second already past on every chain; 0 would mean no time bound at all' }],
        expect: [event('SessionKeyExpirySet', { expiry: REVOKED_SESSION_EXPIRY })],
      }
    case 'setOperator':
      return {
        action: 'operator',
        what: 'Replace the operator',
        fn: 'setOperator',
        shown: [{ name: 'operator', value: x.operator as Address, note: 'the old operator key stops working the moment this lands' }],
        expect: [event('OperatorSet', { operator: x.operator as Address })],
      }
    case 'withdraw':
      return {
        action: 'withdraw',
        what: `Withdraw ${formatUnitsExact(call.amount, x.decimals)} USDC`,
        fn: 'withdraw',
        shown: [
          { name: 'to', value: x.to as Address, note: sameAddress(x.to, x.owner) ? 'your owner account' : undefined },
          { name: 'amount', value: units(call.amount) },
        ],
        expect: [
          event('Withdrawn', { to: x.to as Address, amount: call.amount }),
          { kind: 'transfer', token: x.usdc, from: x.vault, to: x.to as Address, value: call.amount },
        ],
      }
  }
}

function encode(call: OwnerCall, x: { expiry?: bigint; operator: Address | null; to: Address | null }): Hex {
  switch (call.fn) {
    case 'setFrozen':
      return encodeFunctionData({ abi: AGENT_SPEND_POLICY_ABI, functionName: 'setFrozen', args: [call.frozen] })
    case 'setPolicy':
      return encodeFunctionData({
        abi: AGENT_SPEND_POLICY_ABI,
        functionName: 'setPolicy',
        args: [call.dailyCap, call.autoApproveMax, call.allowlistEnabled],
      })
    case 'extend':
    case 'revoke': {
      if (x.expiry === undefined || expiryRefusal(x.expiry) !== null) throw stop('refused', 'No usable expiry. Nothing was sent.')
      return encodeFunctionData({ abi: AGENT_SPEND_POLICY_ABI, functionName: 'setSessionKeyExpiry', args: [x.expiry] })
    }
    case 'setOperator':
      if (!x.operator) throw stop('refused', 'No operator address. Nothing was sent.')
      return encodeFunctionData({ abi: AGENT_SPEND_POLICY_ABI, functionName: 'setOperator', args: [x.operator] })
    case 'withdraw':
      if (!x.to) throw stop('refused', 'No destination address. Nothing was sent.')
      return encodeFunctionData({ abi: AGENT_SPEND_POLICY_ABI, functionName: 'withdraw', args: [x.to, call.amount] })
    default:
      throw stop('refused', 'This page does not build that call.')
  }
}

// --- funding ---

/**
 * Prepare a USDC transfer into a vault this page can verify. Never native value: the vault has
 * no receive function, and the ERC-20 transfer is what its balance() counts.
 */
export async function prepareFund(chain: Chain, v: VaultSnapshot, from: string, amount: bigint): Promise<PreparedTx> {
  assertOurBuild(v)
  const usdc = usdcOf(chain)
  if (!usdc || !sameAddress(usdc.address, v.usdc)) throw stop('not_this_build', "This vault does not hold the registry's USDC.")
  const sender = checkedAddress(from, 'sender')
  if (amount <= 0n) throw stop('refused', 'Enter an amount above 0.')
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [v.address, amount] })
  let r
  try {
    r = await onFirstHost(chain, async (c) => {
      await assertCodeStill(c, v)
      const sim = await c.call({ account: sender, to: usdc.address, data })
      const estimate = await c.estimateGas({ account: sender, to: usdc.address, data })
      const fee = await feeQuote(c)
      const gas = gasWithMargin(estimate)
      // On Arc the ERC-20 face and the native balance are one balance at 6 and 18 decimals.
      // fundRefusal keeps this fee and two later owner actions (a freeze, a withdrawal) behind:
      // funding everything would leave the owner unable to pay the gas to stop the agent.
      const refusal = fundRefusal({
        amount,
        senderWei: await c.getBalance({ address: sender }),
        gas,
        maxFeePerGas: fee.maxFeePerGas,
        nativeDecimals: chain.nativeCurrency.decimals,
        decimals: usdc.decimals,
      })
      if (refusal) throw stop('insufficient_gas', refusal)
      return { sim: sim.data ?? '0x', fee, gas, nonce: await nonceHint(c, sender) }
    })
  } catch (e) {
    throw simulationStop(e, 'the transfer')
  }
  const { sim, fee, gas, nonce } = r.value
  if (!/^0x0*1$/.test(sim)) throw stop('reverted_in_simulation', 'The USDC contract did not return true for this transfer in simulation. Nothing was sent.')
  return {
    action: 'fund',
    what: `Fund the vault with ${formatUnitsExact(amount, usdc.decimals)} USDC`,
    chain,
    from: sender,
    to: usdc.address,
    data,
    call: {
      contract: `USDC ${usdc.address}`,
      function: 'transfer',
      args: [
        { name: 'to', value: v.address, note: 'the vault' },
        { name: 'amount', value: `${formatUnitsExact(amount, usdc.decimals)} USDC (${amount.toString()} units)` },
      ],
    },
    gas,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeeWei: gas * fee.maxFeePerGas,
    expect: [{ kind: 'transfer', token: usdc.address, from: sender, to: v.address, value: amount }],
    ...(nonce !== undefined ? { nonce } : {}),
    preparedAt: Date.now(),
  }
}
