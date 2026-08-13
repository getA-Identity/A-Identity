/**
 * Shared EVM ABIs, verbatim from the Arc integration. These are standard across every
 * EVM chain (ERC-721 identity, ERC-20 USDC, ERC-8183 commerce, ERC-8004 validation), so
 * they live here once and every EVM chain adapter reuses them.
 */

export const IDENTITY_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'metadataURI', type: 'string' }], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Transfer', inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ] },
] as const

export const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/**
 * EIP-3009 (transferWithAuthorization) plus the EIP-712 discovery surface and the
 * Transfer event a settlement is proven against.
 *
 * Chain-generic on purpose, exactly like ERC20_ABI: the signed-transfer rail this feeds
 * works on any token that implements the standard, and the registry decides which tokens
 * those are. `version()` is included even though some tokens do not expose it (USDG
 * reverts for it) because a read that reverts is itself information: it tells the domain
 * prover that the version has to be proven from candidates instead of read.
 *
 * The v/r/s overload is the one used. Circle's FiatTokenV2 always exposes it, so it is
 * the shape both of our settlement tokens accept; the `bytes signature` overload is
 * optional in the wild and depending on it would narrow the rail for no gain.
 */
export const EIP3009_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'authorizationState', stateMutability: 'view',
    inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

export const COMMERCE_ABI = [
  { type: 'function', name: 'createJob', stateMutability: 'nonpayable', inputs: [
    { name: 'provider', type: 'address' },
    { name: 'evaluator', type: 'address' },
    { name: 'expiredAt', type: 'uint256' },
    { name: 'description', type: 'string' },
    { name: 'hook', type: 'address' },
  ], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setBudget', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' }, { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' }, { name: 'deliverable', type: 'bytes32' }, { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'complete', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' }, { name: 'reason', type: 'bytes32' }, { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  // Refund/dispute path: the evaluator rejects a Funded/Submitted deliverable and the
  // escrowed budget is refunded to the client in the same tx (buyer protection).
  { type: 'function', name: 'reject', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' }, { name: 'reason', type: 'bytes32' }, { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  // Expiry reclaim: after the deadline passes on a Funded/Submitted job, the escrow is
  // returned to the client (callable by anyone — the provider never delivered).
  { type: 'function', name: 'claimRefund', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' },
  ], outputs: [] },
  { type: 'function', name: 'getJob', stateMutability: 'view', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [
    { type: 'tuple', components: [
      { name: 'id', type: 'uint256' }, { name: 'client', type: 'address' }, { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' }, { name: 'description', type: 'string' }, { name: 'budget', type: 'uint256' },
      { name: 'expiredAt', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'hook', type: 'address' },
    ] },
  ] },
  { type: 'event', name: 'JobCreated', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true }, { name: 'client', type: 'address', indexed: true },
    { name: 'provider', type: 'address', indexed: true }, { name: 'evaluator', type: 'address', indexed: false },
    { name: 'expiredAt', type: 'uint256', indexed: false }, { name: 'hook', type: 'address', indexed: false },
  ] },
  { type: 'event', name: 'JobRejected', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true }, { name: 'by', type: 'address', indexed: true }, { name: 'reason', type: 'bytes32', indexed: false },
  ] },
  { type: 'event', name: 'Refunded', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true }, { name: 'client', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false },
  ] },
  // Typed errors — so a reverted dispute/claim decodes to a name (WrongStatus,
  // Unauthorized, …) instead of a raw 4-byte selector.
  { type: 'error', name: 'InvalidJob', inputs: [] },
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'WrongStatus', inputs: [] },
  { type: 'error', name: 'ProviderNotSet', inputs: [] },
] as const

/** ERC-8183 job status enum → label. */
export const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const

export const VALIDATION_ABI = [
  { type: 'function', name: 'validationRequest', stateMutability: 'nonpayable', inputs: [
    { name: 'validatorAddress', type: 'address' }, { name: 'agentId', type: 'uint256' },
    { name: 'requestURI', type: 'string' }, { name: 'requestHash', type: 'bytes32' },
  ], outputs: [] },
  { type: 'function', name: 'validationResponse', stateMutability: 'nonpayable', inputs: [
    { name: 'requestHash', type: 'bytes32' }, { name: 'response', type: 'uint8' },
    { name: 'responseURI', type: 'string' }, { name: 'responseHash', type: 'bytes32' }, { name: 'tag', type: 'string' },
  ], outputs: [] },
  { type: 'function', name: 'getValidationStatus', stateMutability: 'view', inputs: [{ name: 'requestHash', type: 'bytes32' }], outputs: [
    { name: 'validatorAddress', type: 'address' }, { name: 'agentId', type: 'uint256' }, { name: 'response', type: 'uint8' },
    { name: 'responseHash', type: 'bytes32' }, { name: 'tag', type: 'string' }, { name: 'lastUpdate', type: 'uint256' },
  ] },
  { type: 'function', name: 'getSummary', stateMutability: 'view', inputs: [
    { name: 'agentId', type: 'uint256' }, { name: 'validatorAddresses', type: 'address[]' }, { name: 'tag', type: 'string' },
  ], outputs: [{ name: 'count', type: 'uint64' }, { name: 'averageResponse', type: 'uint8' }] },
  { type: 'function', name: 'getAgentValidations', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: 'requestHashes', type: 'bytes32[]' }] },
] as const

/**
 * ERC-8004 ReputationRegistry. `giveFeedback` records a signed reputation attestation for
 * an agent from an external observer (a "validator"): per ERC-8004 an agent's owner CANNOT
 * score its own agent, so the caller must be a distinct validator address. `score` is a
 * signed int128 on the standard's 0-100 convention (e.g. 95 = strong). The three free-form
 * strings and the `feedbackHash` carry the off-chain evidence + a content hash of the score
 * payload, so the attestation is independently verifiable. Arc canonical example:
 *   giveFeedback(agentId, 95, 0, "successful_trade", "", "", "", keccak256("successful_trade"))
 */
export const REPUTATION_ABI = [
  { type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable', inputs: [
    { name: 'agentId', type: 'uint256' },
    { name: 'score', type: 'int128' },
    { name: 'tag1', type: 'uint8' },
    { name: 'tag2', type: 'string' },
    { name: 'endpointUri', type: 'string' },
    { name: 'fileUri', type: 'string' },
    { name: 'fileType', type: 'string' },
    { name: 'feedbackHash', type: 'bytes32' },
  ], outputs: [] },
] as const

/**
 * Arc `Memo` precompile (transaction memos). `memo(target, data, memoId, memoData)`
 * wraps a contract call, preserves the EOA as `msg.sender` via the `CallFrom`
 * precompile, and emits an on-chain audit-trail event indexable by `memoId`/`sender`.
 * Arc-specific: only wired for chains whose descriptor carries a `contracts.memo`.
 */
export const MEMO_ABI = [
  { type: 'function', name: 'memo', stateMutability: 'nonpayable', inputs: [
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'memoId', type: 'bytes32' },
    { name: 'memoData', type: 'bytes' },
  ], outputs: [] },
  { type: 'event', name: 'BeforeMemo', inputs: [
    { name: 'memoIndex', type: 'uint256', indexed: true },
  ] },
  { type: 'event', name: 'Memo', inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'target', type: 'address', indexed: true },
    { name: 'callDataHash', type: 'bytes32', indexed: false },
    { name: 'memoId', type: 'bytes32', indexed: true },
    { name: 'memo', type: 'bytes', indexed: false },
    { name: 'memoIndex', type: 'uint256', indexed: false },
  ] },
] as const

/**
 * Arc `Multicall3From` precompile (batched transactions). `aggregate3(Call3[])` runs many
 * subcalls in ONE Arc tx, each routed through `CallFrom` so the EOA stays `msg.sender`
 * (a batch of USDC transfers emits one `Transfer` per subcall, `from` = the caller's wallet).
 * Arc-specific: only wired for chains whose descriptor carries a `contracts.multicall3From`.
 */
export const MULTICALL3_FROM_ABI = [
  { type: 'function', name: 'aggregate3', stateMutability: 'payable', inputs: [
    { name: 'calls', type: 'tuple[]', components: [
      { name: 'target', type: 'address' },
      { name: 'allowFailure', type: 'bool' },
      { name: 'callData', type: 'bytes' },
    ] },
  ], outputs: [
    { name: 'returnData', type: 'tuple[]', components: [
      { name: 'success', type: 'bool' },
      { name: 'returnData', type: 'bytes' },
    ] },
  ] },
] as const

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
export const ZERO_HASH = ('0x' + '0'.repeat(64)) as `0x${string}`
