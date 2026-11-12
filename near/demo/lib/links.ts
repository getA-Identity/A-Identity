// Every transaction the demo cites appears twice: a human explorer link and a curl line against
// ARCHIVAL RPC. Regular RPC nodes forget transactions after a few epochs, and the explorer
// answers non-browser clients with a challenge, so the curl line is the durable evidence.

import type { NetworkConfig } from './config.ts';

export type TxLinks = { explorer: string; archival_curl: string };

export function txLinks(net: NetworkConfig, txHash: string, signerId: string): TxLinks {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'aid',
    method: 'EXPERIMENTAL_tx_status',
    params: { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' },
  });
  return {
    explorer: `${net.explorerTxBase}${txHash}`,
    archival_curl: `curl -s -X POST ${net.archivalRpcUrl} -H 'Content-Type: application/json' -d '${body}'`,
  };
}

export function accountLink(net: NetworkConfig, accountId: string): string {
  return `${net.explorerAccountBase}${accountId}`;
}
