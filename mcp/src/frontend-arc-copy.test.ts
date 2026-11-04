import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { feesFor, gasLimitFor } from './verify-then-pay/prepare.js'

/**
 * What the Arc vault page tells someone about to put in real USDC, held against the contract and
 * against what the wallet path really does. Loaded straight from src/ through Node's type
 * stripping, like frontend-arc-vault.test.ts. Each sentence here exists because an earlier version
 * of it was false or left out something that costs money.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type Copy = Record<string, string> & {
  IF_A_STEP_FAILS: readonly { when: string; then: string }[]
  networkPrompt: (walletName: string, chainId: number | null) => string
  phoneWalletHint: (networkName: string) => string
}
type Headline = { text: string; tone: string; state: string; canPay: boolean }
type Rules = {
  FEE_FLOOR_WEI: bigint
  OWNER_ACTION_GAS: bigint
  feeFields: (base: bigint | null, tip: bigint | null) => { maxFeePerGas: bigint }
  gasWithMargin: (estimate: bigint) => bigint
  vaultHeadline: (v: Record<string, unknown>) => Headline
}
type Call = { method: string; params?: unknown[] }
type Wallet = { request: (a: Call) => Promise<unknown> }
type EvmChain = {
  ensureEvmChain: (eth: Wallet, chain: unknown) => Promise<void>
  askForAnotherAccount: (eth: Wallet) => Promise<void>
  walletChainName: (chain: unknown) => string
}
type ChainLike = { id: string; name: string; chainId: number | null; rpcUrl?: string | null }

const copy = async () => (await import(repoUrl('src/lib/arc/deploy-copy.ts').href)) as Copy
const rules = async () => (await import(repoUrl('src/lib/arc/vault-rules.ts').href)) as Rules
const evm = async () => (await import(repoUrl('src/lib/evm-chain.ts').href)) as EvmChain
const chains = async () => ((await import(repoUrl('src/lib/chains.ts').href)) as { CHAIN_BY_ID: Record<string, ChainLike> }).CHAIN_BY_ID

type Failure = { code: string; message: string }
type Send = { sendPrepared: (w: Wallet, p: unknown, onStep: (s: string) => void) => Promise<unknown>; failureOf: (e: unknown) => Failure }
type Explain = { explainFailure: (f: Failure) => { title: string; body?: string; next: string } }
type Reread = {
  REREAD_MS: number
  BEHIND_MS: number
  rereadMs: (step: string, behind: boolean) => number | null
  newerRead: <T>(held: T | null, read: T) => T
}
type TxRules = { setupStep: (s: unknown, prepared: boolean, snapshot: unknown) => string }

const send = async () => (await import(repoUrl('src/lib/arc/send.ts').href)) as Send
const explain = async () => (await import(repoUrl('src/lib/arc/failure-explain.ts').href)) as Explain
const reread = async () => (await import(repoUrl('src/lib/arc/vault-reread.ts').href)) as Reread
const txRules = async () => (await import(repoUrl('src/lib/arc/tx-rules.ts').href)) as TxRules

const FLOW = 'src/components/app/arc/DeployFlow.tsx'
const CONTRACT = 'mcp/contracts/AgentSpendPolicy.sol'

/** A wallet that does not know the chain, and answers every other method from `answers`. */
function walletWithout(answers: Record<string, (params?: unknown[]) => unknown>) {
  const calls: Call[] = []
  const wallet: Wallet = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      const answer = answers[method]
      if (!answer) throw new Error(`the fake wallet does not answer ${method}`)
      return answer(params)
    },
  }
  return { wallet, calls }
}

const fails = (error: unknown) => () => {
  throw error
}

test('the leak sentence says the daily limit comes back every day, and doubles around midnight', async () => {
  const c = await copy()
  // The contract's day is a calendar day and its counter is per day, so this is what a leak can cost.
  const sol = repo(CONTRACT)
  assert.match(sol, /return block\.timestamp \/ 86400;/)
  assert.match(sol, /spentOnDay\[d\] \+ amount > dailyCap/)
  assert.match(c.AGENT_KEY_CANNOT, /if it leaks/)
  assert.match(c.AGENT_KEY_CANNOT, /your daily limit every day/)
  assert.match(c.AGENT_KEY_CANNOT, /the vault is empty/)
  assert.match(c.AGENT_KEY_CANNOT, /up to twice the limit/)
  assert.match(repo(FLOW), /It applies again every day, so it is not a total\./)
})

test('the page says the owner account is for good, and promises control only to whoever holds it', async () => {
  const c = await copy()
  const sol = repo(CONTRACT)
  assert.match(sol, /address public immutable owner;/)
  assert.doesNotMatch(sol, /function (setOwner|transferOwnership)\b/, 'an owner can be changed now: this copy and the warnings around it are wrong')
  assert.match(c.OWNER_KEY_LINE, /can never be changed/)
  assert.match(c.OWNER_KEY_LINE, /If you lose it, nobody can freeze the vault or take the USDC out/)
  assert.match(c.OWNER_KEY_LINE, /they can take all the USDC/)
  assert.match(c.OWNER_KEY_LINE, /costs a network fee/)
  assert.doesNotMatch(c.WHAT_IS_A_VAULT, /whenever you want/)
  assert.match(c.WHAT_IS_A_VAULT, /While you hold the account that owns it/)
  assert.match(c.AFTER_SETUP, /as long as you hold the owner account/)
  assert.match(repo(FLOW), /\{WRONG_OWNER_WAY_OUT\}/)
})

test('the allowlist is not offered as protection while the page cannot add to it', async () => {
  const c = await copy()
  // The day the page can add a payee, this fails and the sentence gets to change.
  const write = repo('src/lib/arc/vault-write.ts')
  assert.doesNotMatch(write, /fn: 'setAllowed'/, 'the page can add payees now: say so in AGENT_KEY_CANNOT and the headline')
  assert.match(c.AGENT_KEY_CANNOT, /It can pay any address\./)
  assert.match(c.AGENT_KEY_CANNOT, /this page cannot add addresses to that list yet/)
  assert.doesNotMatch(c.AGENT_KEY_CANNOT, /unless you turn on the allowlist/)
  assert.match(repo('src/components/app/arc/VaultStatus.tsx'), /This page cannot show the list or add to it/)
})

test('a vault with its allowlist on never reads green, since the list may be empty', async () => {
  const r = await rules()
  const v = {
    frozen: false,
    operator: '0x2222222222222222222222222222222222222222',
    sessionKeyExpiry: 1_900_000_000n,
    expired: false,
    allowlistEnabled: true,
    balance: 1_000_000n,
    remainingToday: 1_000_000n,
    decimals: 6,
  }
  for (const over of [{}, { balance: 500_000n }, { remainingToday: null }]) {
    const h = r.vaultHeadline({ ...v, ...over })
    assert.notEqual(h.tone, 'ok', Object.keys(over).join() || 'plain')
    assert.match(h.state, /^Allowlist on/)
    assert.doesNotMatch(h.state, /Can pay/)
    assert.match(h.text, /every agent payment is refused/)
    assert.match(h.text, /Check a payee below/)
  }
  // With it off, nothing about the list is said and the word stays green.
  const off = r.vaultHeadline({ ...v, allowlistEnabled: false })
  assert.equal(off.tone, 'ok')
  assert.equal(off.state, 'Can pay')
  assert.doesNotMatch(off.text, /allowlist|payee/i)
})

test('no sentence offers an owner payment the page has no button for', async () => {
  // ownerPay exists in the contract and is not an owner call on this page.
  assert.doesNotMatch(repo('src/lib/arc/vault-write.ts'), /fn: 'ownerPay'/, 'the page can pay as the owner now: these sentences can name it')
  assert.match(repo(CONTRACT), /function withdraw\(address to, uint256 amount\) external onlyOwner/)
  const flow = repo(FLOW)
  const status = repo('src/components/app/arc/VaultStatus.tsx')
  assert.doesNotMatch(flow, /You can still pay more yourself/)
  assert.doesNotMatch(status, /only the owner can pay more|unless the owner pays it/)
  assert.match(flow, /withdraw to that address yourself/)
  assert.match(status, /withdrawing to that address/)
})

test('the last screen says the agent key needs USDC of its own, and the figure is what a payment can cost', async () => {
  const c = await copy()
  const r = await rules()
  // The operator signs pay() and so pays for it: this is the gas one payment was measured at. What
  // the paid check demands of the key is the gas limit, the estimate plus its margin, at the max fee.
  assert.match(repo('mcp/src/verify-then-pay/core.ts'), /const need = gasLimitFor\(sim\.gas\) \* fees\.fees\.maxFeePerGas/)
  const { maxFeePerGas } = r.feeFields(r.FEE_FLOOR_WEI, 1_000_000_000n)
  const quoted = feesFor(r.FEE_FLOOR_WEI)
  assert.ok(quoted.ok)
  assert.equal(quoted.fees.maxFeePerGas, maxFeePerGas, 'the page and the paid check price a payment alike')
  assert.equal(r.gasWithMargin(116_370n), gasLimitFor(116_370n))
  const needWei = gasLimitFor(116_370n) * maxFeePerGas
  const needUsdc = Number(needWei) / 1e18
  assert.equal(c.AGENT_PAYMENT_FEE_AT_MOST, `about ${(Math.ceil(needUsdc * 1000) / 1000).toFixed(3)} USDC`)
  // The amount it names passes the check that would otherwise answer InsufficientGas.
  const named = BigInt(Math.round(Number(/[\d.]+/.exec(c.AGENT_PAYMENT_FEE_AT_MOST)?.[0]) * 1e6)) * 1_000_000_000_000n
  assert.ok(named >= needWei, `${named} wei is below the ${needWei} wei the check demands`)
  assert.match(c.AGENT_KEY_FEES, /from its own balance/)
  assert.match(c.AGENT_KEY_FEES, /The vault's USDC cannot pay that fee/)
  assert.ok(c.GIVE_THE_AGENT.includes(c.AGENT_KEY_FEES))
  const flow = repo(FLOW)
  assert.match(flow, /\{GIVE_THE_AGENT\}/)
  assert.match(flow, /\{AGENT_KEY_CAN\} \{AGENT_KEY_CANNOT\} \{AGENT_KEY_FEES\}/)
})

test('only verify-then-pay is said to need a Gateway balance, because a check can also be paid from plain USDC', async () => {
  const c = await copy()
  // The rail that needs none: on Arc Mainnet the registry declares a token to settle in by EIP-3009.
  const { CHAINS } = (await import('./chains/registry.js')) as unknown as { CHAINS: { id: string; payment?: { note?: string } }[] }
  assert.match(CHAINS.find((x) => x.id === 'arc-mainnet')?.payment?.note ?? '', /our own EIP-3009 facilitator \(the buyer signs/)
  assert.match(repo('mcp/src/http/x402-3009-routes.ts'), /\/api\/x402\/tools\//)
  // The path that does: its 402 says to sign from a Circle Gateway balance.
  assert.match(repo('mcp/src/verify-then-pay/core.ts'), /from your Circle Gateway balance/)
  assert.match(c.GIVE_THE_AGENT, /If your agent uses verify-then-pay .* it also needs a Circle Gateway balance\./)
  assert.match(c.GIVE_THE_AGENT, /paid from plain USDC the agent holds, with no Gateway balance/)
  assert.doesNotMatch(c.GIVE_THE_AGENT, /To buy checks through A-Identity/)
})

test('the balance the page asks for is what its own check needs, and the review is not said to show every fee', async () => {
  const c = await copy()
  const r = await rules()
  const { maxFeePerGas } = r.feeFields(r.FEE_FLOOR_WEI, 1_000_000_000n)
  // The deploy at its measured estimate plus the margin, and the two later steps, as prepareDeploy reserves them.
  const needUsdc = Number((r.gasWithMargin(966_000n) + 2n * r.OWNER_ACTION_GAS) * maxFeePerGas) / 1e18
  assert.equal(c.BALANCE_NEEDED_ABOUT, `about ${(Math.ceil(needUsdc * 100) / 100).toFixed(2)} USDC`)
  assert.ok(c.FEES_LINE.includes(c.BALANCE_NEEDED_ABOUT))
  assert.doesNotMatch(c.FEES_LINE, /shows the most each fee can be/)
  // Step 2 goes to the wallet with no review, so the fee warning stands beside its button.
  const flow = repo(FLOW)
  const step2 = flow.slice(flow.indexOf('Set it now: valid for'), flow.indexOf('{/* Step 3. */}'))
  assert.match(step2, /\{WALLET_MAY_REPRICE\}/)
  // The expiry is worked out when the wallet is asked, not when the step lands.
  assert.doesNotMatch(flow, /after this step lands/)
  assert.match(flow, /after your wallet asks for this step/)
})

test('the failure list does not promise a clean slate to a wallet error, and names the way back', async () => {
  const c = await copy()
  const declined = c.IF_A_STEP_FAILS.find((f) => /decline/.test(f.when))
  const errored = c.IF_A_STEP_FAILS.find((f) => /error/.test(f.when))
  assert.ok(declined && errored && declined !== errored)
  assert.match(declined.then, /Nothing was sent/)
  assert.doesNotMatch(errored.then, /^Nothing was sent/)
  assert.match(errored.then, /activity list/)
  assert.match(errored.then, /do not send it again/)
  const reload = c.IF_A_STEP_FAILS.find((f) => /reloaded/.test(f.when))
  assert.match(reload?.then ?? '', /press Deploy a vault you own/)
  assert.match(repo('src/components/app/arc/VaultPicker.tsx'), /Deploy a vault you own/, 'the button that sentence names')
})

test('a wallet error with no hash is followed on the chain at steps 2 and 3, so the page does carry on', async () => {
  const c = await copy()
  const { REREAD_MS, BEHIND_MS, rereadMs, newerRead } = await reread()
  const { setupStep } = await txRules()
  assert.match(c.IF_A_STEP_FAILS.find((f) => /error/.test(f.when))?.then ?? '', /carries on when it lands/)
  // The steps a wallet error leaves the page on, with no record to follow, are read again like the pending ones.
  for (const step of ['expiry', 'expiry-pending', 'fund', 'fund-pending']) assert.equal(rereadMs(step, false), REREAD_MS, step)
  for (const step of ['form', 'review', 'sending', 'deploying', 'deploy-failed', 'done']) assert.equal(rereadMs(step, false), null, step)
  assert.equal(rereadMs('done', true), BEHIND_MS)
  const flow = repo(FLOW)
  assert.match(flow, /const every = rereadMs\(step, fundedReadBehind\)/)
  assert.match(flow, /setInterval\(\(\) => void readBack\(\), every\)/)
  // And such a read is enough to move on: no record exists, and the vault's own state decides.
  const vault = '0x1111111111111111111111111111111111111111'
  const setup = { network: 'eip155:1', vault, funding: 500_000n }
  const read = (over: Record<string, unknown>) => ({ address: vault, network: 'eip155:1', block: 10n, sessionKeyExpiry: 0n, balance: 0n, ...over })
  assert.equal(setupStep(setup, false, read({})), 'expiry')
  assert.equal(setupStep(setup, false, read({ sessionKeyExpiry: 5n })), 'fund')
  assert.equal(setupStep(setup, false, read({ sessionKeyExpiry: 5n, balance: 500_000n })), 'done')
  // A host behind the last read cannot put a step that moved on back where it was.
  const landed = read({ block: 11n, sessionKeyExpiry: 5n })
  const behind = read({ block: 10n })
  assert.equal(newerRead(landed, behind), landed)
  assert.equal(newerRead(behind, landed), landed)
  assert.equal(newerRead(null, behind), behind)
  assert.equal(newerRead(read({ address: '0x2222222222222222222222222222222222222222', block: 99n }), behind), behind, 'another vault says nothing about this one')
  assert.match(flow, /setSnapshot\(\(held\) => newerRead\(held, r\.data\)\)/)
  // A wallet promise left open cannot hold the page once the chain has moved step 2 on, and its failure goes with it.
  assert.match(flow, /was === 'expiry' && step !== 'expiry' && step !== 'expiry-pending'\) \{\s+release\('expiry'\)\s+setFailure\(null\)/)
  // A transfer of less than planned never reaches the funding, so the page says what the vault holds.
  assert.match(flow, /liveVault\.balance > 0n[\s\S]{0,260}The vault already holds/)
  // The notice beside the button agrees with the list: a wallet error is not simply "try again".
  const { explainFailure } = await explain()
  const told = explainFailure({ code: 'wallet_error', message: 'Internal JSON-RPC error.' })
  assert.match(told.next, /activity list/)
  assert.match(told.next, /do not send it again/)
})

test('a wallet that stays off the network says why, and only a wrong network is told to switch', async () => {
  const { sendPrepared, failureOf } = await send()
  const { explainFailure } = await explain()
  const { ensureEvmChain } = await evm()
  const r = await rules()
  const mainnet = (await chains())['arc-mainnet']
  const OWNER = '0x1111111111111111111111111111111111111111'
  const prepared = { action: 'freeze', chain: mainnet, from: OWNER, to: '0x2222222222222222222222222222222222222222', data: '0x', gas: 52_000n, maxFeePerGas: r.FEE_FLOOR_WEI, maxPriorityFeePerGas: 0n }
  const attempt = async (answers: Record<string, (params?: unknown[]) => unknown>) => {
    const { wallet, calls } = walletWithout(answers)
    let failure: Failure | null = null
    await sendPrepared(wallet, prepared, () => {}).catch((e) => {
      failure = failureOf(e)
    })
    assert.ok(failure, 'the send went through')
    assert.equal(calls.some((x) => x.method === 'eth_sendTransaction'), false, 'nothing is sent off the network')
    return { failure: failure as Failure, told: explainFailure(failure), calls }
  }
  const busyError = Object.assign(new Error('Request already pending'), { code: -32002 })

  // A prompt already open, on the first switch.
  const busy = await attempt({ wallet_switchEthereumChain: fails(busyError) })
  assert.equal(busy.failure.code, 'wallet_pending')
  assert.match(busy.told.title, /already has a request open/)
  assert.doesNotMatch(busy.told.title, /network/)
  assert.doesNotMatch(busy.told.next, /Switch/)
  assert.equal(busy.calls.some((x) => x.method === 'wallet_addEthereumChain'), false)

  // Or on the add, or on the switch after the add: the same.
  const busyAdding = await attempt({ wallet_switchEthereumChain: fails(new Error('Unrecognized chain')), wallet_addEthereumChain: fails(busyError) })
  assert.equal(busyAdding.failure.code, 'wallet_pending')
  let switches = 0
  const busyAfter = await attempt({
    wallet_switchEthereumChain: () => {
      if (switches++ === 0) throw new Error('Unrecognized chain')
      throw busyError
    },
    wallet_addEthereumChain: () => null,
  })
  assert.equal(busyAfter.failure.code, 'wallet_pending')

  // A wallet that cannot add the chain: the next step agrees with the sentence above it.
  const cannot = await attempt({ wallet_switchEthereumChain: fails(new Error('Unrecognized chain')), wallet_addEthereumChain: fails(new Error('Missing or invalid. request()')) })
  assert.equal(cannot.failure.code, 'chain_not_added')
  assert.match(cannot.told.title, /could not add this network/)
  assert.match(cannot.told.body ?? '', /computer browser/)
  assert.doesNotMatch(cannot.told.next, /Switch/)
  assert.match(cannot.told.next, /Nothing was sent/)

  // A person's no is a no, whichever screen it was on.
  const no = Object.assign(new Error('User rejected'), { code: 4001 })
  const declined = await attempt({ wallet_switchEthereumChain: fails(no) })
  assert.equal(declined.failure.code, 'rejected')
  assert.match(declined.told.title, /You declined/)
  const declinedAdd = await attempt({ wallet_switchEthereumChain: fails(new Error('Unrecognized chain')), wallet_addEthereumChain: fails(no) })
  assert.equal(declinedAdd.failure.code, 'rejected')

  // Only a wallet that really is elsewhere hears about switching.
  const stuck = await attempt({ wallet_switchEthereumChain: () => null })
  assert.equal(stuck.failure.code, 'wrong_chain')
  assert.match(stuck.told.next, /Switch the network/)
  assert.match(stuck.failure.message, /still on another network/)

  // A wallet that fails in a way this page did not name is not called a wrong network either.
  const odd: Wallet = {
    request: async ({ method }) => {
      if (method === 'eth_chainId') throw new Error('The wallet is disconnected')
      throw new Error(`the fake wallet does not answer ${method}`)
    },
  }
  await assert.rejects(ensureEvmChain(odd, mainnet), /disconnected/)
  const oddFailure = await sendPrepared(odd, prepared, () => {}).then(
    () => assert.fail('the send went through'),
    (e) => failureOf(e),
  )
  assert.equal(oddFailure.code, 'wallet_error')
})

test('the wallet is asked to add Arc Mainnet under the public name, and the page warns before that screen', async () => {
  const { ensureEvmChain, walletChainName } = await evm()
  const byId = await chains()
  const c = await copy()
  const mainnet = byId['arc-mainnet']
  const testnet = byId.arc
  const added = async (chain: ChainLike) => {
    const { wallet, calls } = walletWithout({
      wallet_switchEthereumChain: fails(Object.assign(new Error('Unrecognized chain'), { code: 4902 })),
      wallet_addEthereumChain: () => null,
    })
    await ensureEvmChain(wallet, chain).catch(() => undefined)
    const call = calls.find((x) => x.method === 'wallet_addEthereumChain')
    return (call?.params?.[0] as { chainName: string; chainId: string }) ?? null
  }
  const main = await added(mainnet)
  assert.equal(main.chainName, 'Arc', 'the name MetaMask compares with its chain list')
  assert.equal(main.chainId, `0x${(mainnet.chainId as number).toString(16)}`)
  // Our own copy keeps its name, and the testnet is not touched.
  assert.equal(mainnet.name, 'Arc Mainnet')
  assert.equal((await added(testnet)).chainName, testnet.name)
  assert.equal(walletChainName(testnet), testnet.name)
  // Said before the prompt, with the fact the person can check.
  const said = c.networkPrompt('Arc', mainnet.chainId)
  assert.match(said, /add this network and switch to it/)
  assert.ok(said.includes(String(mainnet.chainId)))
  assert.match(said, /moves no USDC and has no fee/)
  const flow = repo(FLOW)
  assert.match(flow, /<h3[^>]*>Your wallet will ask you to confirm up to three transactions<\/h3>/)
  assert.equal(flow.match(/networkPrompt\(walletChainName\(chain\), chain\.chainId\)/g)?.length, 2, 'once with the steps, once beside the Deploy button')
})

test('a wallet that cannot add the network gets a plain sentence, never the library error', async () => {
  const { ensureEvmChain } = await evm()
  const byId = await chains()
  const mainnet = byId['arc-mainnet']
  const raw = 'Missing or invalid. request() chainId: eip155:12345'
  const { wallet } = walletWithout({
    wallet_switchEthereumChain: fails(new Error('Unrecognized chain')),
    wallet_addEthereumChain: fails(new Error(raw)),
  })
  await assert.rejects(ensureEvmChain(wallet, mainnet), (e: Error) => {
    assert.ok(!e.message.includes('request()'), 'the raw library text reached the page')
    assert.ok(!e.message.includes('Missing or invalid'))
    assert.match(e.message, /computer browser with the MetaMask or Rabby extension/)
    assert.match(e.message, /With a phone wallet, add it in the wallet first/)
    assert.ok(e.message.includes(String(mainnet.chainId)))
    return true
  })
  // A person's no is still a no, not a failure to add.
  const declined = walletWithout({
    wallet_switchEthereumChain: fails(new Error('Unrecognized chain')),
    wallet_addEthereumChain: fails(Object.assign(new Error('User rejected'), { code: 4001 })),
  })
  await assert.rejects(ensureEvmChain(declined.wallet, mainnet), /You declined to add/)
  // A prompt already open is not an unknown chain: nothing asks to add it.
  const busy = walletWithout({ wallet_switchEthereumChain: fails(Object.assign(new Error('Request already pending'), { code: -32002 })) })
  await assert.rejects(ensureEvmChain(busy.wallet, mainnet), /already has a request open/)
  assert.equal(busy.calls.some((x) => x.method === 'wallet_addEthereumChain'), false)
  // And the phone choice says so before anyone picks it.
  const c = await copy()
  assert.match(c.phoneWalletHint('Arc Mainnet'), /computer browser with MetaMask or Rabby/)
  assert.match(repo('src/components/app/arc/WalletBar.tsx'), /phoneWalletHint\(networkName\(target\)\)/)
})

test('a wrong account connected first has a way out on the page, and funding it is not the only advice', async () => {
  const { askForAnotherAccount } = await evm()
  const c = await copy()
  // Asks for the permission screen: eth_requestAccounts returns what is already allowed, with no screen.
  const ok = walletWithout({ wallet_requestPermissions: () => [{ parentCapability: 'eth_accounts' }] })
  await askForAnotherAccount(ok.wallet)
  assert.deepEqual(ok.calls, [{ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }])
  const no = walletWithout({ wallet_requestPermissions: fails(Object.assign(new Error('User rejected'), { code: 4001 })) })
  await assert.rejects(askForAnotherAccount(no.wallet), /Nothing changed/)
  const cannot = walletWithout({ wallet_requestPermissions: fails(new Error('Method not found: wallet_requestPermissions')) })
  await assert.rejects(askForAnotherAccount(cannot.wallet), (e: Error) => {
    assert.ok(!e.message.includes('wallet_requestPermissions'), 'the raw wallet text reached the page')
    assert.match(e.message, /list of connected sites/)
    return true
  })
  // On the strip, wired to the hook, with the phone wallet's own way out.
  const bar = repo('src/components/app/arc/WalletBar.tsx')
  assert.match(bar, /wallet\.chooseAccount\(\)/)
  assert.match(bar, /\{USE_ANOTHER_ACCOUNT\}/)
  assert.match(bar, /\$\{CONNECT_RIGHT_ACCOUNT\}/)
  const hook = repo('src/components/app/arc/useArcWallet.ts')
  assert.match(hook, /askForAnotherAccount\(w\.provider\)/)
  assert.match(hook, /setError\(PHONE_ACCOUNT_WAY_OUT\)/)
  assert.match(hook, /setError\(ACCOUNT_UNCHANGED\)/)
  // The advice that used to send people to fund the agent's key.
  const notice = repo('src/lib/arc/failure-explain.ts')
  assert.match(notice, /Check that this is the account holding your USDC/)
  assert.doesNotMatch(notice, /next: 'Send a little USDC to this account/)
  assert.match(c.WRONG_ACCOUNT, /press Use another account/)
  assert.equal(c.USE_ANOTHER_ACCOUNT, 'Use another account')
})

test('the last screen always leaves a way back and a way to the hash', async () => {
  const c = await copy()
  const flow = repo(FLOW)
  const done = flow.slice(flow.indexOf('Your vault is set up.'), flow.indexOf('<VaultCountNotice'))
  // No settled record, as after a deploy found at its address: the explorer has the hash.
  assert.match(done, /setup\.deploy\?\.outcome === 'settled' \?/)
  assert.match(done, /\{NO_HASH_LINE\}/)
  assert.match(done, /addressUrl\(chain, setup\.vault\)/)
  assert.match(c.NO_HASH_LINE, /activity list/)
  // The link is built from where the page is, with the two params the page reads back.
  assert.match(done, /\{SAVE_LINK_LINE\}/)
  assert.match(done, /window\.location\.origin/)
  assert.match(done, /\?network=\$\{encodeURIComponent\(setup\.network\)\}&contract=\$\{setup\.vault\}/)
  const page = repo('src/routes/app/ArcVault.tsx')
  assert.match(page, /params\.get\('network'\)/)
  assert.match(page, /params\.get\('contract'\)/)
})

test('the new sentences use no word a newcomer would have to look up', async () => {
  const c = await copy()
  const said = [
    c.FEES_LINE,
    c.AGENT_KEY_FEES,
    c.GIVE_THE_AGENT,
    c.AFTER_SETUP,
    c.CONNECT_RIGHT_ACCOUNT,
    c.WRONG_OWNER_WAY_OUT,
    c.ACCOUNT_UNCHANGED,
    c.PHONE_ACCOUNT_WAY_OUT,
    c.SAVE_LINK_LINE,
    c.NO_HASH_LINE,
    c.phoneWalletHint('Arc Mainnet'),
    c.networkPrompt('Arc', 1),
  ].join(' ')
  assert.doesNotMatch(said, /\b(nonce|calldata|simulat\w*|EVM|ERC-20|gas|gwei|bytecode|pay\(\)|AgentSpendPolicy|dust|RPC|operator)\b/i)
})
