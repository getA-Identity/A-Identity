// The run log: a readable story on stdout and in <run-id>.txt, and the full record in
// <run-id>.json (every line, every model exchange without the key, every transaction with its
// links, every protocol rejection with the exact RPC error and the signed bytes that were sent).
//
// Every line carries a tag that says WHO acted on it, never just the run's mode:
//   model     the model's own output: the tool call it proposed, its words, its reasoning.
//   scripted  the demo script acting with no model, in place of an agent or a person.
//   report    what the demo read back or computed about a step a model started (the guard's
//             verdict, the vault's answer, the result), and run-level lines.
// A --no-llm run has no model at all, so every line of it says "scripted". In an --llm run the
// setup, c and e phases and the owner's approvals are scripted too, and say so: only lines the
// model produced say "model". Every line is also scrubbed of the secrets the run knows about
// before it is printed or stored.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RunMode = {
  /** --llm was asked for. */
  llm: boolean;
  dryRun: boolean;
  /** The model the run calls (in a dry run: would call). */
  model?: string;
  /** --llm was asked for but no model can be called (for example no NEAR AI key): why. The model
   * phases are skipped and nothing in the run is a model's decision. */
  modelSkipped?: string;
};

/** Who acted on a line. See the header of this file. */
export type Actor = 'model' | 'scripted' | 'report';

export type LogLine = { t: string; phase: string; tag: string; source: string; text: string };

export type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'PREPARED' | 'PLANNED' | 'MODEL_DECLINED';

export type PhaseRecord = {
  id: string;
  title: string;
  expectation: string;
  result: Outcome;
  notes: string[];
};

export type TxRecord = {
  phase: string;
  step: string;
  tx_hash: string;
  signer_id: string;
  receiver_id: string;
  explorer: string;
  archival_curl: string;
  final_execution_status: string;
  summary: string;
  pay_outcome?: unknown;
  events: Array<{ executor_id: string; standard: string; event: string; data: unknown }>;
};

/** The signed bytes of a transaction the RPC node refused at validation. */
export type SignedBytesRecord = {
  /** Exactly what was sent in send_tx (borsh SignedTransaction, base64): a signature, never a
   * key. With it anyone can check the signature, decode what was asked, read the key's
   * permission at block_hash from archival RPC and re-derive nearcore's rule
   * (judge/lib/checks.mjs protocolRejection). */
  signed_tx_base64: string;
  /** sha256 of the transaction, computed locally. The transaction never reached a block, so no
   * chain lookup finds this hash: it only names the bytes above. */
  local_tx_hash: string;
  sent_at: string;
  signer_id: string;
  receiver_id: string;
  public_key: string;
  nonce: string;
  block_hash: string;
};

export type RejectionRecord = {
  phase: string;
  attempt: string;
  label: 'rejected before execution, no transaction';
  error_name: string;
  expected_error: string;
  /** The rule that fired is the one the attempt was built to show. A different rule (for example
   * NotEnoughAllowance) still means nothing executed, but the attempt does not show its rule. */
  rule_matched: boolean;
  rpc_error: unknown;
  /** Earlier tries of this attempt that hit a stale nonce or block hash (nothing executed), kept
   * verbatim; the entry itself is the final try. */
  retries?: Array<{ error_name: string; rpc_error: unknown } & Partial<SignedBytesRecord>>;
} & Partial<SignedBytesRecord>;

export type RunRecord = {
  run_id: string;
  started_at: string;
  finished_at?: string;
  mode: RunMode;
  network: unknown;
  accounts: unknown;
  preflight: unknown[];
  phases: PhaseRecord[];
  lines: LogLine[];
  llm_exchanges: unknown[];
  txs: TxRecord[];
  rejections: RejectionRecord[];
  prepared: Array<{ phase: string; step: string; reason: string; call: unknown }>;
  verdicts: unknown[];
  balances: unknown[];
  summary?: unknown;
};

/** <UTC stamp>-<kind>. The kind names what the run really was: "llm" only when a model was
 * called, "no-model" when --llm was asked for and no model could be, "scripted", "dry-run". */
export function makeRunId(now: Date, mode: RunMode): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const kind = mode.dryRun ? 'dry-run' : mode.modelSkipped ? 'no-model' : mode.llm ? 'llm' : 'scripted';
  return `${stamp}-${kind}`;
}

/** The tag a line carries: who acted. With no model in the run, that is the script, always. */
export function lineTag(mode: RunMode, actor: Actor): string {
  const who = mode.llm ? actor : 'scripted';
  return mode.dryRun ? `dry-run ${who}` : who;
}

/** One phrase for the run's mode, for the head of the text log. */
export function runLabel(mode: RunMode): string {
  if (mode.dryRun) return mode.llm ? `dry run; a real run calls ${mode.model ?? 'a model'}` : 'dry run, scripted';
  if (mode.modelSkipped) return `--llm asked, model phases skipped: ${mode.modelSkipped}`;
  return mode.llm ? `model ${mode.model ?? 'not named'}` : 'scripted, no model';
}

export type StoryLogOptions = {
  runId: string;
  mode: RunMode;
  network: unknown;
  accounts: unknown;
  clock?: () => Date;
  sink?: (line: string) => void;
};

export class StoryLog {
  readonly record: RunRecord;
  private readonly clock: () => Date;
  private readonly sink: (line: string) => void;
  private readonly secrets: string[] = [];

  constructor(opts: StoryLogOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.record = {
      run_id: opts.runId,
      started_at: this.clock().toISOString(),
      mode: opts.mode,
      network: opts.network,
      accounts: opts.accounts,
      preflight: [],
      phases: [],
      lines: [],
      llm_exchanges: [],
      txs: [],
      rejections: [],
      prepared: [],
      verdicts: [],
      balances: [],
    };
  }

  /** Register a secret (a key, an API key). Any line or record field that contains it is scrubbed. */
  addSecret(secret: string): void {
    if (secret.length >= 8 && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('<redacted>');
    return out;
  }

  /** One line. `actor` says who acted on it; a run with no model tags every line "scripted". */
  line(phase: string, source: string, text: string, actor: Actor = 'report'): void {
    const t = this.clock().toISOString().replace(/\.\d+Z$/, 'Z');
    const clean = this.scrub(text);
    const l: LogLine = { t, phase, tag: lineTag(this.record.mode, actor), source, text: clean };
    this.record.lines.push(l);
    this.sink(formatLine(l));
  }

  /** Lines that belong together (a multi-line block such as an invoice) keep the tag on each line. */
  block(phase: string, source: string, text: string, actor: Actor = 'report'): void {
    for (const l of text.split('\n')) this.line(phase, source, `  | ${l}`, actor);
  }

  phase(rec: PhaseRecord): void {
    this.record.phases.push(rec);
  }

  /** The JSON record, scrubbed as a whole one more time before it is written. */
  toJson(): string {
    return this.scrub(JSON.stringify(this.record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }

  toText(): string {
    const head = `A-Identity Guard for NEAR: attack demo run ${this.record.run_id} (${runLabel(this.record.mode)})`;
    const legend = 'tags: [model] the model\'s own output; [scripted] the demo script acting with no model; [report] what the demo read back about a step a model started';
    return this.scrub([head, legend, ...this.record.lines.map(formatLine)].join('\n')) + '\n';
  }

  write(dir: string): { json: string; txt: string } {
    this.record.finished_at = this.clock().toISOString();
    mkdirSync(dir, { recursive: true });
    const json = join(dir, `${this.record.run_id}.json`);
    const txt = join(dir, `${this.record.run_id}.txt`);
    writeFileSync(json, this.toJson());
    writeFileSync(txt, this.toText());
    return { json, txt };
  }
}

export function formatLine(l: LogLine): string {
  return `${l.t} [${l.phase}] [${l.tag}] ${l.source}: ${l.text}`;
}
