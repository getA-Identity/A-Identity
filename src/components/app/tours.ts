import type { TourStep } from './ConsoleTour'

/**
 * Every console screen carries its own inline tour: a handful of spotlighted
 * stops with an x/y counter, auto-run on the first visit to THAT screen and
 * replayable from the help button or the account menu. Steps whose target is
 * not on screen (an empty state, a hidden tab) are skipped at runtime, so a
 * tour never points at nothing.
 */
export type PageTour = { storageKey: string; steps: TourStep[] }

export const TOURS: Record<string, PageTour> = {
  '/app': {
    storageKey: 'aid-tour-overview-v2',
    steps: [
      {
        target: 'rail',
        title: 'Your console, grouped',
        body: 'Everything lives in three groups: who the agent IS (Agent), where its money moves (Money), and who else is out there (Network). Overview is always the way back.',
      },
      {
        target: 'status',
        title: 'What the agent is doing right now',
        body: 'One line, always current: setup, paused, waiting for your approval, or ready to act. Every claim comes from live data, stamped with when it was read.',
      },
      {
        target: 'checklist',
        title: 'The road to a running agent',
        body: 'Five real steps with real completion state. It stays until the last one is done, then leaves for good.',
      },
      {
        target: 'stats',
        title: 'The four numbers that matter',
        body: 'Reputation, balance, settlements, and the daily cap. Each tile links to its screen and says how fresh its figure is.',
      },
      {
        target: 'network',
        title: 'Where your agent can operate',
        body: 'Circle Arc and X Layer are live, Base is on testnet, and the rest of the rails are planned. Every chain links to its explorer.',
      },
      {
        target: 'last7',
        title: 'The shape of the spending',
        body: 'Seven real days of settled USDC, plus what is waiting and what was refused. The fastest way to see the agent is behaving.',
      },
      {
        target: 'activity',
        title: 'Everything it did, in order',
        body: 'Registrations, approvals, settlements: the recent trail, with relative timestamps.',
      },
      {
        target: 'command',
        title: 'The fastest way anywhere',
        body: 'Press ⌘K (or Ctrl K, or just "/") to jump between screens, paste an agent id, or run an action without the mouse.',
      },
      {
        target: 'account',
        title: 'You, the backend, and the exit',
        body: 'Your session, live backend status, and log out. You can replay any page tour from here.',
      },
    ],
  },
  '/app/agent-id': {
    storageKey: 'aid-tour-agentid-v1',
    steps: [
      {
        target: 'passport',
        title: 'The on-chain passport',
        body: 'Name, category, KYA status and the ERC-8004 token id, read live from Arc. The dot in the corner says whether you are looking at live or sample data.',
      },
      {
        target: 'stages',
        title: 'Three stages to go live',
        body: 'Register the identity, pass Know Your Agent, go live. Only a REAL agent advances this: the sample never pretends.',
      },
      {
        target: 'scores',
        title: 'What the score is made of',
        body: 'Settlement (up to 600), validation (240) and tenure (160) add up to the /1000 reputation. All three are computed from real activity.',
      },
      {
        target: 'level',
        title: 'Your level, among real agents',
        body: 'The score maps to a level, and the standing is measured against every live agent on the platform, not invented.',
      },
      {
        target: 'milestones',
        title: 'What each threshold unlocks',
        body: 'Hover the info marks: each milestone explains what it means and why it is worth reaching.',
      },
      {
        target: 'register',
        title: 'More agents, same account',
        body: 'Register as many agents as you need; the selector up top switches every money screen to the one you pick.',
      },
    ],
  },
  '/app/wallet': {
    storageKey: 'aid-tour-wallet-v1',
    steps: [
      {
        target: 'balance',
        title: 'The live balance',
        body: 'Read straight from the Arc testnet on every visit and every refresh. No cached number ever poses as current.',
      },
      {
        target: 'tokens',
        title: 'Every token it holds',
        body: 'USDC, EURC and yield-bearing USYC, read live. USYC is managed from the Treasury panel below.',
      },
      {
        target: 'address',
        title: 'Address utilities',
        body: 'Copy the address, open it on arcscan, or fund it with free testnet USDC from the Circle faucet.',
      },
      {
        target: 'payments',
        title: 'What left the wallet',
        body: 'The most recent payments with their policy verdicts. Settled ones link to the on-chain proof.',
      },
      {
        target: 'panels',
        title: 'The wallet layer',
        body: 'Provision a Circle-managed wallet with hosted screening, and put idle balance to work in USYC. Nothing moves without your approval.',
      },
    ],
  },
  '/app/settlements': {
    storageKey: 'aid-tour-settlements-v1',
    steps: [
      {
        target: 'new-payment',
        title: 'Create a payment',
        body: 'Pay a 0x address or another agent. The policy engine decides: auto-approve under your line, or pause for you.',
      },
      {
        target: 'tabs',
        title: 'Four surfaces, one queue',
        body: 'Payments is the queue itself; Automation, Agent commerce and Rails hold the machinery that feeds it.',
      },
      {
        target: 'queue',
        title: 'The approval queue',
        body: 'Pending payments wait here. You can approve, execute, or edit the terms before approving: the queue keeps both what was proposed and what you authorised.',
      },
    ],
  },
  '/app/permissions': {
    storageKey: 'aid-tour-permissions-v1',
    steps: [
      {
        target: 'tabs',
        title: 'Four rulebooks',
        body: 'Payments govern USDC on Arc; Trading, Spend and Audit each govern their own surface. They are separate on purpose.',
      },
      {
        target: 'today',
        title: 'Today, against the cap',
        body: 'What the agent has committed today and what remains, with the reset countdown. The cap is a state, not just a setting.',
      },
      {
        target: 'limits',
        title: 'The two numbers that bound it',
        body: 'The daily cap, and the line below which the agent may act alone. Everything above the line waits for you.',
      },
      {
        target: 'access',
        title: 'Who it may pay',
        body: 'Agent-to-agent, agent-to-human, and an optional allowlist that narrows payees to exactly the ones you name.',
      },
      {
        target: 'safety',
        title: 'The off switch',
        body: 'Freeze pauses every payment until you unfreeze. It always wins over everything else.',
      },
      {
        target: 'save',
        title: 'Rules apply instantly',
        body: 'Saving pushes the policy to the server and, when the agent has an on-chain vault, on-chain too.',
      },
    ],
  },
  '/app/marketplace': {
    storageKey: 'aid-tour-marketplace-v1',
    steps: [
      {
        target: 'views',
        title: 'Three views of the market',
        body: 'Agent House is the roster of agents already working, across every network we settle on. Hire a worker to put a task out for one, or check the Leaderboard to see who ranks highest.',
      },
      {
        // Agent House is the view the market opens on, so this is the only step
        // besides the switch itself that a first visit is guaranteed to see. The
        // two below live on the Hire tab and ConsoleTour drops a step whose
        // target is not on screen.
        target: 'roster',
        title: 'Who is already here',
        body: 'Every card is a real registered agent: the networks it is registered on, what it charges, and whether its identity is anchored on-chain or still queued.',
      },
      {
        target: 'catalog',
        title: 'Hire with an escrow',
        body: 'Every worker passed KYA. Hiring locks your USDC in an on-chain escrow and releases it to the worker on delivery.',
      },
      {
        target: 'open-tasks',
        title: 'Or post the task instead',
        body: 'Describe the job with a budget; verified agents bid and you accept the best offer.',
      },
    ],
  },
  '/app/earnings': {
    storageKey: 'aid-tour-earnings-v1',
    steps: [
      {
        target: 'stats',
        title: 'What the agent earned',
        body: 'Released escrow jobs, the live wallet balance, and the Gateway unified balance, all read fresh.',
      },
      {
        target: 'redeem',
        title: 'Take it cross-chain',
        body: 'One click moves USDC from Arc to Base Sepolia through Circle Gateway, gaslessly.',
      },
      {
        target: 'jobs',
        title: 'The receipts',
        body: 'Every completed job with its settlement mode and, when on-chain, its arcscan link.',
      },
    ],
  },
}
