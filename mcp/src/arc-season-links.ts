/**
 * Who is tied to whom behind the Arc season numbers, as a hand trace of the chain found it.
 *
 * Curated, not a live scan: the season report reads no funding trail on any request. These lists say what a person traced,
 * on which day, and name the transactions behind it. A link moves no count. The counts are vaults whose owner key we never
 * held and paid checks from wallets we do not control, whoever's they are; a link tells a reader that some of those wallets
 * may be one party, so a vault or a wallet is not taken for a separate user.
 *
 * A wallet is named here only with its address, what the chain or a public record shows, and what the founder said of it,
 * which is written as his statement on the day he made it and never as a chain fact. The chain can only merge wallets, it
 * can never show that two wallets are different people, so every party count this feeds is a ceiling.
 *
 * Kept as data with no imports so the report, its tests and any script read one list. Explorer links are derived by the
 * report from the registry, never typed here.
 */

/** The day the current trace was read. */
export const ARC_LINKS_TRACED_ON = '2026-11-08'

/** A transaction behind a link, or a public record when a statement has no transaction, as in a platform listing. */
export type ArcLinkEvidence = { txHash?: string; url?: string; what: string }

/** Wallets a hand trace of the chain ties to each other, with the transactions that show it. */
export type ArcWalletLink = {
  /** Two or more wallets, any case. */
  wallets: string[]
  /** UTC day the link was traced. */
  tracedOn: string
  /** How strong the tie between the wallets is, in plain words. It is never about whose wallets they are. */
  confidence: string
  /** What ties them, in plain words. */
  note: string
  /** The transactions that show the link, each one a reader can open. */
  evidence: ArcLinkEvidence[]
  /** Wallets of this group the founder said belong to one person, and the UTC day he said it. His word, not a chain fact: the
   *  report says it where it would otherwise say that those wallets may be one party, and it moves no count, because the link
   *  already merges them. */
  onePerson?: { wallets: string[]; saidOn: string }
}

const TRACED_ON = ARC_LINKS_TRACED_ON

/**
 * Every group of wallets the trace of 2026-11-08 tied together, with the transactions behind each link, apart from a named
 * team's own wallets: a team agreed to be named as an integration, which does not cover the wallets behind its paying ones,
 * so a group may hold a named team's wallets only when it holds nothing else, and none is listed. The team list already
 * makes one party of a team's paying wallets. The first group is the only one where a counted vault owner and an external
 * payer are the same party. Wallet role and amount are read from the transaction; the page and GET /api/arc/season link
 * each hash.
 */
export const ARC_WALLET_LINKS: ArcWalletLink[] = [
  {
    wallets: ['0x56755b84a0825d82f9be97C8Ab057cCDC3Dc1a43', '0x1d54499fA6Cff560F217a2cD1013b4E12c8D7f5F', '0x24427be91913774187b8547071284506767a77c4', '0xebbaedce6b4d9339280b933726e7902c38cf5064'],
    tracedOn: TRACED_ON,
    confidence: 'High for the owner, its agent key and the wallet that funded it; medium-high for 0x2442...77c4, a payee that returned funds to the paying vault.',
    note: "The owner and agent key of vault 0xcB7e...Ed41, the wallet that paid the owner its first money, and a payee of that vault that paid money back into it. The owner named the agent key at deploy and supplied all of its money, so the chain reads them as one party, and it is the only party that both owns a counted vault and paid external checks. As of this trace it paid 20 of them, from 2026-11-07 22:41Z to 2026-11-08 09:11Z, out of one 0.15 USDC send and two small returns from its own vault. The deploy's gas settings match a script rather than the page at /app/vault/arc. The owner and the agent key are also registered as agents on our platform (the list at GET /api/marketplace?all=1). A third platform wallet shares their naming and timing, but it has never sent a transaction, so the chain does not link it and it is not in this group. On 2026-11-10 the founder said that the wallets of this party are not team wallets, and that neither he nor his cofounder knows whose they are.",
    evidence: [
      { txHash: '0x0cfe6cf5e89ae5080bfcbebbe97f36730611dd9643d31bffd50dce47db9b9a75', what: '2026-11-07: 0xebba...5064 sent the owner 0x5675...1a43 its first money, 0.15 USDC' },
      { txHash: '0x6725e2e3e1f1066e774bd35d6dee10627f12e0416d18ea96f55f4ffc9c354c47', what: '2026-11-07: the owner deployed vault 0xcB7e...Ed41 and named 0x1d54...7f5F as its agent key' },
      { txHash: '0x795e294d31aedc05c40a248b052985444fed2e2fa5797782c1696e6026857666', what: '2026-11-07: the owner sent the agent key its first USDC, 0.035' },
      { txHash: '0x93a94121662df3a1c7de6cd682175055655395ea638046cab0f000408781059a', what: '2026-11-08: the owner sent the agent key 0.035 USDC more' },
      { txHash: '0x91c5f688f28b8ffb28a793f834ce0af6b20064a2c3948e171111840f974b6e77', what: "2026-11-08: the owner sent the agent key 0.018 USDC, the last of the agent key's money" },
      { txHash: '0x69b48110e386f5e3eec6ac9a37072ebfa61f65a20bdd052c18460ae33cabacca', what: '2026-11-08: the vault paid 0x2442...77c4 its first funds, 0.001 USDC' },
      { txHash: '0x402ef75a7a76f4ae17c09d2b90daf778b91f6235a1164fcc27017ad56969de3b', what: '2026-11-08: 0x2442...77c4 sent 0.0015 USDC back into the same vault' },
      { txHash: '0x9e98c9a8d935ebd2546a234a65c1bc1ce594da4fb0e84d7c5a9f23d42a117427', what: '2026-11-07: the vault paid its own owner 0.005 USDC' },
    ],
  },
  {
    wallets: ['0x39AEfbC8388da12907A21d9De888B288a9fa5794', '0xeD701bA695FBBaa7f0CD1D4cBe540E86F55C677b', '0x707B8aF7ba198e6BCf80480660fae5455E81ecd3', '0xDB477D372DA00BaC54fF3C9d676a19e93089fe36'],
    tracedOn: TRACED_ON,
    confidence: "High for 0x39AE...5794 with its agent key 0x707B...ecd3; medium for 0x39AE...5794 with 0xeD70...677b on the chain alone, because one person with two wallets, two people acting together and a payment to a friend would all look the same.",
    note: "0x39AE...5794, the owner of vault 0xa4D8...8182, sent 0xeD70...677b, the owner of vault 0x033F...EbE5, its first and only USDC, and vault 0x033F...EbE5 was deployed about 10 hours after vault 0xa4D8...8182. 0x39AE...5794 also funded the agent key of vault 0xa4D8...8182, and the two used a contract 0x39AE...5794 deployed. 0xDB47...fe36 is the agent key named at the second deploy and never used. The chain cannot say whose wallets these are. On 2026-11-10 the founder said that 0x39AE...5794 and 0xeD70...677b belong to one person, so on his word the two vaults are one party.",
    onePerson: { wallets: ['0x39AEfbC8388da12907A21d9De888B288a9fa5794', '0xeD701bA695FBBaa7f0CD1D4cBe540E86F55C677b'], saidOn: '2026-11-10' },
    evidence: [
      { txHash: '0x4ffaba3861c5f37469daebadebce5f48023f2920e85bc66288ebae5c6de0d139', what: '2026-10-17: 0x39AE...5794 split 3 USDC through a contract, and 0.99 USDC of it went to 0xeD70...677b; 0.99 came back to 0x39AE...5794 and 1.02 went to 0x3a97...c72c, a wallet that has never moved it and whose role is unknown' },
      { txHash: '0x57940cfcb58bd8f3663e47663b94c3cacb3749f0ed274a8c486e5410a33e9d07', what: '2026-11-01: 0x39AE...5794 sent 1.5 USDC to 0x707B...ecd3, the agent key of vault 0xa4D8...8182' },
      { txHash: '0xeb51376345d171af46e71d557b3f1011bc7bd26d37a34779cd2fb386603153ef', what: '2026-11-01: 0x39AE...5794 put 1 USDC into contract 0x1712...cf67, which it deployed itself' },
      { txHash: '0xcca3f5a6464b55cf3c0c74d5df383fc33f44cf02623dc74972d2733f5ae391c6', what: '2026-11-01: 0x707B...ecd3 put 1 USDC into the same contract' },
      { txHash: '0x43c2effa5781221fa91b7e7cee8bd92bf5d3202476ee3cb2250332615ef244f2', what: '2026-11-01: that contract paid 0x39AE...5794 2 USDC' },
      { txHash: '0xd7ea1ee90de141eb89ac6c10b16d8066fb54d66088550dc9794569d83a5ae7fe', what: '2026-11-06: 0xeD70...677b deployed vault 0x033F...EbE5 and named 0xDB47...fe36 as its agent key' },
    ],
  },
  {
    wallets: ['0x8cd5D3981A1fA059A92722591d25240e6F0f27A5', '0xcda86eabe89b4b7d46c0a147dc206acba4fd900b', '0xD5900cE1bA1839023E3Fd101E7F3c92E43916764'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'Vault 0x25e4...6B90. 0xcda8...900b bridged USDC in from Base and sent most of it to the owner 40 seconds later, and that is all it has ever done. 0xD590...6764 is the agent key named at deploy and never used.',
    evidence: [
      { txHash: '0x159f0ede428f3f94dc57f7ab033a2fe7027738432533777d7d53179efae635c1', what: '2026-11-04: 0.484219 USDC bridged to 0xcda8...900b from Base through Circle Bridge Kit' },
      { txHash: '0xee72c423155d63b3c1397e03b9601e0f12e9b70af1fcc97a2b2a98d3bc217525', what: '2026-11-04: 0xcda8...900b sent 0.4 USDC to the owner, 39 seconds before the deploy' },
      { txHash: '0xbd8d1e4ab5d14e6f65837f92becf0a492165bd007e8e9308ad177f7ab3cf9d2f', what: '2026-11-04: the owner deployed the vault and named 0xD590...6764 as its agent key' },
    ],
  },
  {
    wallets: ['0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9', '0x9b03cC56924a690D849309C8530d6dAcCbCDC3f4'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'Vault 0x9aCe...0619. The agent key is an older wallet of the same owner: the owner sent it 20 USDC seven weeks before the vault.',
    evidence: [
      { txHash: '0xd467333d9d9ee3284083ad8a491d692767a91de932f38e532397fcbcfb254d59', what: '2026-09-16: 0xD4F1...e2c9 sent 20 USDC to 0x9b03...C3f4' },
      { txHash: '0x6bda1b2faa57bf0f4330fbb8aef38152a9a0f19ddfe465c31d94837fa59ee9ab', what: '2026-11-06: the owner deployed the vault and named 0x9b03...C3f4 as its agent key' },
    ],
  },
  {
    wallets: ['0x363daf2A42D5055Dac91163f0eA29ca05c378f01', '0x8d586e1d05babcd061b84b7981226426595f7bca', '0xDD9ab7f20c3cc9A07F5808f531aaDd4c96200683'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'Vault 0x30E4...ff79. 0x8d58...7bca received USDC from an exchange-like hot wallet and forwarded nearly all of it to the new owner wallet 64 seconds later, and that is its only Arc Mainnet activity. 0xDD9a...0683 is the agent key named at deploy and never used.',
    evidence: [
      { txHash: '0x04bfa8dbc009abe849061db428d171d9a541a3f6b581d8f6b413b434ce457fc4', what: '2026-11-07: 0x8d58...7bca received 0.152638 USDC from an exchange-like hot wallet' },
      { txHash: '0xda12939b48edafc340a96665350a4a03542dc4040d2358cbd045a3f751d38d88', what: '2026-11-07: 0x8d58...7bca sent 0.151611 USDC to the owner 0x363d...8f01, its first money' },
      { txHash: '0xdb11b831e432660077a05cdced0614a880b5872e2a2a12eb7eb87617053602e9', what: '2026-11-07: the owner deployed the vault and named 0xDD9a...0683 as its agent key' },
    ],
  },
  {
    wallets: ['0xae93118cd57ac8645f0ac46a391eaade76d7f7ae', '0xddda78690198398ea24c32faba940ed9582d3681', '0x77152ae071414d967313827587e477a7b6422896'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'A paying wallet the founder confirmed on 2026-11-06 is not a team wallet. 0xddda...3681 funded a contract that paid 0xae93...f7ae and returned the rest in one transaction, then sent 0xae93...f7ae 2 USDC more, so the chain reads them as one party.',
    evidence: [
      { txHash: '0x670ae198a879fbd33d492d72d5a087e330d3b5eb4ead1b75f944fc66330dd85a', what: '2026-10-24: 0xddda...3681 funded contract 0x7715...2896 with 0.6 USDC' },
      { txHash: '0x2a0a9b309af4dab4746044d8620c816f0c565aa90bd7da5f433894e76fe19f98', what: '2026-10-24: that contract paid 0xae93...f7ae its first funds, 0.5 USDC, and returned 0.1 to 0xddda...3681' },
      { txHash: '0xf1d334036a1d615071ad206abc318e66cd1b4618633c5a05511209b5afe3ec54', what: '2026-11-05: 0xddda...3681 sent 0xae93...f7ae 2 USDC' },
    ],
  },
  {
    wallets: ['0xe7be265f2301e08a6eae5cfd0c1113a7cd35b3dd', '0x94705a9d675daa924f9190eca4c05ed6b12d5345'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'A paying wallet the founder confirmed on 2026-11-06 is not a team wallet. 0x9470...5345 funded it and it sent money back.',
    evidence: [
      { txHash: '0x7f5f4601074b23293ba04f8bbd5de99ece2a7bd2868b37c583836b9e0b42ac63', what: '2026-09-19: 0x9470...5345 sent 0xe7be...b3dd its first money, 1.52 USDC' },
      { txHash: '0xed753a04b8fc731599d636bf1be0f750917c362f110fa61acb06d4481b542c61', what: '2026-09-19: 0xe7be...b3dd sent 0.01 USDC back to 0x9470...5345' },
    ],
  },
  {
    wallets: ['0x3c27a3cab7915581941827b47417906e9bd59cf7', '0x889f585ec85c7b8c7c39736219abc99c8915a141'],
    tracedOn: TRACED_ON,
    confidence: 'High.',
    note: 'A paying wallet the founder confirmed on 2026-11-06 is not a team wallet, and which is also registered as an agent on our platform. 0x889f...a141 received a hot-wallet withdrawal and sent it 1 USDC 13 seconds later, and that is its only transaction.',
    evidence: [
      { txHash: '0x02276edb2889326772b04f1a412b1cf7ceff0299e635473217d1c6a68ca48184', what: '2026-11-04: 0x889f...a141 received a hot-wallet withdrawal' },
      { txHash: '0x8a6ceb5846b40ac340b655400988148bc6975d17840817443332e7583a0f7984', what: '2026-11-04: 0x889f...a141 sent 0x3c27...9cf7 its first money, 1 USDC' },
    ],
  },
]

/** A link between something counted and our own side, found by the trace. */
export type ArcOurSideKind = 'ours' | 'disclosed' | 'none-found'
export type ArcOurSideLink = {
  kind: ArcOurSideKind
  note: string
  evidence?: ArcLinkEvidence[]
}

/**
 * Everything the trace of 2026-11-08 found between what is counted and our own side, each labeled as ours or disclosed, and
 * what it looked for and did not find.
 */
export const ARC_OUR_SIDE_LINKS: ArcOurSideLink[] = [
  {
    kind: 'ours',
    note: "0x432b...53fd is a team member's own wallet. It funded our operating wallet with 3 USDC and is on the committed internal payer list, so a check it paid would read as internal and never as external. It has paid no check and owns no vault.",
    evidence: [{ txHash: '0x437f31171291c797516d28bfea583cf6324285060c3f8b481deecf13156899cf', what: "2026-11-02: 3 USDC to our operating wallet" }],
  },
  {
    kind: 'disclosed',
    note: 'Vault 0xcB7e...Ed41 paid our agent Simon 0.001 USDC. It is the only USDC a tracked external wallet sent to one of ours other than the checks themselves, and the flow it belongs to is labeled as paying Simon.',
    evidence: [{ txHash: '0x1d11b1f3fff1dea60242e637eb330303c10d2f01fff99deceaf944ce23e9edd4', what: '2026-11-08: 0.001 USDC from the vault to Simon' }],
  },
  {
    kind: 'disclosed',
    note: "0x8d58...7bca, the wallet that funded the owner of vault 0x30E4...ff79, signed in to our web app and followed an agent. It is on no list of ours. On 2026-11-10 the founder said that the team does not know whose it is, and that it may be a customer's.",
    evidence: [{ url: 'https://a-identity.xyz/api/marketplace?all=1', what: 'public platform list: the activity of agent agent_mrozp31y9jtbz, 2026-09-04T20:10:55Z' }],
  },
  {
    kind: 'disclosed',
    note: 'The wallets 0x5675...1a43, 0x1d54...7f5F and 0x3c27...9cf7 are also registered as agents on our platform. The platform does not publish which account owns an agent.',
    evidence: [{ url: 'https://a-identity.xyz/api/marketplace?all=1', what: 'public platform list' }],
  },
  {
    kind: 'disclosed',
    note: 'Dust only, and no relation found: 0xec06...3144 sent our buyer wallet 0.0000102 USDC.',
    evidence: [{ txHash: '0xec65ff6a24c9b004123ee4e3ed5447e2025f50ea6cc79b42ac4b7820862c1475', what: 'A 0.0000102 USDC transfer to our buyer wallet' }],
  },
  {
    kind: 'none-found',
    note: 'No funding from our side: every USDC movement of the tracked wallets was read on Arc Mainnet, and every USDC transfer from our wallets to them on Arc Testnet, and none of our wallets sent USDC to any owner, agent key, external payer, external payee or funder in this report. On Arc Mainnet the operating wallet sent USDC only to the validator, the launch-day vault and the buyer wallet; the buyer wallet only to Circle Gateway and the operating wallet; the launch-day vault only to Simon and the operating wallet.',
  },
  {
    kind: 'none-found',
    note: 'None of the owners, agent keys, external payers, funders or the external payee 0x2442...77c4 in this report is on a published internal payer list of ours or the committed list of our keys, and none is one of our own agents.',
  },
  {
    kind: 'none-found',
    note: "No third party funded a payer's Gateway balance: all external checks are Circle Gateway transfers to our receiving wallet, matched per wallet against Circle's public transfers API, and each payer's Gateway balance equals its own deposits minus its checks, to the unit.",
  },
]

/** What the trace read, and how far that goes. Curated with the lists above, so it carries the same date. */
export const ARC_LINK_TRACE = {
  tracedOn: TRACED_ON,
  reads:
    "Read by hand on 2026-11-08, not on this request: on Arc Mainnet, every USDC movement from or to 49 tracked addresses, blocks 20,800,000 to 30,221,494 (2026-09-14 to 2026-11-08); on Arc Testnet, only the USDC transfers from our wallets to the tracked owners, agent keys, payers, payee and funders, blocks 64,800,000 to 71,411,457 (2026-09-30 to 2026-11-08); each external payer's checks matched against Circle's public transfers API; and the public platform list at GET /api/marketplace?all=1.",
  limits: [
    'The chain can only merge wallets, never prove they are separate people, so every party count is a ceiling. A tester the team invited also looks external here, because the chain cannot tell a tester from anyone else.',
    "Not checked: source wallets on Base and Arbitrum (except the one behind vault 0x25e4...6B90's owner), Arc Testnet before 2026-09-30, and any key the server could not compare, which GET /api/arc/vaults lists under admission.keysNotCompared.",
    "Two team wallets known from public platform records have no Arc Mainnet activity. Other team members' personal wallets are not known to this trace, so a link to them cannot be ruled out. On 2026-11-10 the founder said that two other team members made no transactions; he did not give their wallet addresses, so this trace has not checked them.",
    'Not treated as links, because each serves many unrelated users: exchange hot wallets, custodial contracts, CCTP mints and relayers, Circle Gateway, Circle Bridge Kit, LI.FI and widely used contracts.',
    "Left out of the groups: the wallets behind the named teams' paying wallets. Slippay and Trustless Work agreed to be named as an integration on this page, which does not cover their other wallets. Slippay's two paying wallets count as one party because both are the team's, and the trace also found them tied on chain.",
    "Two flow records of 2026-11-08, each opened by a check that 0x1d54...7f5F, the agent key of vault 0xcB7e...Ed41, paid for, name 0x39AE...5794 and 0x8cd5...27A5, the owners of vaults 0xa4D8...8182 and 0x25e4...6B90, as payees (GET /api/x402/gateway/flows?vault=0xcB7e3b8b323B897E7E4303245dc98DE130B2Ed41). Both were still waiting for the vault owner's approval when read on 2026-11-08, so nothing was paid. A payee named in a flow is not treated as a link: the owner addresses are public on this page, and anyone can name them.",
  ],
} as const

/** A paying wallet the founder said is not a team wallet, and the UTC day he said it. His word, not a chain fact. */
export type ArcNotTeamPayer = { wallet: string; saidOn: string }

/**
 * External payers the founder said are not team wallets, each with the day he said it, so the report and the page say whose
 * word it is and when. On 2026-11-06 he said it of the unattributed wallets that had paid by that day, and on 2026-11-10 of
 * the wallets of the first group above, the party behind vault 0xcB7e...Ed41, of which the owner and the agent key have paid
 * checks. A wallet he has not spoken for reads as not identified until someone says otherwise.
 */
export const ARC_NOT_TEAM_PAYERS: ArcNotTeamPayer[] = [
  { wallet: '0xae93118cd57ac8645f0ac46a391eaade76d7f7ae', saidOn: '2026-11-06' },
  { wallet: '0xe7be265f2301e08a6eae5cfd0c1113a7cd35b3dd', saidOn: '2026-11-06' },
  { wallet: '0x3c27a3cab7915581941827b47417906e9bd59cf7', saidOn: '2026-11-06' },
  { wallet: '0x56755b84a0825d82f9be97c8ab057ccdc3dc1a43', saidOn: '2026-11-10' },
  { wallet: '0x1d54499fa6cff560f217a2cd1013b4e12c8d7f5f', saidOn: '2026-11-10' },
  { wallet: '0xebbaedce6b4d9339280b933726e7902c38cf5064', saidOn: '2026-11-10' },
  { wallet: '0x24427be91913774187b8547071284506767a77c4', saidOn: '2026-11-10' },
]

/**
 * Who has received gas support from our operating wallet. Read from its full USDC outflow on the date below, by hand: the log
 * of sends had no sent line, and every outflow went to our own addresses, none of them to a vault owner. Say it again when it
 * changes: whoever sends one has to change this with the hash.
 */
export const ARC_GAS_SUPPORT = { readOn: ARC_LINKS_TRACED_ON, owners: 0 } as const
