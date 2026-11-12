// The A-Identity oracle watcher (NEAR testnet).
//
// It watches a vault's held payments and gives every payee that waits there, and that the
// registry has never judged, a verdict computed from public chain data:
//
//   1. list_held on the vault (all pages), keep the holds that have not expired;
//   2. get_verdict on the registry for each payee; a payee with a live verdict is left alone;
//   3. collect ONE snapshot of the payee pinned to a block (SDK collectors), decide with the SDK
//      engine, and save the snapshot as <log-dir>/snapshots/<sha256>.json;
//   4. write set_verdict on the registry with the ORACLE's function-call key: reasons, evidence =
//      "near-snapshot sha256:<snapshot sha256> block:<height> engine:<version>" (the SDK's
//      formatEvidence), the engine's score, the payee's observed code
//      hash, and a ttl. Without the key, the exact call is printed and labeled prepared.
//
// What it writes, and what it deliberately does not:
//
//   engine DENY                 -> DENY (ttl 7 days)
//   engine WARN, warn_kind hard -> WARN (ttl 24 hours)
//   engine WARN, warn_kind soft -> nothing. A soft WARN only says nobody has history with the
//                                  payee yet. The vault (hold_unknown) already holds a first
//                                  payment to a payee nobody judged; a registry WARN would also
//                                  hold every later payment, after the owner has approved one.
//                                  --write-soft-warn writes it anyway.
//   engine ALLOW, not lookalike -> ALLOW (ttl 24 hours)
//   engine ALLOW, lookalike     -> WARN with reason oracle_lookalike_floor. The oracle NEVER
//                                  writes ALLOW for a name that looks like a known payee, whether
//                                  the engine's reasons say so or the engine's own lookalike
//                                  function finds it again here.
//
// TTLs. Verdicts rest on signals that move (account age, recent keys), so they lapse and get
// recomputed. An expired verdict reads as no verdict; a vault with hold_unknown HOLDS a payee with
// no verdict rather than paying it, so an expired DENY fails safe there. Override with --ttl-*.
// Every write logs when it expires (the registry counts the ttl from the block that includes it).
//
// Every decision is logged with its snapshot hash and block, so anyone can recompute it, from
// near/ (paths in the records are relative to near/ when the log dir is inside it):
//   npm run verdict -- --offline demo/logs/oracle/snapshots/<sha256>.json
//
// Usage:
//   node --experimental-strip-types scripts/oracle.ts --once  [options]
//   node --experimental-strip-types scripts/oracle.ts --watch [--interval 15] [options]
// Options: --vault <id> --registry <id> --oracle <id> --known a,b --log-dir <dir> --dry-run
//          --ttl-allow <s> --ttl-warn <s> --ttl-deny <s> --write-soft-warn --max-rounds <n>
// Keys: the oracle's function-call key from AID_ORACLE_KEY_FILE or ~/.near-credentials/testnet
// (0600). A full-access oracle key is refused (amendment A3).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_POLICY, findLookalike, prettyJson, registryReasons } from '../sdk/src/engine/index.ts';
import type { Decision, Verdict } from '../sdk/src/engine/index.ts';
import { eventItems, eventsOf, fnCall, keySender, noKeySender, preparedCall } from '../demo/lib/chain.ts';
import type { PreparedCall, Sender, TxPlan } from '../demo/lib/chain.ts';
import { GAS, networkFromEnv } from '../demo/lib/config.ts';
import type { Env, NetworkConfig } from '../demo/lib/config.ts';
import { describeKey, findKey } from '../demo/lib/keys.ts';
import { txLinks } from '../demo/lib/links.ts';
import { displayPath } from '../demo/lib/paths.ts';
import type { EngineJudgement, EnginePort } from '../demo/lib/ports.ts';
import { createRpc } from '../demo/lib/rpc.ts';
import type { RpcClient } from '../demo/lib/rpc.ts';
import { bindEngine } from '../demo/lib/sdk.ts';
import { chainViews, checkOracleKeyPermission } from '../demo/lib/views.ts';
import type { HeldView, Views } from '../demo/lib/views.ts';
import { accountsFromEnv } from '../demo/scenarios/accounts.ts';

export const DEFAULT_TTL_S: Record<Verdict, number> = { ALLOW: 86_400, WARN: 86_400, DENY: 7 * 86_400 };
export const FLOOR_REASON = 'oracle_lookalike_floor';
const MAX_REGISTRY_REASONS = 8;
const MAX_CODE_LEN = 32;

export type OracleConfig = {
  vault: string;
  registry: string;
  oracle: string;
  known: string[];
  writeSoftWarn: boolean;
  ttl: Record<Verdict, number>;
  dryRun: boolean;
};

export type WritePlan = { write: boolean; verdict: Verdict | null; reasons: string[]; scoreFromEngine: boolean; why: string };

/** Registry reason codes: 1 to 32 bytes of [a-z0-9_], at most 8, deduplicated, in order. */
export function registryCodes(codes: string[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    const clean = c.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, MAX_CODE_LEN);
    if (clean !== '' && !out.includes(clean)) out.push(clean);
    if (out.length === MAX_REGISTRY_REASONS) break;
  }
  return out;
}

/** Uncleared warning codes, for the lookalike floor. */
function warnCodes(d: Decision): string[] {
  return d.reasons.filter((r) => r.severity === 'warn' && !r.cleared_by).map((r) => r.code);
}

/** True when the payee's name looks like a known payee: by the engine's own reasons, or by the
 * engine's lookalike function run again on the oracle's known list. */
export function lookalikeHit(d: Decision, payee: string, known: string[]): { hit: boolean; why: string } {
  const byReason = d.reasons.find((r) => r.code.startsWith('lookalike'));
  if (byReason) return { hit: true, why: `${byReason.code}: ${byReason.detail}` };
  const m = findLookalike(payee, known.filter((k) => k !== payee), DEFAULT_POLICY.lookalike);
  if (m) return { hit: true, why: `${m.kind} of ${m.known} (distance ${m.distance}): ${m.detail}` };
  return { hit: false, why: '' };
}

/** The reasons written with a verdict are the SDK's own choice (registryReasons): the deny codes
 * for a DENY, the deciding warnings for a WARN, the positives for an ALLOW. */
export function oracleWritePolicy(d: Decision, payee: string, known: string[], writeSoftWarn: boolean): WritePlan {
  const look = lookalikeHit(d, payee, known);
  if (d.verdict === 'DENY') {
    return { write: true, verdict: 'DENY', reasons: registryCodes(registryReasons(d)), scoreFromEngine: true, why: 'engine DENY' };
  }
  if (d.verdict === 'WARN') {
    if (d.warn_kind === 'soft' && !writeSoftWarn && !look.hit) {
      return {
        write: false,
        verdict: null,
        reasons: [],
        scoreFromEngine: false,
        why: 'soft WARN (nobody has history with this payee yet): not written, the vault already holds a first payment to a payee nobody judged',
      };
    }
    return { write: true, verdict: 'WARN', reasons: registryCodes(registryReasons(d)), scoreFromEngine: true, why: `engine WARN (${d.warn_kind ?? 'unclassified'})` };
  }
  if (look.hit) {
    return {
      write: true,
      verdict: 'WARN',
      reasons: registryCodes([...warnCodes(d).filter((c) => c.startsWith('lookalike')), 'lookalike_known', FLOOR_REASON]),
      scoreFromEngine: false,
      why: `engine ALLOW for a lookalike (${look.why}); the oracle never writes ALLOW for a lookalike`,
    };
  }
  return { write: true, verdict: 'ALLOW', reasons: registryCodes(registryReasons(d)), scoreFromEngine: true, why: 'engine ALLOW' };
}

/** The code hash the snapshot observed on the payee (view_account at the pinned block). */
export function observedCodeHash(j: EngineJudgement): string | null {
  for (const r of j.snapshot.rpc) {
    if (r.method !== 'query' || r.params.request_type !== 'view_account' || r.params.account_id !== j.snapshot.subject) continue;
    const h = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result.code_hash : undefined;
    if (typeof h === 'string' && h.length > 0 && h.length <= 64) return h;
  }
  return null;
}

export function setVerdictArgs(payee: string, plan: WritePlan, j: EngineJudgement, ttl: Record<Verdict, number>): Record<string, unknown> {
  if (!plan.verdict) throw new Error('no verdict to write');
  const score = plan.scoreFromEngine && Number.isInteger(j.decision.score) ? Math.max(0, Math.min(1000, j.decision.score)) : null;
  const ttlS = ttl[plan.verdict];
  return {
    account_id: payee,
    verdict: plan.verdict,
    reasons: plan.reasons,
    evidence: j.evidence,
    score,
    code_hash: observedCodeHash(j),
    ttl_s: ttlS > 0 ? String(ttlS) : null,
  };
}

export type OracleAction = 'skipped_has_verdict' | 'not_written' | 'written' | 'prepared' | 'write_failed' | 'judge_failed';

export type OracleRecord = {
  at: string;
  payee: string;
  held_ids: string[];
  action: OracleAction;
  why: string;
  engine?: { verdict: Verdict; score: number; warn_kind: string | null; engine_version: string; policy_id: string; reasons: Array<{ code: string; severity: string; detail: string; cleared_by?: string }> };
  snapshot_sha256?: string;
  block_height?: number;
  snapshot_file?: string;
  recompute?: string;
  set_verdict?: Record<string, unknown>;
  /** now + ttl when the write was made; the registry counts from the including block, so the
   * exact expiry is get_verdict's expires_at_ns. */
  expires_about?: string | null;
  prepared?: PreparedCall;
  tx_hash?: string;
  explorer?: string;
  archival_curl?: string;
  existing?: { verdict: string; updated_by: string; reasons: string[] };
};

export type OracleDeps = {
  views: Views;
  engine: EnginePort;
  sender: Sender;
  net: NetworkConfig;
  log: (line: string) => void;
  now: () => Date;
  saveSnapshot: (sha256: string, json: string) => string;
  saveRecord: (rec: OracleRecord) => void;
};

/** now + ttl, as an ISO time; null for no expiry. */
export function expiresAbout(now: Date, ttlS: unknown): string | null {
  const s = typeof ttlS === 'string' ? Number.parseInt(ttlS, 10) : typeof ttlS === 'number' ? ttlS : 0;
  if (!Number.isFinite(s) || s <= 0) return null;
  return new Date(now.getTime() + s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

function liveHolds(held: HeldView[], nowS: number): Map<string, string[]> {
  const byPayee = new Map<string, string[]>();
  for (const h of held) {
    if (Number(h.expires_at_s) < nowS) continue;
    byPayee.set(h.payee, [...(byPayee.get(h.payee) ?? []), h.id]);
  }
  return byPayee;
}

/** One pass over the vault's held payments. Never throws for one payee's trouble: each payee
 * ends in exactly one record. */
export async function runOracleOnce(deps: OracleDeps, cfg: OracleConfig): Promise<OracleRecord[]> {
  const { views, engine, sender, log } = deps;
  const at = () => deps.now().toISOString();
  const nowS = Math.floor(deps.now().getTime() / 1000);
  const held = await views.listHeld(cfg.vault);
  const byPayee = liveHolds(held, nowS);
  const allowlist = await views.listAllowlist(cfg.vault);
  const known = [...new Set([...cfg.known, ...allowlist])].sort();
  log(
    `oracle: ${held.length} held payment(s) on ${cfg.vault}, ${byPayee.size} payee(s) with a live hold; known payees (configured [${cfg.known.join(', ')}], plus the vault allowlist [${allowlist.join(', ')}]): ${known.join(', ') || 'none'}`,
  );
  const records: OracleRecord[] = [];

  for (const [payee, heldIds] of byPayee) {
    const base = { at: at(), payee, held_ids: heldIds };
    const existing = await views.getVerdict(cfg.registry, payee);
    if (existing) {
      const rec: OracleRecord = { ...base, action: 'skipped_has_verdict', why: `already judged: ${existing.verdict} by ${existing.updated_by}`, existing: { verdict: existing.verdict, updated_by: existing.updated_by, reasons: existing.reasons } };
      log(`oracle: ${payee} skipped, ${rec.why} (${existing.reasons.join(', ') || 'no reasons'})`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }

    let j: EngineJudgement;
    try {
      j = await engine.judge(payee, { known, vaultId: cfg.vault, registryId: cfg.registry });
    } catch (e) {
      const rec: OracleRecord = { ...base, action: 'judge_failed', why: `could not compute a verdict: ${(e as Error).message}` };
      log(`oracle: ${payee} ${rec.why}; nothing written`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }
    const d = j.decision;
    const snapshotFile = deps.saveSnapshot(j.snapshotSha256, `${prettyJson(j.snapshot)}\n`);
    const engineSummary = {
      verdict: d.verdict,
      score: d.score,
      warn_kind: d.warn_kind,
      engine_version: d.engine_version,
      policy_id: d.policy_id,
      reasons: d.reasons.map((r) => ({ code: r.code, severity: r.severity, detail: r.detail, ...(r.cleared_by ? { cleared_by: r.cleared_by } : {}) })),
    };
    const deciding = d.reasons.filter((r) => (r.severity === 'deny' || r.severity === 'warn') && !r.cleared_by).map((r) => r.code);
    log(
      `oracle: ${payee} engine ${d.verdict}${d.warn_kind ? ` (${d.warn_kind})` : ''} score ${d.score} [${deciding.join(', ') || 'no deciding reasons'}]; snapshot sha256 ${j.snapshotSha256} at block ${d.block.height}`,
    );
    const plan = oracleWritePolicy(d, payee, known, cfg.writeSoftWarn);
    const recBase = {
      ...base,
      engine: engineSummary,
      snapshot_sha256: j.snapshotSha256,
      block_height: d.block.height,
      snapshot_file: snapshotFile,
      recompute: `npm run verdict -- --offline ${snapshotFile}`,
    };
    if (!plan.write || !plan.verdict) {
      const rec: OracleRecord = { ...recBase, action: 'not_written', why: plan.why };
      log(`oracle: ${payee} ${plan.why}`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }

    const args = setVerdictArgs(payee, plan, j, cfg.ttl);
    const expires = expiresAbout(deps.now(), args.ttl_s);
    const expiryText = expires ? `ttl ${String(args.ttl_s)} s, expires about ${expires}` : 'no expiry';
    const txPlan: TxPlan = { signerId: cfg.oracle, receiverId: cfg.registry, actions: [fnCall('set_verdict', args, GAS.setVerdict, 0n)] };
    if (cfg.dryRun) {
      const rec: OracleRecord = { ...recBase, action: 'prepared', why: `dry run; ${plan.why}`, set_verdict: args, expires_about: expires, prepared: preparedCall(txPlan) };
      log(`oracle: ${payee} would write ${plan.verdict} [${plan.reasons.join(', ')}] (dry run, prepared, not executed): ${JSON.stringify(args)}`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }
    const r = await sender.send(txPlan);
    if (r.kind === 'prepared') {
      const rec: OracleRecord = { ...recBase, action: 'prepared', why: `${r.reason}; ${plan.why}`, set_verdict: args, expires_about: expires, prepared: r.prepared };
      log(`oracle: ${payee} would write ${plan.verdict} [${plan.reasons.join(', ')}], prepared, not executed (${r.reason}): ${JSON.stringify(args)}`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }
    if (r.kind === 'rejected') {
      const rec: OracleRecord = { ...recBase, action: 'write_failed', why: `set_verdict rejected before execution, no transaction: ${r.name}`, set_verdict: args };
      log(`oracle: ${payee} ${rec.why}`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }
    if (r.kind === 'unconfirmed') {
      const links = txLinks(deps.net, r.txHash, cfg.oracle);
      const rec: OracleRecord = { ...recBase, action: 'write_failed', why: `set_verdict sent, final status not seen: ${r.reason}`, set_verdict: args, tx_hash: r.txHash, ...links };
      log(`oracle: ${payee} ${rec.why}; tx ${r.txHash}`);
      deps.saveRecord(rec);
      records.push(rec);
      continue;
    }
    const links = txLinks(deps.net, r.txHash, cfg.oracle);
    const confirmed =
      r.outcome.success &&
      eventsOf(r.outcome, 'a_identity_registry', cfg.registry).some((e) => e.event === 'verdict_set' && eventItems(e.data).some((x) => x.account_id === payee && x.verdict === plan.verdict));
    const rec: OracleRecord = {
      ...recBase,
      action: confirmed ? 'written' : 'write_failed',
      why: confirmed ? plan.why : `set_verdict did not succeed: ${JSON.stringify(r.outcome.failure ?? 'no verdict_set event')}`,
      set_verdict: args,
      ...(confirmed ? { expires_about: expires } : {}),
      tx_hash: r.txHash,
      ...links,
    };
    log(`oracle: ${payee} ${confirmed ? `wrote ${plan.verdict} [${plan.reasons.join(', ')}], ${expiryText}` : rec.why}; tx ${r.txHash}`);
    log(`oracle:   ${links.explorer}`);
    log(`oracle:   ${links.archival_curl}`);
    deps.saveRecord(rec);
    records.push(rec);
  }
  return records;
}

export type WatchOptions = { intervalS: number; maxRounds?: number; sleep?: (ms: number) => Promise<void>; stopped?: () => boolean };

/** Poll forever (or maxRounds). A failed round is logged and the next one waits longer, up to
 * 5 minutes; the watcher never exits on a transient error. */
export async function watch(deps: OracleDeps, cfg: OracleConfig, opts: WatchOptions): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delayS = opts.intervalS;
  let rounds = 0;
  while (!(opts.stopped?.() ?? false) && (opts.maxRounds === undefined || rounds < opts.maxRounds)) {
    rounds++;
    const last = opts.maxRounds !== undefined && rounds >= opts.maxRounds;
    try {
      await runOracleOnce(deps, cfg);
      delayS = opts.intervalS;
    } catch (e) {
      delayS = Math.min(delayS * 2, 300);
      deps.log(`oracle: round ${rounds} failed (${(e as Error).message})${last ? '' : `; next round in ${delayS} s`}`);
    }
    if (last || (opts.stopped?.() ?? false)) break;
    await sleep(delayS * 1000);
  }
  return rounds;
}

// -- CLI -------------------------------------------------------------------------------------

const DEFAULT_LOG_DIR = fileURLToPath(new URL('../demo/logs/oracle/', import.meta.url));

export async function oracleSender(rpc: RpcClient, views: Views, env: Env, cfg: OracleConfig, log: (s: string) => void): Promise<Sender> {
  if (cfg.dryRun) return noKeySender('dry run');
  const found = findKey('oracle', cfg.oracle, env);
  if (!found.ok) {
    log(`oracle: no oracle key (${found.reason}); every write is printed as a prepared call, not executed`);
    return noKeySender(`no oracle key: ${found.reason}`);
  }
  const ak = await views.accessKey(cfg.oracle, found.key.publicKey);
  const check = checkOracleKeyPermission(ak?.permission, cfg.registry);
  if (!check.ok) {
    log(`oracle: refusing the key ${describeKey(found.key)}: ${check.why}; writes are prepared only`);
    return noKeySender(`oracle key refused: ${check.why}`);
  }
  log(`oracle: signing as ${describeKey(found.key)}: ${check.why}`);
  return keySender(rpc, found.key);
}

function parseTtl(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad ttl: ${v}`);
  return n;
}

export async function main(argv: string[], env: Env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string', default: '15' },
      'max-rounds': { type: 'string' },
      vault: { type: 'string' },
      registry: { type: 'string' },
      oracle: { type: 'string' },
      known: { type: 'string' },
      'log-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'write-soft-warn': { type: 'boolean', default: false },
      'ttl-allow': { type: 'string' },
      'ttl-warn': { type: 'string' },
      'ttl-deny': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const out = (s: string) => process.stdout.write(`${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${s}\n`);
  if (values.help || (!values.once && !values.watch)) {
    process.stdout.write('usage: node --experimental-strip-types scripts/oracle.ts (--once | --watch [--interval 15]) [--vault id] [--registry id] [--oracle id] [--known a,b] [--dry-run] [--log-dir dir] [--ttl-allow s] [--ttl-warn s] [--ttl-deny s] [--write-soft-warn]\n');
    return values.help ? 0 : 2;
  }
  const accounts = accountsFromEnv(env);
  const net = networkFromEnv(env);
  const cfg: OracleConfig = {
    vault: values.vault ?? accounts.vault,
    registry: values.registry ?? accounts.registry,
    oracle: values.oracle ?? accounts.oracle,
    known: (values.known ?? accounts.merchant).split(',').map((s) => s.trim()).filter((s) => s !== ''),
    writeSoftWarn: values['write-soft-warn'] ?? false,
    ttl: {
      ALLOW: parseTtl(values['ttl-allow'], DEFAULT_TTL_S.ALLOW),
      WARN: parseTtl(values['ttl-warn'], DEFAULT_TTL_S.WARN),
      DENY: parseTtl(values['ttl-deny'], DEFAULT_TTL_S.DENY),
    },
    dryRun: values['dry-run'] ?? false,
  };
  const logDir = values['log-dir'] ?? DEFAULT_LOG_DIR;
  mkdirSync(join(logDir, 'snapshots'), { recursive: true });

  const engine = bindEngine(net.networkId, env);
  if (!engine.ok) {
    out(`oracle: the SDK engine is not available: ${engine.why}. Nothing was judged or written.`);
    return 2;
  }
  for (const n of engine.notes) out(`oracle: ${n}`);
  const rpc = createRpc({ readUrls: net.readRpcUrls, sendUrl: net.sendRpcUrl, archivalUrl: net.archivalRpcUrl });
  const views = chainViews(rpc);
  const sender = await oracleSender(rpc, views, env, cfg, out);
  const day = () => new Date().toISOString().slice(0, 10);
  const deps: OracleDeps = {
    views,
    engine: engine.port,
    sender,
    net,
    log: out,
    now: () => new Date(),
    saveSnapshot: (sha, json) => {
      const file = join(logDir, 'snapshots', `${sha}.json`);
      writeFileSync(file, json);
      // Relative to near/ inside the tree: the record's recompute line then runs as written.
      return displayPath(file);
    },
    saveRecord: (rec) => {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, `oracle-${day()}.jsonl`), `${JSON.stringify(rec)}\n`);
    },
  };
  out(`oracle: vault ${cfg.vault}, registry ${cfg.registry}, oracle ${cfg.oracle}, engine ${engine.port.version}${cfg.dryRun ? ', dry run' : ''}`);
  if (values.once) {
    let recs: OracleRecord[];
    try {
      recs = await runOracleOnce(deps, cfg);
    } catch (e) {
      out(`oracle: could not complete a pass over ${cfg.vault}: ${(e as Error).message}. Nothing was written.`);
      return 1;
    }
    out(`oracle: done, ${recs.length} payee(s): ${recs.map((r) => `${r.payee} ${r.action}`).join('; ') || 'nothing held'}`);
    return recs.some((r) => r.action === 'write_failed' || r.action === 'judge_failed') ? 1 : 0;
  }
  let stop = false;
  const onSignal = () => {
    stop = true;
    out('oracle: stopping after this round');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const maxRounds = values['max-rounds'] ? Number.parseInt(values['max-rounds'], 10) : undefined;
  await watch(deps, cfg, { intervalS: Math.max(5, Number.parseInt(values.interval ?? '15', 10) || 15), ...(maxRounds ? { maxRounds } : {}), stopped: () => stop });
  return 0;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`oracle: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
