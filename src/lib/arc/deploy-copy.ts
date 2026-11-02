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

export const WHAT_IS_A_VAULT =
  'A vault is a small contract that holds USDC for your agent. Your agent can spend from it only within the limits you set here. You can freeze it or take the USDC back whenever you want.'

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
  'On Arc, network fees are paid in USDC, so your wallet needs a little USDC on this network before you start. The review shows the most each fee can be.'

export const OWNER_KEY_LINE =
  'Your key stays in your wallet. A-Identity never sees it and signs nothing here. Only your account can freeze the vault, change its limits, replace the agent key or take USDC out.'

export const AGENT_KEY_CAN = "The agent's key is a separate address your agent signs with. It can do one thing: pay from the vault, within your limits, until its end date."

export const AGENT_KEY_CANNOT =
  'It cannot change the limits, unfreeze the vault, replace itself or go over the limits. It can pay any address unless you turn on the allowlist, a list of addresses you approve. So if it leaks, whoever holds it can spend up to your daily limit until you freeze the vault or the key ends.'

export const REVIEW_LINE = 'This contract has had internal reviews and no outside audit. A bug could lose what you put in. Put in only what you can afford to lose.'

/** What each way of failing means, and what to do. Every one is true at every step of the setup. */
export const IF_A_STEP_FAILS: readonly { when: string; then: string }[] = [
  { when: 'You pressed decline, or your wallet showed an error before sending', then: 'Nothing was sent and nothing was spent. Press the button again when you are ready.' },
  { when: 'You reloaded the page or closed the tab', then: 'Your place is saved in this browser. Open this page again and it carries on. A phone wallet may need connecting again.' },
  { when: 'The page keeps waiting and nothing seems to happen', then: "Open your wallet and look at its activity list. Do not sign a new transaction until you have looked: the first one may still go through." },
  { when: 'A transaction failed on the network', then: 'Its network fee is spent. The USDC you meant to send is still in your wallet. The page says what to do next.' },
  { when: 'Your vault exists but you stopped before step 2', then: "Come back and finish step 2 before you put USDC in. Until then the agent's key has no end date." },
]

/** Said when a step needs the wallet and the page has none: after a reload with a phone wallet, or a locked wallet. */
export const WALLET_GONE =
  'Your wallet is not connected to this page right now, so nothing can be signed. This is normal after a reload with a phone wallet, or when a browser wallet is locked. Unlock it, or press Connect wallet at the top of this page, and pick the owner account. Your setup is saved.'

/** Said when a wallet is connected on an account that is not the setup's owner. */
export const WRONG_ACCOUNT = "Your wallet is on a different account. Pick the owner account in your wallet to carry on. Your setup is saved."

/** Said beside a prepared write, while the wallet's own screen is what the person is about to trust. */
export const WALLET_MAY_REPRICE =
  'Your wallet shows this call and asks you to confirm it. It may show a different network fee from the one here, because some wallets set their own. Arc needs a max fee of at least 20 gwei (gwei is the tiny unit wallets use for this fee). If your wallet shows less, raise it before you confirm, or Arc drops the transaction without telling anyone.'
