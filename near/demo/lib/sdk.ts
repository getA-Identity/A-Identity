// Binds demo/lib/ports.ts to the SDK in sdk/src, with static imports, so `npm run typecheck`
// checks the demo against the SDK's real signatures.
//
//   engine  sdk/src/collect/snapshot.ts collectSnapshot + sdk/src/engine/index.ts
//           verdictFromSnapshot / formatEvidence: the same code `npm run verdict` runs, so a
//           snapshot the oracle saves replays to the same verdict offline.
//   guard   sdk/src/guard.ts verifyThenPay with verdictSource 'local' (no A-Identity server), and
//           the agent's key loaded by sdk/src/chain/keys.ts loadKey from the same 0600 file the
//           demo verified on chain.

import { loadKey } from '../../sdk/src/chain/keys.ts';
import { collectSnapshot } from '../../sdk/src/collect/snapshot.ts';
import { ENGINE_VERSION, formatEvidence, verdictFromSnapshot } from '../../sdk/src/engine/index.ts';
import { verifyThenPay } from '../../sdk/src/guard.ts';
import type { GuardResult as SdkGuardResult } from '../../sdk/src/guard.ts';
import type { Env } from './config.ts';
import type { LoadedKey } from './keys.ts';
import { displayPath } from './paths.ts';
import type { EngineJudgement, EnginePort, GuardArgs, GuardPort, GuardResult } from './ports.ts';

export type Binding<T> = { ok: true; port: T; notes: string[] } | { ok: false; why: string; notes: string[] };

// -- engine --------------------------------------------------------------------------------

/** The SDK engine: one snapshot pinned to the latest final block, then the pure decision. */
export function bindEngine(network: 'testnet' | 'mainnet' = 'testnet', env: Env = {}): Binding<EnginePort> {
  const port: EnginePort = {
    version: ENGINE_VERSION,
    async judge(subject, opts): Promise<EngineJudgement> {
      const snapshot = await collectSnapshot({ account: subject, network, known: opts.known, vault: opts.vaultId, registry: opts.registryId, env });
      const replay = verdictFromSnapshot(snapshot);
      return { decision: replay.decision, snapshot, snapshotSha256: replay.snapshot_sha256, evidence: formatEvidence(replay) };
    },
  };
  return { ok: true, port, notes: [`engine: sdk/src/collect/snapshot.ts#collectSnapshot + sdk/src/engine/index.ts#verdictFromSnapshot (${ENGINE_VERSION})`] };
}

// -- guard ---------------------------------------------------------------------------------

/** The SDK's GuardResult in the demo's terms. `raw` keeps the SDK's value for the run log;
 * attack.ts still re-reads every guard transaction from RPC before it calls a phase PASS. */
export function fromSdkGuardResult(r: SdkGuardResult, vault: string): GuardResult {
  const d = r.verdict.decision;
  return {
    verdict: r.verdict.verdict,
    reasons: d ? d.reasons.map((x) => ({ code: x.code, severity: x.severity, detail: x.detail })) : r.verdict.reasons.map((code) => ({ code })),
    score: d ? d.score : null,
    snapshotSha256: r.verdict.snapshot_sha256,
    block: d ? { height: d.block.height, hash: d.block.hash } : null,
    action: r.route,
    // "pending" means sent and not final yet: the transaction exists, and the demo waits for it.
    status: r.status === 'pending' ? 'executed' : r.status,
    txHash: r.tx_hash,
    signerId: r.tx_hash ? vault : null,
    payOutcome: r.onchain,
    settled: r.route === 'pay' && r.status === 'executed' ? r.settled : null,
    prepared: r.prepared,
    ...(r.error ? { error: r.error } : {}),
    ...(r.verdict.unavailable ? { unavailable: r.verdict.unavailable } : {}),
    contractOverrode: r.contract_overrode,
    summary: r.summary,
    raw: r,
  };
}

export type GuardSigner = { kind: 'none' } | { kind: 'key'; key: LoadedKey };

export async function bindGuard(ctx: { tokenId: string; network?: 'testnet' | 'mainnet'; env?: Env }, signer: GuardSigner): Promise<Binding<GuardPort>> {
  const notes: string[] = [];
  let sdkKey: Awaited<ReturnType<typeof loadKey>> = null;
  if (signer.kind === 'key') {
    try {
      sdkKey = await loadKey({ file: signer.key.path, expectPublicKey: signer.key.publicKey });
    } catch (e) {
      return { ok: false, why: `the SDK's loadKey refused ${displayPath(signer.key.path)}: ${(e as Error).message}`, notes };
    }
    notes.push(`guard signer: sdk/src/chain/keys.ts#loadKey(${displayPath(signer.key.path)}), ${signer.key.publicKey}`);
  } else {
    notes.push('guard signer: none (verifyThenPay returns the prepared call)');
  }
  notes.push('guard: sdk/src/guard.ts#verifyThenPay, verdictSource local');
  const network = ctx.network ?? 'testnet';
  const port: GuardPort = {
    description: 'sdk/src/guard.ts#verifyThenPay (verdictSource local)',
    async verifyThenPay(args: GuardArgs): Promise<GuardResult> {
      try {
        const r = await verifyThenPay({
          vault: args.vault,
          payee: args.payee,
          amount: args.amount,
          memo: args.memo,
          signer: sdkKey,
          verdictSource: 'local',
          network,
          known: args.known,
          tokenId: ctx.tokenId,
          ...(ctx.env ? { env: ctx.env } : {}),
        });
        return fromSdkGuardResult(r, args.vault);
      } catch (e) {
        return {
          verdict: null,
          reasons: [],
          score: null,
          snapshotSha256: null,
          block: null,
          action: null,
          status: 'error',
          txHash: null,
          signerId: null,
          payOutcome: null,
          settled: null,
          prepared: null,
          error: (e as Error).message,
          raw: null,
        };
      }
    },
  };
  return { ok: true, port, notes };
}
