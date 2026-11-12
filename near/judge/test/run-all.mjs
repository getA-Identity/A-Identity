// `node --test judge/test/` hands this directory to Node as a single test entry; package.json's
// "main" points here, and this imports every *.test.mjs beside it. When a runner finds this file
// by itself instead (npm test's default patterns also run each *.test.mjs directly), it does
// nothing, so no test runs twice.
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === here) {
  for (const name of readdirSync(here).filter((file) => file.endsWith('.test.mjs')).sort()) {
    await import(pathToFileURL(resolve(here, name)).href);
  }
}
