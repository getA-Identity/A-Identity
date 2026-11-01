// GENERATED from mcp/src/chains/registry.ts and mcp/src/contracts/AgentSpendPolicy.ts.
// Never hand-edit: run cd mcp && npm run gen:chains. mcp/src/chains/trust-guard-sync.test.ts
// fails the build if this file differs from the registry.

/** Arc Mainnet as the A-Identity chain registry declares it. USDC is 6 decimals as an ERC-20
 *  and 18 as the native gas balance. Below minMaxFeePerGasWei, Arc drops a transaction with
 *  no error and no receipt. */
export const ARC_MAINNET = {
  "id": "arc-mainnet",
  "caip2": "eip155:5042",
  "chainId": 5042,
  "usdc": "0x3600000000000000000000000000000000000000",
  "usdcDecimals": 6,
  "nativeDecimals": 18,
  "identityRegistry": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
  "gatewayWallet": "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  "gatewayFacilitator": "https://gateway-api.circle.com",
  "gatewayDomain": 26,
  "rpcUrls": [
    "https://rpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
    "https://rpc.quicknode.mainnet.arc.io"
  ],
  "explorer": "https://explorer.arc.io",
  "minMaxFeePerGasWei": 20000000000n
} as const

/** The part of the AgentSpendPolicy vault's ABI this package uses. */
export const ARC_VAULT_ABI = [
  {
    "inputs": [],
    "name": "AboveAutoApprove",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DailyCapExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPayee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "IsFrozen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOperator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PayeeNotAllowed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SessionKeyExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "dayIndex",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "byOwner",
        "type": "bool"
      }
    ],
    "name": "Paid",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "allowed",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "allowlistEnabled",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "autoApproveMax",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "balance",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dailyCap",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "frozen",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "operator",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "ownerPay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "pay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "sessionKeyExpiry",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "spentToday",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const
