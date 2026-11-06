/**
 * What the deploy flow tells someone who has never deployed a contract: what each of the three
 * wallet confirmations does, what it costs, who holds which key, how far the contract has been
 * reviewed, and what to do when a step fails.
 *
 * Kept in one module with no imports so mcp/src/frontend-arc-vault.test.ts can load it straight
 * from src/ and hold what it promises: the costs against the fee floor, and the words a newcomer
 * would have to look up. Short sentences. A term that is not everyday English is explained where
 * it appears.
 */

/** A deploy takes about 966,000 gas and an owner call or USDC transfer about 60,000, at Arc's 20 gwei floor. */
export const DEPLOY_FEE_ABOUT = 'about 0.02 USDC'
export const CALL_FEE_ABOUT = 'about 0.001 USDC'
/**
 * What the page checks for before a deploy, at today's fee: the deploy's gas limit (its estimate plus
 * a margin) and the two later steps' limits, all at the page's max fee. More than is normally spent,
 * because each is the most it can cost. Held against vault-rules.ts in frontend-arc-copy.test.ts.
 */
export const BALANCE_NEEDED_ABOUT = 'about 0.06 USDC'
/**
 * What the agent's key must hold for one payment: about 116,000 gas plus the 20% margin, at the max
 * fee, rounded up. It is the gas limit that counts, not the estimate: verify-then-pay refuses a key
 * below this before pay() is ever sent, and a node checks the same thing up front. Held against
 * verify-then-pay/prepare.ts in frontend-arc-copy.test.ts.
 */
export const AGENT_PAYMENT_FEE_AT_MOST = 'about 0.006 USDC'

export const WHAT_IS_A_VAULT =
  'A vault is a small contract that holds USDC for your agent. Your agent can spend from it only within the limits you set here. While you hold the account that owns it, you can freeze it or take the USDC back at any time.'

/** The three confirmations, in order. Your wallet asks for each one separately. */
export const CONFIRMATIONS: readonly { title: string; does: string; cost: string }[] = [
  {
    title: 'Create your vault',
    does: 'Puts your own vault contract on the network, with your account as its owner. No USDC goes into it yet.',
    cost: `Network fee: ${DEPLOY_FEE_ABOUT}.`,
  },
  {
    title: "Set when the agent's key ends",
    does: "Gives the agent's key an end date, so it cannot keep spending forever. No USDC moves.",
    cost: `Network fee: ${CALL_FEE_ABOUT}.`,
  },
  {
    title: 'Put USDC in',
    does: 'Sends the amount you choose from your wallet into the vault. If you choose 0, this step is skipped and you can add USDC later.',
    cost: `That amount, plus a network fee of ${CALL_FEE_ABOUT}.`,
  },
]

export const FEES_LINE =
  `On Arc, network fees are paid in USDC, so your wallet needs a little USDC on this network before you start. At today's fee, have ${BALANCE_NEEDED_ABOUT} plus what you plan to put in. That is what the page checks for, and ${DEPLOY_FEE_ABOUT} of it is normally spent. The first review shows the most the deploy fee can be. Your wallet shows each fee before you confirm.`

/**
 * Said before the wallet's first screen, which may not be the deploy: a wallet without this network
 * asks to add it, and the page cannot know what that screen looks like in every wallet.
 */
export const networkPrompt = (walletName: string, chainId: number | null): string =>
  `Before the first one, your wallet may ask to add this network and switch to it. It may call it ${walletName}, and it may show a caution. Check that it shows chain id ${chainId}. That step moves no USDC and has no fee.`

export const OWNER_KEY_LINE =
  "Your key stays in your wallet. A-Identity never sees it and signs nothing here. Only your account can freeze the vault, change its limits, replace the agent key or take USDC out. This owner account can never be changed. If you lose it, nobody can freeze the vault or take the USDC out, and the agent's key keeps working until its end date. If someone else gets it, they can take all the USDC in the vault. Keep a little USDC in it too: a freeze or a withdrawal costs a network fee."

export const AGENT_KEY_CAN = "The agent's key is a separate address your agent signs with. It can do one thing: pay from the vault, within your limits, until its end date."

export const AGENT_KEY_CANNOT =
  'It cannot change the limits, unfreeze the vault, replace itself or go over the limits. It can pay any address. The contract can limit it to a list of addresses you approve, but this page cannot add addresses to that list yet, so plan on any address. So if it leaks, whoever holds it can spend up to your daily limit every day, until you freeze the vault, replace the key, the key ends or the vault is empty. The day resets at 00:00 UTC, so up to twice the limit can go within seconds around that time.'

/** Beside the field where the owner picks the daily limit: this is the number they size for a leak. */
export const DAILY_LIMIT_TWICE = 'Around that reset up to twice this can go within seconds, so set it to half the most you would accept losing quickly.'

/** A cap change is not a stop: it undoes nothing and the new cap opens again at the reset. */
export const LOWERING_THE_CAP = 'Lowering it does not undo what was already spent today, and the new cap applies again after 00:00 UTC. To stop the agent now, freeze the vault.'

/**
 * The agent's day and the owner's payments share one counter on the vault. An owner payment comes from
 * the approval on this page or from the owner's own tools, so the sentence names the wallet and not a
 * button. Withdrawals are outside the counter.
 */
export const OWNER_PAYMENT_COUNTS = "If your agent hands you a payment to approve and you send it from your wallet (the contract calls it ownerPay), it counts toward the agent's day and can stop the agent until 00:00 UTC, unless you raise the cap. A withdrawal does not count."

/** The operator pays for its own pay() call, so a funded vault is not yet an agent that can pay. */
export const AGENT_KEY_FEES = `The agent's key pays a network fee for each payment, in USDC, from its own balance on this network. The vault's USDC cannot pay that fee. Send the agent's key a small amount: ${AGENT_PAYMENT_FEE_AT_MOST} covers one payment at today's fee.`

export const REVIEW_LINE = 'This contract has had internal reviews and no outside audit. Those reviews were AI-assisted. A bug could lose what you put in. Put in only what you can afford to lose.'

/** What each way of failing means, and what to do. Every one is true at every step of the setup. */
export const IF_A_STEP_FAILS: readonly { when: string; then: string }[] = [
  { when: 'You pressed decline', then: 'Nothing was sent and nothing was spent. Press the button again when you are ready.' },
  { when: 'Your wallet showed an error', then: "Look at its activity list first. If nothing is there, nothing was sent, and this page offers a way to try again. If the transaction is there, do not send it again. Wait for it: this page checks every few seconds and carries on when it lands." },
  { when: 'You reloaded the page or closed the tab', then: 'Your place is saved in this browser. Open this page again. If your setup does not show, press Deploy a vault you own and it carries on. A phone wallet may need connecting again.' },
  { when: 'The page keeps waiting and nothing seems to happen', then: "Open your wallet and look at its activity list. Do not sign a new transaction until you have looked: the first one may still go through." },
  { when: 'A transaction failed on the network', then: 'Its network fee is spent. The USDC you meant to send is still in your wallet. The page says what to do next.' },
  { when: 'Your vault exists but you stopped before step 2', then: "Come back and finish step 2 before you put USDC in. Until then the agent's key has no end date." },
]

/** Said when a step needs the wallet and the page has none: after a reload with a phone wallet, or a locked wallet. */
export const WALLET_GONE =
  'Your wallet is not connected to this page right now, so nothing can be signed. This is normal after a reload with a phone wallet, or when a browser wallet is locked. Unlock it, or press Connect wallet at the top of this page, and pick the owner account. Your setup is saved.'

/** Said when a wallet is connected on an account that is not the setup's owner. */
export const WRONG_ACCOUNT = "Your wallet is on a different account. Pick the owner account in your wallet to carry on. If your wallet will not switch here, press Use another account at the top of this page. Your setup is saved."

/** Said beside a prepared write, while the wallet's own screen is what the person is about to trust. */
export const WALLET_MAY_REPRICE =
  'Your wallet shows this call and asks you to confirm it. It may show a different network fee from the one here, because some wallets set their own. Arc needs a max fee of at least 20 gwei (gwei is the tiny unit wallets use for this fee). If your wallet shows less, raise it before you confirm, or Arc drops the transaction without telling anyone.'

/** The strip's button that asks the wallet which accounts this site may see. */
export const USE_ANOTHER_ACCOUNT = 'Use another account'

/** Said before Connect: the connected account becomes the owner, and that can never be changed. */
export const CONNECT_RIGHT_ACCOUNT =
  'To deploy, first make your main account active in your wallet, the one holding your USDC. The account you connect becomes the vault owner, and that can never be changed.'

/** The owner field on the form, once an account is connected. */
export const WRONG_OWNER_WAY_OUT = `This can never be changed. If this is not your main account, press ${USE_ANOTHER_ACCOUNT} at the top of this page.`

/** A phone wallet's session has no such screen: a new connection is how it picks an account. */
export const PHONE_ACCOUNT_WAY_OUT = 'With a phone wallet, press Forget this wallet, then connect again and pick the account in your phone wallet.'

/** Said after the wallet was asked and the same account came back. */
export const ACCOUNT_UNCHANGED =
  'Your wallet still shows the same account here. To use another one, make it the active account in your wallet, then press the refresh icon next to the address.'

/** Beside the phone wallet choice: a session made without this network cannot add it afterwards. */
export const phoneWalletHint = (networkName: string): string =>
  `Use a computer browser with MetaMask or Rabby if you can. With a phone wallet, add ${networkName} in the wallet first: this page may not be able to add it for you.`

/** On the last screen, so getting back never depends on being on a list. */
export const SAVE_LINK_LINE = "Save this link. From another browser, it takes you back to your vault's controls."

/** On the last screen, when this page never saw the transaction that created the vault. */
export const NO_HASH_LINE = "This page did not see the transaction that created this vault. You can find it in your wallet's activity list, or on the vault's explorer page."

export const AFTER_SETUP =
  'You can freeze the vault, change its limits or take USDC out at any time from its page, as long as you hold the owner account and it has a little USDC for the fee.'

export const GIVE_THE_AGENT = `Next, give your agent this vault's address. ${AGENT_KEY_FEES} If your agent uses verify-then-pay (A-Identity checks a payee, then your agent pays), it also needs a Circle Gateway balance. A check bought on its own can be paid from plain USDC the agent holds, with no Gateway balance.`

/**
 * What to do when the browser stopped every request to the network. Said for a read and for a write
 * that stopped before the wallet was asked (failure-explain.ts), so it lives here once.
 */
export const BLOCKED_NEXT =
  'None of the network nodes got the request, which means something in this browser stopped it: most often Brave Shields, an ad or tracker blocker, a VPN or a filtering DNS. Turn it off for this site and press the button again. Or connect your wallet and put it on this network: this page then reads through your wallet instead. If you use none of these, check your internet connection.'
