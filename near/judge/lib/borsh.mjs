// A Borsh reader for NEAR's SignedTransaction, Ed25519 signature checking with node:crypto, and
// the access-key rule nearcore applies to a function-call key.
//
// Why the judge needs this: a transaction the protocol rejects never reaches the chain, so the
// attack demo's "the agent key could not do X" can only be shown as a recorded RPC error. A log
// line alone is "trust us". With the signed bytes from that log the judge can show three things
// without trusting the log: the transaction really was signed by the agent's public key (the
// signature verifies), it asked for exactly what the log says (decoded here), and nearcore's own
// rule, applied to that key's permission AS IT WAS ON CHAIN at the block the transaction names
// (read from archival RPC), rejects it with the error the log recorded.
//
// Layout follows nearcore's core/primitives as near-api-js 7.5.3 encodes it: Transaction V0, and
// V1 behind a leading 1 byte (which no V0 can start with, because a V0 starts with the length of
// an account id and that is at least 2), with a gas-key nonce and a nonce mode.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { encode as b58encode } from './base58.mjs';

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  need(n) {
    if (this.offset + n > this.bytes.length) {
      throw new Error(`borsh: unexpected end of input at byte ${this.offset} (needed ${n})`);
    }
  }

  u8() {
    this.need(1);
    return this.bytes[this.offset++];
  }

  u32() {
    this.need(4);
    const value = Buffer.from(this.bytes.subarray(this.offset, this.offset + 4)).readUInt32LE(0);
    this.offset += 4;
    return value;
  }

  u64() {
    this.need(8);
    const value = Buffer.from(this.bytes.subarray(this.offset, this.offset + 8)).readBigUInt64LE(0);
    this.offset += 8;
    return value;
  }

  u128() {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) + lo;
  }

  fixed(n) {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  vecBytes() {
    return this.fixed(this.u32());
  }

  string() {
    return Buffer.from(this.vecBytes()).toString('utf8');
  }

  vec(readItem) {
    const length = this.u32();
    if (length > 10000) throw new Error(`borsh: implausible vector length ${length}`);
    return Array.from({ length }, () => readItem());
  }

  option(readItem) {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return readItem();
    throw new Error(`borsh: bad option tag ${tag}`);
  }
}

const KEY_TYPES = {
  0: { name: 'ed25519', keyLength: 32, sigLength: 64 },
  1: { name: 'secp256k1', keyLength: 64, sigLength: 65 },
  2: { name: 'mldsa65', keyLength: 1952, sigLength: 3309 },
};

function readPublicKey(r) {
  const type = r.u8();
  const kind = KEY_TYPES[type];
  if (!kind) throw new Error(`borsh: unknown key type ${type}`);
  const data = r.fixed(kind.keyLength);
  return { type: kind.name, data, text: `${kind.name}:${b58encode(data)}` };
}

function readSignature(r) {
  const type = r.u8();
  const kind = KEY_TYPES[type];
  if (!kind) throw new Error(`borsh: unknown signature type ${type}`);
  return { type: kind.name, data: r.fixed(kind.sigLength) };
}

function readFunctionCallPermission(r) {
  const allowance = r.option(() => r.u128());
  const receiver_id = r.string();
  const method_names = r.vec(() => r.string());
  return { kind: 'FunctionCall', allowance: allowance === null ? null : allowance.toString(), receiver_id, method_names };
}

function readGasKeyInfo(r) {
  const balance = r.u128();
  const numNonces = Buffer.from(r.fixed(2)).readUInt16LE(0);
  return { balance: balance.toString(), num_nonces: numNonces };
}

function readPermission(r) {
  const tag = r.u8();
  if (tag === 0) return readFunctionCallPermission(r);
  if (tag === 1) return { kind: 'FullAccess' };
  if (tag === 2) {
    const gas_key = readGasKeyInfo(r);
    return { ...readFunctionCallPermission(r), gas_key };
  }
  if (tag === 3) return { kind: 'FullAccess', gas_key: readGasKeyInfo(r) };
  throw new Error(`borsh: unsupported access key permission tag ${tag}`);
}

function readAction(r, depth = 0) {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { type: 'CreateAccount' };
    case 1: {
      const code = r.vecBytes();
      return { type: 'DeployContract', code_bytes: code.length, code_sha256: createHash('sha256').update(code).digest('hex') };
    }
    case 2: {
      const method_name = r.string();
      const args = r.vecBytes();
      const gas = r.u64();
      const deposit = r.u128();
      return { type: 'FunctionCall', method_name, args_base64: Buffer.from(args).toString('base64'), gas: gas.toString(), deposit: deposit.toString() };
    }
    case 3:
      return { type: 'Transfer', deposit: r.u128().toString() };
    case 4: {
      const stake = r.u128();
      return { type: 'Stake', stake: stake.toString(), public_key: readPublicKey(r).text };
    }
    case 5: {
      const public_key = readPublicKey(r).text;
      const nonce = r.u64();
      return { type: 'AddKey', public_key, access_key: { nonce: nonce.toString(), permission: readPermission(r) } };
    }
    case 6:
      return { type: 'DeleteKey', public_key: readPublicKey(r).text };
    case 7:
      return { type: 'DeleteAccount', beneficiary_id: r.string() };
    case 8: {
      if (depth > 0) throw new Error('borsh: nested delegate action');
      const sender_id = r.string();
      const receiver_id = r.string();
      const actions = r.vec(() => readAction(r, depth + 1));
      const nonce = r.u64();
      const max_block_height = r.u64();
      const public_key = readPublicKey(r).text;
      readSignature(r);
      return { type: 'Delegate', sender_id, receiver_id, actions, nonce: nonce.toString(), max_block_height: max_block_height.toString(), public_key };
    }
    case 9: {
      const code = r.vecBytes();
      const mode = r.u8();
      return { type: 'DeployGlobalContract', code_bytes: code.length, deploy_mode: mode === 0 ? 'CodeHash' : 'AccountId' };
    }
    case 10: {
      const kind = r.u8();
      const identifier = kind === 0 ? { code_hash: b58encode(r.fixed(32)) } : { account_id: r.string() };
      return { type: 'UseGlobalContract', ...identifier };
    }
    case 12: {
      const public_key = readPublicKey(r).text;
      return { type: 'TransferToGasKey', public_key, deposit: r.u128().toString() };
    }
    case 13: {
      const public_key = readPublicKey(r).text;
      return { type: 'WithdrawFromGasKey', public_key, amount: r.u128().toString() };
    }
    default:
      throw new Error(`borsh: action tag ${tag} is not supported by this decoder`);
  }
}

/**
 * Decode a base64 SignedTransaction. Returns the transaction fields, the hash (base58 of the
 * sha256 of the transaction bytes, which is the tx hash NEAR reports) and whether the signature
 * verifies against the transaction's own public key.
 */
export function decodeSignedTransaction(base64) {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  const r = new Reader(bytes);
  let version = 0;
  if (bytes[0] === 1) {
    version = 1;
    r.u8();
  }
  const signer_id = r.string();
  const publicKey = readPublicKey(r);
  let nonce;
  let nonce_index = null;
  if (version === 1) {
    const nonceKind = r.u8();
    nonce = r.u64();
    if (nonceKind === 1) nonce_index = Buffer.from(r.fixed(2)).readUInt16LE(0);
    else if (nonceKind !== 0) throw new Error(`borsh: unknown transaction nonce kind ${nonceKind}`);
  } else {
    nonce = r.u64();
  }
  const receiver_id = r.string();
  const block_hash = b58encode(r.fixed(32));
  const actions = r.vec(() => readAction(r));
  let nonce_mode = null;
  if (version === 1) {
    const mode = r.u8();
    if (mode > 1) throw new Error(`borsh: unknown nonce mode ${mode}`);
    nonce_mode = mode === 0 ? 'monotonic' : 'strict';
  }
  const txEnd = r.offset;
  const signature = readSignature(r);
  if (r.offset !== bytes.length) throw new Error(`borsh: ${bytes.length - r.offset} trailing bytes after the signature`);

  const hashBytes = createHash('sha256').update(bytes.subarray(0, txEnd)).digest();
  let signature_valid = false;
  if (publicKey.type === 'ed25519' && signature.type === 'ed25519') {
    signature_valid = verifyEd25519(publicKey.data, hashBytes, signature.data);
  }
  return {
    version,
    signer_id,
    public_key: publicKey.text,
    nonce: nonce.toString(),
    receiver_id,
    block_hash,
    actions,
    nonce_index,
    nonce_mode,
    hash: b58encode(hashBytes),
    signature_type: signature.type,
    signature_valid,
  };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(publicKey32, message, signature64) {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey32)]), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature64));
  } catch {
    return false;
  }
}

/**
 * The InvalidAccessKeyError nearcore returns for this transaction under this key permission, or
 * null when the permission lets it through. Order matters and is nearcore's: one action only,
 * and it must be a function call (RequiresFullAccess); no deposit (DepositWithFunctionCall); the
 * key's receiver (ReceiverMismatch); a listed method when the list is not empty
 * (MethodNameMismatch). The allowance is debited before any of these, so NotEnoughAllowance can
 * win over all of them; it depends on the gas price, so it is not derived here.
 */
export function accessKeyRule(permission, tx) {
  if (permission.kind === 'FullAccess') return null;
  if (permission.kind !== 'FunctionCall') return 'UnknownPermission';
  // A function-call gas key follows the same function-call rules.
  if (tx.actions.length !== 1) return 'RequiresFullAccess';
  const action = tx.actions[0];
  if (action.type !== 'FunctionCall') return 'RequiresFullAccess';
  if (BigInt(action.deposit) > 0n) return 'DepositWithFunctionCall';
  if (tx.receiver_id !== permission.receiver_id) return 'ReceiverMismatch';
  if (permission.method_names.length > 0 && !permission.method_names.includes(action.method_name)) return 'MethodNameMismatch';
  return null;
}
