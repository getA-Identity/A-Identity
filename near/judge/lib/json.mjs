// JSON helpers: a canonical form for comparing requests, a path reader, and the small matcher
// language claims.json uses to say what a view or an event must contain.
//
// The matcher is deliberately small. A plain object in `expect` is a SUBSET match (every key it
// names must match, other keys are ignored), an array is an exact, ordered match, and a scalar is
// strict equality. Anything else is spelled with one of the `$` operators below, so a claim never
// depends on loose equality or on JavaScript truthiness.

/** Stable JSON: object keys sorted, undefined members dropped. Two values with the same
 *  canonical form are the same JSON value. */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

/** Read `a.b.0.c` from an object. Returns undefined when any segment is missing. */
export function getPath(object, path) {
  if (path === '' || path === undefined) return object;
  let current = object;
  for (const segment of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Integers and decimal strings compare as BigInt, so U128 amounts compare exactly. */
function toNumberish(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number') return value;
  return undefined;
}

function compare(actual, bound) {
  const a = toNumberish(actual);
  const b = toNumberish(bound);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a);
  const y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isEmpty(value) {
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return value === null || value === undefined;
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const a = new Set(actual.map(canonical));
  const b = new Set(expected.map(canonical));
  if (a.size !== actual.length) return false; // duplicates are not a set
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** The operators. Each returns true when `actual` satisfies the operand. */
const OPERATORS = {
  $type: (actual, type) => typeOf(actual) === type,
  $nonEmpty: (actual, wanted) => (wanted ? !isEmpty(actual) : isEmpty(actual)),
  $regex: (actual, pattern) => typeof actual === 'string' && new RegExp(pattern).test(actual),
  $oneOf: (actual, options) => options.some((option) => match(actual, option).length === 0),
  $gte: (actual, bound) => compare(actual, bound) >= 0,
  $gt: (actual, bound) => compare(actual, bound) > 0,
  $lte: (actual, bound) => {
    const c = compare(actual, bound);
    return c !== undefined && c <= 0;
  },
  $lt: (actual, bound) => {
    const c = compare(actual, bound);
    return c !== undefined && c < 0;
  },
  $absent: (actual, wanted) => (wanted ? actual === undefined : actual !== undefined),
  $contains: (actual, item) => Array.isArray(actual) && actual.some((x) => match(x, item).length === 0),
  $len: (actual, length) => (Array.isArray(actual) || typeof actual === 'string') && actual.length === length,
  $exact: (actual, value) => deepEqual(actual, value),
  $setEquals: (actual, items) => sameSet(actual, items),
  $not: (actual, inner) => match(actual, inner).length > 0,
};

export const OPERATOR_NAMES = Object.keys(OPERATORS);

function isOperatorObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => key.startsWith('$'))) return false;
  for (const key of keys) {
    if (!(key in OPERATORS)) throw new Error(`unknown matcher operator ${key}`);
  }
  return true;
}

function show(value) {
  if (value === undefined) return 'missing';
  const text = canonical(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Compare `actual` with `expected`. Returns a list of mismatches, each
 * `{ path, expected, actual }`; an empty list means it matches.
 */
export function match(actual, expected, path = '$') {
  if (isOperatorObject(expected)) {
    const out = [];
    for (const [operator, operand] of Object.entries(expected)) {
      if (!OPERATORS[operator](actual, operand)) {
        out.push({ path, expected: `${operator} ${show(operand)}`, actual: show(actual) });
      }
    }
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [{ path, expected: show(expected), actual: show(actual) }];
    if (actual.length !== expected.length) {
      return [{ path, expected: `${expected.length} items ${show(expected)}`, actual: `${actual.length} items ${show(actual)}` }];
    }
    return expected.flatMap((item, i) => match(actual[i], item, `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [{ path, expected: 'an object', actual: show(actual) }];
    }
    return Object.entries(expected).flatMap(([key, value]) => match(actual[key], value, `${path}.${key}`));
  }
  if (actual !== expected) return [{ path, expected: show(expected), actual: show(actual) }];
  return [];
}

/** One line for a list of mismatches, for a FAIL reason. */
export function describeMismatches(mismatches, limit = 3) {
  const shown = mismatches
    .slice(0, limit)
    .map((m) => `${m.path}: expected ${m.expected}, got ${m.actual}`)
    .join('; ');
  return mismatches.length > limit ? `${shown}; and ${mismatches.length - limit} more` : shown;
}
