// The vault and the registry on NEAR MAINNET, exercised with no USDC in the vault, so no token can
// move: every outcome here is a hold or a refusal.
//
//   1. The agent's key pays a payee nobody has judged (a name one character off LiNEAR's
//      token, linear-protoco1.near, which does not exist) and a payee a public risk registry
//      flags (linear_protocol.near, a cited fake-airdrop account): the vault holds both.
//   2. The oracle judges the held payees from mainnet data with the same engine as everywhere
//      else and writes what the engine decides, with the snapshot's sha256 as evidence.
//   3. The agent pays both again: the DENY is refused on chain (RegistryDeny) and the WARN is
//      held for the owner (registry_warn).
//
// It refuses to run if the vault holds any USDC, so a mistake here cannot pay anyone.
// Run from near/:
//   AID_NETWORK=mainnet AID_AGENT_KEY_FILE=<vault agent key> AID_ORACLE_KEY_FILE=<oracle key> \
//     node --experimental-strip-types demo/mainnet-run.ts
// The log is written to demo/logs/mainnet/<run-id>.json and .txt.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnCall, holdKindIn, keySender, payOutcomeOf, vaultEvents } from './lib/chain.ts';
import { GAS, networkFromEnv } from './lib/config.ts';
import { findKey } from './lib/keys.ts';
import { createRpc } from './lib/rpc.ts';
import { viewFunction } from './lib/rpc.ts';

const VAULT = 'vault.a-identity.near';
const REGISTRY = 'registry.a-identity.near';
const ORACLE = 'oracle.a-identity.near';
const KNOWN = 'linear-protocol.near';
const UNJUDGED = 'linear-protoco1.near';
const FLAGGED = 'linear_protocol.near';
const AMOUNT = '500000'; // 0.50 USDC: never paid, the vault holds none

const env = process.env as Record<string, string | undefined>;
if (env.AID_NETWORK !== 'mainnet') {
  console.error('set AID_NETWORK=mainnet: this script only runs against mainnet');
  process.exit(2);
}
const net = networkFromEnv(env);
const rpc = createRpc({ readUrls: net.readRpcUrls, sendUrl: net.sendRpcUrl, archivalUrl: net.archivalRpcUrl });
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-mainnet`;
const logDir = join('demo', 'logs', 'mainnet');
mkdirSync(logDir, { recursive: true });
const lines: string[] = [];
const txs: Array<Record<string, unknown>> = [];
const say = (s: string) => {
  const line = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${s}`;
  lines.push(line);
  console.log(line);
};

const config = await viewFunction<Record<string, unknown>>(rpc, VAULT, 'get_config', {});
const balance = await viewFunction<string>(rpc, net.tokenId, 'ft_balance_of', { account_id: VAULT });
say(`vault ${VAULT}: ${String(config?.version)}, registry ${String(config?.registry_id)}, hold_unknown ${String(config?.hold_unknown)}, USDC balance ${balance}`);
if (balance !== '0') {
  say('STOP: the vault holds USDC; this run only shows holds and refusals and must not be able to pay');
  process.exit(1);
}

const agent = findKey('agent', VAULT, env);
if (!agent.ok) {
  say(`STOP: no agent key (${agent.reason})`);
  process.exit(1);
}
const sender = keySender(rpc, agent.key);

async function pay(payee: string, step: string): Promise<void> {
  const res = await sender.send({ signerId: VAULT, receiverId: VAULT, actions: [fnCall('pay', { payee, amount: AMOUNT, memo: step }, GAS.agentPay)] });
  if (res.kind !== 'executed') {
    say(`${step}: pay(${payee}) not executed: ${res.kind} ${'name' in res ? String(res.name) : ''}`);
    txs.push({ step, payee, kind: res.kind });
    return;
  }
  const out = payOutcomeOf(res.outcome);
  const kind = out?.payment_id ? holdKindIn(res.outcome, VAULT, out.payment_id) : null;
  const events = vaultEvents(res.outcome, VAULT).map((e) => e.event);
  say(`${step}: pay(${payee}, 0.50 USDC) tx ${res.txHash}: vault answered ${out?.status ?? '?'}${out?.reason ? ` ${out.reason}` : ''}${kind ? ` (kind ${kind})` : ''}; events ${events.join(', ')}`);
  say(`  explorer: ${net.explorerTxBase}${res.txHash}`);
  txs.push({ step, payee, tx_hash: res.txHash, outcome: out, hold_kind: kind, events });
}

await pay(UNJUDGED, 'mainnet 1: unjudged lookalike');
await pay(FLAGGED, 'mainnet 2: registry-flagged account');

say(`oracle: judging the held payees on mainnet (known payee ${KNOWN})`);
const oracleOut = execFileSync(process.execPath, [
  '--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'scripts/oracle.ts', '--once',
  '--vault', VAULT, '--registry', REGISTRY, '--oracle', ORACLE, '--known', KNOWN,
  '--ttl-deny', '2592000', '--ttl-warn', '2592000', '--log-dir', join(logDir, 'oracle'),
], { env: process.env, encoding: 'utf8' });
for (const l of oracleOut.split('\n').filter((x) => x.trim() !== '')) say(`  ${l.replace(/^\S+ /, '')}`);

await pay(UNJUDGED, 'mainnet 3: retry after the oracle');
await pay(FLAGGED, 'mainnet 4: retry after the oracle');

const finalBalance = await viewFunction<string>(rpc, net.tokenId, 'ft_balance_of', { account_id: VAULT });
say(`vault USDC balance after: ${finalBalance} (nothing could move)`);
writeFileSync(join(logDir, `${runId}.txt`), `${lines.join('\n')}\n`);
writeFileSync(join(logDir, `${runId}.json`), `${JSON.stringify({ run_id: runId, network: 'mainnet', vault: VAULT, registry: REGISTRY, oracle: ORACLE, txs, lines }, null, 2)}\n`);
say(`log: ${join(logDir, `${runId}.txt`)}`);
