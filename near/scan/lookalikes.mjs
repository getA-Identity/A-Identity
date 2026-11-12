// Deterministic lookalike-name generator for the known_good set.
//
// A pure function: the same known_good list always yields the same candidate list in the
// same order, so anyone can re-derive every lookalike_candidate in dataset.json from
// seeds/known-good.json and check that nothing was hand-picked. Existence is decided
// later by a live view_account; this module never touches the network.
//
// NEAR account ids are ASCII only (a-z 0-9 - _ .), so Unicode homoglyphs cannot exist on
// chain. The tricks below are the ASCII ones: confusable letters, separators, typos,
// lure words and flattened sub-account names. Candidates go under .near (anyone can create
// a .near name) plus the bare stem under .tg (HOT usernames, also open to the public).

import { isValidAccountId, isImplicitAccount, isEthImplicitAccount } from "./lib.mjs";

// lookalikes/2 (2026-11-12): a candidate equal to an ancestor of a known_good id is excluded,
// open registrars included (mintbase1.near is Mintbase's own factory, not a lookalike of it).
export const GENERATOR_VERSION = "lookalikes/2";

// Single-position ASCII confusables, applied one position at a time.
const CONFUSABLE_CHARS = {
  o: ["0"],
  "0": ["o"],
  l: ["1", "i"],
  i: ["1", "l"],
  "1": ["l", "i"],
  e: ["3"],
  a: ["4"],
  s: ["5"],
};

// Multi-character confusables (each occurrence replaced on its own).
const CONFUSABLE_PAIRS = [
  ["rn", "m"],
  ["m", "rn"],
  ["vv", "w"],
  ["w", "vv"],
  ["cl", "d"],
  ["d", "cl"],
];

// Words scammers attach to a brand: support, claim, airdrop, rewards, "official".
export const LURE_SUFFIXES = [
  "-near", "near", "_near", "-app", "app", "-official", "official", "-io", "-finance", "finance",
  "-dao", "-protocol", "protocol", "-labs", "-token", "token", "-wallet", "wallet", "-airdrop",
  "airdrop", "-claim", "claim", "-reward", "-rewards", "rewards", "-support", "support", "-help",
  "-bridge", "-v2", "v2", "2", "1", "s",
];
export const LURE_PREFIXES = ["near-", "near", "near_", "app-", "the", "my", "real", "official-", "claim-", "get-", "v2-"];

// Typos (deletion, duplication, transposition) only for stems at least this long:
// on a 3-letter stem every typo is just another short word.
const MIN_TYPO_STEM = 4;
// Separator insertion at every interior position only for short single-word stems.
const MAX_INSERT_STEM = 12;

function stemOk(s) {
  return /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(s);
}

// Brand stems of one known account.
//   v2.ref-finance.near -> stem "ref-finance", flattened "v2-ref-finance", "v2ref-finance", "v2_ref-finance"
//   token.sweat         -> stem "sweat", flattened "token-sweat", "tokensweat", "token_sweat"
//   aurora              -> stem "aurora"
// Implicit (hex) accounts have no name to imitate and are skipped; hex labels inside
// bridged-token ids (<eth address>.factory.bridge.near) are skipped for the same reason.
export function stemsOf(accountId) {
  if (isImplicitAccount(accountId) || isEthImplicitAccount(accountId)) return { stems: [], flattened: [] };
  const labels = accountId.split(".");
  const tla = labels[labels.length - 1];
  const named = tla === "near" || tla === "tg" ? labels.slice(0, -1) : labels;
  if (named.length === 0) return { stems: [], flattened: [] };
  const brand = tla === "near" || tla === "tg" ? named[named.length - 1] : tla;
  const stems = stemOk(brand) && !/^[0-9a-f]{40}$/.test(brand) ? [brand] : [];
  const flattened = [];
  const parts = named.filter((p) => !/^[0-9a-f]{40}$/.test(p));
  if (parts.length >= 2 && parts.length === named.length) {
    for (const sep of ["-", "", "_"]) {
      const f = parts.join(sep);
      if (stemOk(f)) flattened.push(f);
    }
  }
  return { stems, flattened };
}

// Root accounts the brand itself controls: a candidate equal to one of these, or under one,
// is the brand's own namespace, not a lookalike (only a parent can create its sub-accounts).
// The account a brand controls its names from: the registrable name under .near or .tg
// (ref-finance.near for v2.ref-finance.near), else the top-level account (sweat for
// token.sweat). Implicit ids have none.
export function brandRootOf(id) {
  if (isImplicitAccount(id) || isEthImplicitAccount(id)) return null;
  const labels = id.split(".");
  const tla = labels[labels.length - 1];
  return (tla === "near" || tla === "tg") && labels.length >= 2 ? labels.slice(-2).join(".") : tla;
}

// Open registrars: anyone can create a name under them, so a name under one is not the
// brand's own namespace. The registrar itself still is not a lookalike (see ancestorsOf).
export const OPEN_REGISTRARS = ["near", "tg", "sweat", "pool.near", "tkn.near", "sputnik-dao.near", "mintbase1.near", "meme-cooking.near", "lockup.near", "factory.bridge.near"];

export function brandRoots(knownGood) {
  const roots = new Set();
  for (const id of knownGood) {
    const root = brandRootOf(id);
    if (root) roots.add(root);
  }
  for (const open of OPEN_REGISTRARS) roots.delete(open);
  return roots;
}

// Every ancestor of every known_good id: market.mintbase1.near and mintbase1.near for
// simple.market.mintbase1.near. An ancestor created the known account (or created its creator),
// so it is the brand itself or the open registrar that hosts it, never an impostor of it.
export function ancestorsOf(knownGood) {
  const out = new Set();
  for (const id of knownGood) {
    const labels = id.split(".");
    for (let i = 1; i < labels.length; i++) out.add(labels.slice(i).join("."));
  }
  return out;
}

// The brand words one known_good seed contributes, exactly as the generator uses them: the
// stems declared in the seed (or the default from stemsOf) plus the flattened forms.
export function brandStemsOf(entry) {
  const e = typeof entry === "string" ? { account_id: entry } : entry;
  const derived = stemsOf(e.account_id);
  const stems = Array.isArray(e.stems) ? e.stems.filter(stemOk) : derived.stems;
  return { stems, flattened: derived.flattened };
}

function variants(stem) {
  const out = [];
  const add = (label, rule) => out.push({ label, rule });
  const n = stem.length;

  // 1. Confusable characters, one position at a time.
  for (let i = 0; i < n; i++) {
    for (const r of CONFUSABLE_CHARS[stem[i]] ?? []) add(stem.slice(0, i) + r + stem.slice(i + 1), "homoglyph");
  }
  for (const [from, to] of CONFUSABLE_PAIRS) {
    let at = stem.indexOf(from);
    while (at !== -1) {
      add(stem.slice(0, at) + to + stem.slice(at + from.length), "homoglyph");
      at = stem.indexOf(from, at + 1);
    }
  }

  // 2. Separators: drop them, swap '-' and '_', split into a fake sub-account, or insert one.
  if (/[-_]/.test(stem)) {
    add(stem.replace(/[-_]/g, ""), "separator");
    add(stem.replace(/-/g, "_"), "separator");
    add(stem.replace(/_/g, "-"), "separator");
    for (let i = 0; i < n; i++) {
      if (stem[i] === "-" || stem[i] === "_") {
        add(stem.slice(0, i) + stem.slice(i + 1), "separator");
        add(stem.slice(0, i) + "." + stem.slice(i + 1), "separator_dot");
      }
    }
  } else if (n <= MAX_INSERT_STEM) {
    for (let i = 1; i < n; i++) {
      add(stem.slice(0, i) + "-" + stem.slice(i), "separator");
      add(stem.slice(0, i) + "_" + stem.slice(i), "separator");
    }
  }

  // 3. Typos: one deleted, doubled or swapped character.
  if (n >= MIN_TYPO_STEM) {
    for (let i = 0; i < n; i++) add(stem.slice(0, i) + stem.slice(i + 1), "typo_deletion");
    for (let i = 0; i < n; i++) add(stem.slice(0, i + 1) + stem[i] + stem.slice(i + 1), "typo_duplication");
    for (let i = 0; i + 1 < n; i++) {
      if (stem[i] !== stem[i + 1]) add(stem.slice(0, i) + stem[i + 1] + stem[i] + stem.slice(i + 2), "typo_transposition");
    }
  }

  // 4. Lure words and brand + word.
  for (const s of LURE_SUFFIXES) add(stem + s, "affix");
  for (const p of LURE_PREFIXES) add(p + stem, "affix");
  return out;
}

// Input: the known_good seeds, either account id strings or { account_id, stems } objects.
// stems are the brand words a scammer would imitate, declared next to each seed's citation
// (for example "blackdragon" for blackdragon.tkn.near, whose parent tkn.near is an open
// token factory); without stems the default from stemsOf() is used. Flattened forms of
// multi-label ids are always added.
// Returns [{ account_id, imitates, stem, rule }], sorted by account_id, one row per candidate
// (the first rule that produced it, in the fixed order above, wins; imitates is the first
// known account, in input order, whose stem produced it).
export function generateLookalikes(seeds) {
  const entries = seeds.map((s) => (typeof s === "string" ? { account_id: s } : s));
  const knownGood = entries.map((e) => e.account_id);
  const known = new Set(knownGood);
  const ancestors = ancestorsOf(knownGood);
  const roots = brandRoots(knownGood);
  const underRoot = (id) => {
    for (const r of roots) if (id === r || id.endsWith("." + r)) return true;
    return false;
  };
  const seen = new Map();
  const consider = (accountId, imitates, stem, rule) => {
    if (seen.has(accountId)) return;
    if (!isValidAccountId(accountId)) return;
    if (known.has(accountId) || ancestors.has(accountId) || underRoot(accountId)) return;
    seen.set(accountId, { account_id: accountId, imitates, stem, rule });
  };
  for (const entry of entries) {
    const id = entry.account_id;
    const { stems, flattened } = brandStemsOf(entry);
    for (const stem of stems) {
      consider(`${stem}.near`, id, stem, "exact_stem");
      consider(`${stem}.tg`, id, stem, "exact_stem_tg");
      for (const v of variants(stem)) consider(`${v.label}.near`, id, stem, v.rule);
    }
    for (const f of flattened) consider(`${f}.near`, id, f, "flattened_subaccount");
  }
  return [...seen.values()].sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));
}

// Row annotations. Pure like the generator: build-dataset.mjs writes them and the offline tests
// recompute them from dataset.json.

export const LOOKALIKE_NOTE = "Name generated from a known_good brand by the documented rule in scan/lookalikes.mjs and found to exist. Unknown intent: a lookalike name is a risk signal, not evidence of a scam.";

// The derived evidence line. It states only what was read: the creation when the indexer
// returned one, "creation not indexed" when it answered with no transaction, and "activity not
// read" when the indexer failed (the transaction count is then left out, not written as 0).
export function derivedQuote(c, f) {
  const created = f.created_at
    ? `created ${f.created_at.slice(0, 10)}${f.creator ? ` by ${f.creator}` : ""}`
    : f.creation_indexed === false
      ? "creation not indexed"
      : "activity not read (indexer error)";
  const txs = typeof f.txs_count === "number" ? `; ${f.txs_count} transactions (FastNEAR)` : "";
  return `derived: ${c.rule} of "${c.stem}" (imitates ${c.imitates}); view_account found it at block ${f.block_height}; ${created}${txs}`;
}

// Cross-row facts of the lookalike rows:
//   created_by_brand    the creator is the imitated brand's own root, or one of its known_good
//                       contracts (a sub-account of a brand can be a public onboarding service:
//                       free-name.herewallet.near creates names for anyone, so it does not count)
//   creator_lookalikes  how many lookalike rows the same account created (meaningless for public
//                       onboarding relayers such as meteor-relayer.near or coin-op.near)
//   predates_brand      created before every known_good account that contributes the stem: the
//                       name is older than the brand's account on NEAR
export function annotateLookalikes(rows, knownRows, seeds) {
  const knownIds = new Set(seeds.map((s) => s.account_id));
  const createdAt = new Map(knownRows.map((e) => [e.account_id, e.facts.created_at]));
  const firstByStem = new Map();
  for (const seed of seeds) {
    const t = createdAt.get(seed.account_id);
    if (!t) continue;
    const { stems, flattened } = brandStemsOf(seed);
    for (const s of [...stems, ...flattened]) if (!firstByStem.has(s) || t < firstByStem.get(s)) firstByStem.set(s, t);
  }
  const perCreator = new Map();
  for (const e of rows) if (e.facts.creator) perCreator.set(e.facts.creator, (perCreator.get(e.facts.creator) ?? 0) + 1);
  for (const e of rows) {
    const f = e.facts;
    for (const k of ["created_by_brand", "creator_lookalikes", "predates_brand"]) delete f[k];
    const imitatedRoot = brandRootOf(f.imitates);
    if (f.creator && imitatedRoot && (f.creator === imitatedRoot || (knownIds.has(f.creator) && brandRootOf(f.creator) === imitatedRoot))) f.created_by_brand = true;
    if (f.creator) f.creator_lookalikes = perCreator.get(f.creator);
    const first = firstByStem.get(f.stem);
    if (f.created_at && first) f.predates_brand = f.created_at < first;
    e.notes =
      LOOKALIKE_NOTE +
      (f.created_by_brand ? " Created by the brand's own account, so likely a defensive registration." : "") +
      (f.predates_brand ? " Created before every known_good account that uses this brand word, so it may be an older, unrelated name." : "");
  }
  return rows;
}
