/**
 * Circle CLI — the same limits, expressed as Circle Agent Wallet policies.
 *
 * Circle's Agent Stack enforces spend policy at the wallet layer: per-transaction and
 * time-window transfer limits, plus recipient allowlists, checked before a transfer is
 * ever submitted. We enforce the same rules in three other places (our server pre-check,
 * the on-chain AgentSpendPolicy vault, and Circle's wallet screening). Adding Circle's
 * own policy engine makes it four, all expressing one number the human set once.
 *
 * This module compiles our `Permissions` into the exact `circle wallet limit set`
 * invocations that reproduce them, and does NOT shell out. That is deliberate: Circle
 * Agent Wallets are user-controlled, so applying a policy requires an interactive
 * email-OTP login by the wallet's owner. A server that claimed to do that silently would
 * be lying about who holds the key, which is the opposite of what this product sells.
 * So we generate; the human runs.
 *
 * Docs: developers.circle.com/agent-stack/circle-cli/command-reference
 */

/** The subset of an agent's permissions Circle's policy engine can express. */
export type PolicyInput = {
  dailyCapUsd?: number
  autoApproveUnderUsd?: number
  payeeAllowlist?: string[]
  frozen?: boolean
}

export type CliCommand = {
  /** What this command achieves, in the owner's language. */
  purpose: string
  command: string
  /** True when the command needs the owner's interactive OTP confirmation. */
  needsOtp: boolean
}

export type CliPlan = {
  address: string
  chain: string
  commands: CliCommand[]
  /** Rules we enforce that Circle's policy engine cannot express, said plainly. */
  notExpressible: string[]
}

/** Circle's CLI wants amounts as plain decimal USDC strings. */
function usd(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

/** Bracketed, comma-separated, exactly as `--targets` expects. */
function targets(list: string[]): string {
  return `"[${list.join(',')}]"`
}

/**
 * Compile an agent's limits into Circle CLI commands.
 *
 * `chain` is Circle's chain name for the wallet, not a CAIP id: the CLI takes its own
 * identifiers, and the limit commands are documented as mainnet-only, which the returned
 * note surfaces rather than hides.
 */
export function compilePolicyPlan(input: {
  address: string
  chain: string
  permissions: PolicyInput
  email?: string
}): CliPlan {
  const { address, chain, permissions, email } = input
  const commands: CliCommand[] = []
  const notExpressible: string[] = []

  const confirm = email ? ` --email ${email}` : ''
  const head = `circle wallet limit set --address ${address} --chain ${chain}`

  // Transfer limits: the per-transaction ceiling is our auto-approve line (above it a
  // human signs), and the daily figure is the daily cap the owner set.
  const perTx = permissions.autoApproveUnderUsd
  const daily = permissions.dailyCapUsd
  if (perTx !== undefined || daily !== undefined) {
    const parts = [head, '--policy-type stablecoin', '--rule-type transfer-limit']
    if (perTx !== undefined) parts.push(`--per-tx ${usd(perTx)}`)
    if (daily !== undefined) parts.push(`--daily ${usd(daily)}`)
    commands.push({
      purpose:
        perTx !== undefined && daily !== undefined
          ? `Cap each transfer at $${usd(perTx)} and the day at $${usd(daily)}`
          : perTx !== undefined
            ? `Cap each transfer at $${usd(perTx)}`
            : `Cap the day at $${usd(daily as number)}`,
      command: parts.join(' ') + confirm,
      needsOtp: true,
    })
  }

  // Payee allowlist: the same addresses our vault allows, enforced at the wallet too.
  const allow = (permissions.payeeAllowlist ?? []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
  if (allow.length > 0) {
    commands.push({
      purpose: `Restrict payouts to the ${allow.length} allowlisted payee${allow.length === 1 ? '' : 's'}`,
      command: `${head} --policy-type stablecoin --rule-type recipient-allowlist --targets ${targets(allow)}${confirm}`,
      needsOtp: true,
    })
  }
  if ((permissions.payeeAllowlist ?? []).length !== allow.length) {
    notExpressible.push(
      'Some allowlist entries are not 0x addresses, so they were left out of the Circle rule; our own engine still enforces them.',
    )
  }

  // Reading the wallet's remaining budget is free and needs no confirmation.
  commands.push({
    purpose: 'Read what is left of the wallet budget',
    command: `circle wallet limit budget --address ${address}`,
    needsOtp: false,
  })

  // Freeze has no Circle equivalent: their engine narrows what may move, it does not
  // have a single stop switch. Ours does, and it stays ours.
  if (permissions.frozen) {
    notExpressible.push(
      'This agent is frozen. Circle policies narrow what can move but have no single stop switch, so the freeze is enforced by our server and by the on-chain vault.',
    )
  }
  notExpressible.push(
    'Circle limit commands are documented for mainnet chains, so on Arc Testnet these mirror the policy rather than replace it.',
  )

  return { address, chain, commands, notExpressible }
}

/** The one-time bootstrap an owner runs before any policy command. */
export function bootstrapCommands(email?: string): CliCommand[] {
  return [
    { purpose: 'Install the Circle CLI', command: 'npm install -g @circle-fin/cli', needsOtp: false },
    {
      purpose: 'Sign in to the agent wallet (sends a one-time code)',
      command: `circle wallet login ${email ?? '<your-email>'} --testnet`,
      needsOtp: true,
    },
  ]
}
