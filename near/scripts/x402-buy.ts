// Buy one A-Identity NEAR verdict over x402, as a stock x402 v2 buyer would, and show the payment.
//
//   node --experimental-strip-types scripts/x402-buy.ts --server <url> --account <near testnet account>
//        [--vault <vault account>] [--payer aid-demo-agent.testnet] [--key-file <path>]
//        [--max-amount 10000] [--json]
//
// 1. GET <server>/api/near/x402/check?account=<account> and read the 402 from its PAYMENT-REQUIRED
//    header (x402 v2: base64 JSON).
// 2. Pick the `exact` entry on near:testnet and check it before signing anything: the asset must be
//    Circle's testnet USDC (sdk/src/collect/networks.ts, never usdc.testnet), the amount no more
//    than --max-amount (default 10000, 0.01 USDC), payTo a NEAR account, the window sane.
// 3. Build the NEP-366 SignedDelegate the spec asks for: exactly one ft_transfer(payTo, amount) on
//    the token, 30 TGas, 1 yoctoNEAR attached, nonce one past the key's, max_block_height a few
//    blocks inside maxTimeoutSeconds past the FINAL block (the seller measures the window from
//    FINAL, and a host can lag by a block or two). Signed with the payer's FULL-ACCESS key: a
//    function-call key cannot attach the yoctoNEAR (nearcore DepositWithFunctionCall), so it
//    cannot pay this way.
// 4. Send it in PAYMENT-SIGNATURE, print the verdict and the settlement transaction, then read that
//    transaction from archival RPC and check the transfer here too, without trusting the seller.
//
// Prepared or executed: without a key file, it prints the exact delegate it would sign, labeled
// prepared, and signs and sends nothing. The key is read from a file only (mode 0600, the SDK's
// loadKey), and nothing here prints it.
//
// Exit: 0 paid and confirmed (or prepared without a key), 1 refused or not confirmed, 2 usage or setup.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import { loadKey } from '../sdk/src/chain/keys.ts';
import { NETWORKS } from '../sdk/src/collect/networks.ts';

export const NETWORK = 'near:testnet';
export const DEFAULT_PAYER = 'aid-demo-agent.testnet';
/** 0.01 USDC: the most this script pays unless told otherwise. */
export const DEFAULT_MAX_AMOUNT = 10_000n;
const FT_TRANSFER_GAS = 30_000_000_000_000n;
/** Blocks kept inside the window, so a seller whose host lags ours still measures it as allowed. */
export const WINDOW_MARGIN_BLOCKS = 3;
const ACCOUNT_ID = /^(?=.{2,64}$)(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
const NET = NETWORKS.testnet;

export type Requirement = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
};
export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: Requirement[];
};

/** The 402, from the v2 PAYMENT-REQUIRED header; the body only when the seller says x402Version 1. */
export function readPaymentRequired(header: string | null, body: unknown): PaymentRequired {
  if (header) return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired;
  const b = body as PaymentRequired | null;
  if (b && b.x402Version === 1 && Array.isArray(b.accepts)) return b;
  throw new Error('the 402 carries no PAYMENT-REQUIRED header (x402 v2)');
}

/** The one entry this buyer pays, checked before anything is signed. */
export function pickRequirement(pr: PaymentRequired, opts: { maxAmount: bigint; usdc: string }): { ok: true; req: Requirement } | { ok: false; reason: string } {
  if (pr.x402Version !== 2) return { ok: false, reason: `the seller speaks x402 v${pr.x402Version}; NEAR exact is v2 only` };
  const entry = (pr.accepts ?? []).find((a) => a && a.scheme === 'exact' && a.network === NETWORK);
  if (!entry) return { ok: false, reason: `no exact entry on ${NETWORK} in the 402` };
  if (entry.asset !== opts.usdc) return { ok: false, reason: `the asset ${entry.asset} is not Circle's testnet USDC (${opts.usdc}); refusing to sign` };
  if (!/^\d+$/.test(String(entry.amount)) || BigInt(entry.amount) <= 0n) return { ok: false, reason: `the amount ${String(entry.amount)} is not a positive integer` };
  if (BigInt(entry.amount) > opts.maxAmount) return { ok: false, reason: `the seller asks ${entry.amount}, above --max-amount ${opts.maxAmount}; refusing to sign` };
  if (!ACCOUNT_ID.test(String(entry.payTo))) return { ok: false, reason: `payTo ${String(entry.payTo)} is not a NEAR account id` };
  const t = entry.maxTimeoutSeconds;
  if (!Number.isInteger(t) || t < 10 || t > 600) return { ok: false, reason: `maxTimeoutSeconds ${String(t)} is outside 10..600` };
  return { ok: true, req: entry };
}

/** The exact delegate this script signs, in the shape NEAR's transaction view prints it. */
export function delegatePlan(i: { payer: string; req: Requirement; publicKey: string | null; nonce: bigint | null; finalHeight: number | null }) {
  return {
    sender_id: i.payer,
    receiver_id: i.req.asset,
    actions: [
      {
        FunctionCall: {
          method_name: 'ft_transfer',
          args: { receiver_id: i.req.payTo, amount: i.req.amount },
          gas: FT_TRANSFER_GAS.toString(),
          deposit: '1',
        },
      },
    ],
    nonce: i.nonce === null ? 'the key nonce + 1, read at final' : i.nonce.toString(),
    max_block_height: i.finalHeight === null ? `the final height + ${i.req.maxTimeoutSeconds - WINDOW_MARGIN_BLOCKS}` : String(i.finalHeight + i.req.maxTimeoutSeconds - WINDOW_MARGIN_BLOCKS),
    public_key: i.publicKey ?? 'a full-access key of the payer',
  };
}

/** PAYMENT-SIGNATURE: base64 of the x402 v2 payment payload. */
export function paymentSignatureHeader(pr: PaymentRequired, req: Requirement, signedDelegateAction: string): string {
  const payload = { x402Version: 2, ...(pr.resource ? { resource: pr.resource } : {}), accepted: req, payload: { signedDelegateAction } };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

type TxView = {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { signer_id?: string; receiver_id?: string };
  receipts_outcome?: { id?: string; outcome?: { executor_id?: string; status?: Record<string, unknown>; logs?: string[] } }[];
};

/** The buyer's own check of the seller's claim: the transfer, read from the chain. */
export function confirmTransfer(r: TxView, e: { relayer: string; payer: string; token: string; payTo: string; amount: string }): { ok: true; receiptId: string } | { ok: false; reason: string } {
  if (r.final_execution_status !== 'FINAL') return { ok: false, reason: `not FINAL (${String(r.final_execution_status)})` };
  if (r.transaction?.signer_id !== e.relayer || r.transaction?.receiver_id !== e.payer) return { ok: false, reason: 'not a relayed transaction for this payer' };
  const all = [r.status, ...(r.receipts_outcome ?? []).map((o) => o.outcome?.status)];
  if (all.some((s) => s && typeof s === 'object' && 'Failure' in s)) return { ok: false, reason: 'a receipt failed' };
  for (const o of r.receipts_outcome ?? []) {
    const out = o.outcome;
    if (out?.executor_id !== e.token || !out.status || !('SuccessValue' in out.status)) continue;
    for (const log of out.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let ev: { standard?: string; event?: string; data?: { old_owner_id?: string; new_owner_id?: string; amount?: string }[] };
      try {
        ev = JSON.parse(log.slice('EVENT_JSON:'.length));
      } catch {
        continue;
      }
      if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer' || !Array.isArray(ev.data)) continue;
      if (ev.data.some((d) => d.old_owner_id === e.payer && d.new_owner_id === e.payTo && d.amount === e.amount)) return { ok: true, receiptId: String(o.id) };
    }
  }
  return { ok: false, reason: `no successful ft_transfer of ${e.amount} from ${e.payer} to ${e.payTo} executed by the token` };
}

async function rpc<T>(urls: readonly string[], method: string, params: unknown): Promise<T> {
  const tried: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'x402-buy', method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: T; error?: unknown };
      if (body.error !== undefined) throw new Error(JSON.stringify(body.error).slice(0, 200));
      return body.result as T;
    } catch (e) {
      tried.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`${method}: no host answered (${tried.join('; ')})`);
}

const usd = (amount: string) => {
  const v = BigInt(amount);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
};

async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        server: { type: 'string' },
        account: { type: 'string' },
        vault: { type: 'string' },
        payer: { type: 'string', default: DEFAULT_PAYER },
        'key-file': { type: 'string' },
        'max-amount': { type: 'string', default: DEFAULT_MAX_AMOUNT.toString() },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (values.help || !values.server || !values.account) {
    console.error('usage: x402-buy.ts --server <url> --account <near testnet account> [--vault <id>] [--payer <account>] [--key-file <path>] [--max-amount <units>] [--json]');
    return values.help ? 0 : 2;
  }
  const payer = String(values.payer);
  const url = new URL('/api/near/x402/check', String(values.server));
  url.searchParams.set('account', String(values.account));
  if (values.vault) url.searchParams.set('vault', String(values.vault));
  const out: Record<string, unknown> = { url: url.toString(), payer };
  const say = (line: string) => {
    if (!values.json) console.log(line);
  };

  // 1. The 402.
  const first = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const firstBody = (await first.json().catch(() => null)) as Record<string, unknown> | null;
  if (first.status !== 402) {
    say(`GET ${url}: HTTP ${first.status}, not a 402: ${JSON.stringify(firstBody)}`);
    out.refused = { status: first.status, body: firstBody };
    if (values.json) console.log(JSON.stringify(out, null, 2));
    return 1;
  }
  const pr = readPaymentRequired(first.headers.get('payment-required'), firstBody);
  const pick = pickRequirement(pr, { maxAmount: BigInt(String(values['max-amount'])), usdc: NET.usdc });
  if (!pick.ok) {
    say(`402 refused by this buyer: ${pick.reason}`);
    out.refused = { reason: pick.reason };
    if (values.json) console.log(JSON.stringify(out, null, 2));
    return 1;
  }
  const req = pick.req;
  out.requirement = req;
  say(`402: pay ${req.amount} (${usd(req.amount)} USDC) of ${req.asset} to ${req.payTo} on ${req.network}, window ${req.maxTimeoutSeconds} s`);

  // 2. The key, or the prepared payment.
  const keyFile = String(values['key-file'] ?? join(homedir(), '.near-credentials', 'testnet', `${payer}.json`));
  // Messages name the file relative to the home directory, so a pasted log does not carry the OS user name.
  const keyShown = keyFile.startsWith(homedir()) ? `~${keyFile.slice(homedir().length)}` : keyFile;
  const block = await rpc<{ header: { height: number } }>(NET.rpc, 'block', { finality: 'final' });
  if (!existsSync(keyFile)) {
    out.prepared = delegatePlan({ payer, req, publicKey: null, nonce: null, finalHeight: block.header.height });
    say(`prepared, NOT signed and NOT sent (no key file at ${keyShown}): sign this delegate as ${payer} with a full-access key, then send it base64 in PAYMENT-SIGNATURE`);
    say(JSON.stringify(out.prepared, null, 2));
    if (values.json) console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  const key = await loadKey({ file: keyFile });
  if (!key) throw new Error(`no key in ${keyShown}`);
  const ak = await rpc<{ nonce: number; permission: unknown }>(NET.rpc, 'query', { request_type: 'view_access_key', finality: 'final', account_id: payer, public_key: key.publicKey });
  if (ak.permission !== 'FullAccess') {
    out.refused = { reason: 'not a full-access key: a function-call key cannot attach the 1 yoctoNEAR an ft_transfer needs' };
    say(`refused: ${key.publicKey} is not a full-access key of ${payer}; a function-call key cannot attach the 1 yoctoNEAR an ft_transfer needs`);
    if (values.json) console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  // 3. The SignedDelegate.
  const nonce = BigInt(ak.nonce) + 1n;
  const final = (await rpc<{ header: { height: number } }>(NET.rpc, 'block', { finality: 'final' })).header.height;
  const delegateAction = buildDelegateAction({
    senderId: payer,
    receiverId: req.asset,
    actions: [actions.functionCall('ft_transfer', { receiver_id: req.payTo, amount: req.amount }, FT_TRANSFER_GAS, 1n)],
    nonce,
    maxBlockHeight: BigInt(final + req.maxTimeoutSeconds - WINDOW_MARGIN_BLOCKS),
    publicKey: await key.signer.getPublicKey(),
  });
  const { signedDelegate } = await key.signer.signDelegateAction(delegateAction);
  const signedDelegateAction = Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
  out.signed = delegatePlan({ payer, req, publicKey: key.publicKey, nonce, finalHeight: final });
  say(`signed: one ft_transfer of ${req.amount} to ${req.payTo} as ${payer} (${key.publicKey}), nonce ${nonce}, max_block_height ${final + req.maxTimeoutSeconds - WINDOW_MARGIN_BLOCKS} (final ${final})`);

  // 4. Pay, and read what came back.
  const second = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': paymentSignatureHeader(pr, req, signedDelegateAction) }, signal: AbortSignal.timeout(120_000) });
  const body = (await second.json().catch(() => null)) as Record<string, any> | null;
  const receiptHeader = second.headers.get('payment-response');
  const receipt = receiptHeader ? (JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8')) as Record<string, unknown>) : null;
  out.status = second.status;
  out.payment_response = receipt;
  if (second.status !== 200 || !receipt || receipt.success !== true || !body?.payment) {
    say(`paid request answered HTTP ${second.status}: ${JSON.stringify(body)}`);
    out.body = body;
    if (values.json) console.log(JSON.stringify(out, null, 2));
    return 1;
  }
  const tx = String(receipt.transaction);
  out.verdict = { account: body.account, verdict: body.verdict, score: body.score, reasons: (body.reasons ?? []).map((r: { code: string }) => r.code), block: body.block?.height };
  out.payment = body.payment;
  say(`HTTP 200, PAYMENT-RESPONSE: success ${String(receipt.success)}, transaction ${tx}, network ${String(receipt.network)}, payer ${String(receipt.payer)}`);
  say(`verdict   ${body.verdict}  score ${body.score}/1000  ${body.account} at block ${body.block?.height}  reasons ${((out.verdict as { reasons: string[] }).reasons).join(', ') || '(none)'}`);
  say(`payment   ${body.payment.amount} of ${body.payment.asset} from ${body.payment.payer} to ${body.payment.pay_to}, relayed by ${body.payment.relayer}`);
  say(`          receipt ${body.payment.ft_transfer_receipt}: ${body.payment.event}`);
  say(`          ${body.payment.explorer}`);

  // The buyer's own check, from archival RPC, of what the seller says moved.
  let confirmed: ReturnType<typeof confirmTransfer> = { ok: false, reason: 'not read yet' };
  for (let i = 0; i < 6 && !confirmed.ok; i++) {
    try {
      const view = await rpc<TxView>(NET.archival, 'tx', { tx_hash: tx, sender_account_id: String(body.payment.relayer), wait_until: 'NONE' });
      confirmed = confirmTransfer(view, { relayer: String(body.payment.relayer), payer, token: req.asset, payTo: req.payTo, amount: req.amount });
    } catch (e) {
      confirmed = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!confirmed.ok) await new Promise((r) => setTimeout(r, 2_000));
  }
  out.confirmed_by_buyer = confirmed;
  say(confirmed.ok ? `confirmed by this buyer on archival RPC: the token's receipt ${confirmed.receiptId} moved ${req.amount} from ${payer} to ${req.payTo}` : `NOT confirmed by this buyer: ${confirmed.reason}`);
  if (values.json) console.log(JSON.stringify(out, null, 2));
  return confirmed.ok ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`x402-buy: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
    },
  );
}
