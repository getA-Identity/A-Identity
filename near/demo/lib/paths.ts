// Paths as committed logs show them. A run log and the oracle's records are committed, so they
// must not carry one machine's absolute paths: a snapshot inside the tree is named relative to
// near/ (where package.json is, and where every npm script runs, so
// `npm run verdict -- --offline demo/logs/oracle/snapshots/<sha256>.json` works as written), a
// path under the home folder is written ~/..., and anything else is left as it is.

import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** near/: this file is near/demo/lib/paths.ts. */
export const NEAR_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function inside(base: string, p: string): string | null {
  const r = relative(base, p);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;
  return r.split(sep).join('/');
}

export function displayPath(p: string, root: string = NEAR_ROOT, home: string = homedir()): string {
  if (!isAbsolute(p)) return p;
  const inTree = inside(root, p);
  if (inTree !== null) return inTree;
  const inHome = inside(home, p);
  if (inHome !== null) return `~/${inHome}`;
  return p;
}
