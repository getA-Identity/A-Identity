// Base58 with the Bitcoin alphabet: the encoding NEAR uses for code hashes, transaction and
// block hashes, public keys and signatures.
//
// Self-contained on purpose. The judge has to run in a fresh clone with no `npm install`, so it
// cannot borrow bs58 from node_modules. The algorithm is the textbook one (repeated division on
// a little-endian digit array), quadratic in the input length, which is fine for 32 and 64 byte
// values and still fast for a few hundred bytes.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

/** Bytes (Uint8Array, Buffer or an array of numbers) to a base58 string. */
export function encode(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** A base58 string to bytes. Throws on any character outside the alphabet. */
export function decode(text) {
  if (typeof text !== 'string') throw new TypeError('base58: expected a string');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX.get(text[i]);
    if (value === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(text[i])} at position ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

/** True when `text` is base58 that decodes to exactly `length` bytes (32 for a hash). */
export function isBase58OfLength(text, length) {
  if (typeof text !== 'string' || text.length === 0) return false;
  try {
    return decode(text).length === length;
  } catch {
    return false;
  }
}
