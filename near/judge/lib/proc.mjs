// Child processes for the --full steps and the SDK verdict CLI: time-boxed, with a heartbeat so
// a long cargo build never looks like a hang, and with the output kept for the report.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const KEEP_BYTES = 256 * 1024;

// Children run in their own process group (detached), so a time box can kill a whole cargo or
// near-sandbox tree at once. The flip side: Ctrl-C in a terminal reaches only the judge's group.
// So every live child is tracked, and on SIGINT or SIGTERM the judge kills each child's group
// before it exits, and no cargo, rustc or sandbox node is left running.
const live = new Set();
let handlersInstalled = false;

function killGroup(child, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  let stopping = false;
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(signal, () => {
      if (stopping) {
        // A second Ctrl-C: no more waiting.
        for (const child of live) killGroup(child, 'SIGKILL');
        process.exit(code);
      }
      stopping = true;
      if (live.size) process.stderr.write(`\njudge: ${signal}, stopping ${live.size} child process group(s)\n`);
      for (const child of live) killGroup(child, 'SIGTERM');
      const started = Date.now();
      const wait = setInterval(() => {
        if (live.size === 0 || Date.now() - started > 2000) {
          clearInterval(wait);
          for (const child of live) killGroup(child, 'SIGKILL');
          process.exit(code);
        }
      }, 50);
    });
  }
}

/** How many children are running right now (for tests). */
export function liveChildren() {
  return live.size;
}

function keepTail(chunks, size) {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > size ? text.slice(-size) : text;
}

/** First match for `bin` on PATH, or null. */
export function which(bin, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Run a command. Resolves (never rejects) with
 * `{ code, signal, stdout, stderr, timedOut, ms, error }`.
 */
export function runProcess(cmd, args, { cwd, env = process.env, timeoutMs = 120000, heartbeatMs = 30000, onHeartbeat } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, ms: 0, error: error.message });
      return;
    }
    if (child.pid !== undefined) {
      installSignalHandlers();
      live.add(child);
    }
    const collect = (list, stream) => (chunk) => {
      list.push(chunk);
      if (stream === 'out') outBytes += chunk.length;
      else errBytes += chunk.length;
      // Bound memory: keep only the tail once a stream grows past the limit.
      if ((stream === 'out' ? outBytes : errBytes) > 4 * KEEP_BYTES) {
        const tail = Buffer.from(keepTail(list, KEEP_BYTES));
        list.length = 0;
        list.push(tail);
        if (stream === 'out') outBytes = tail.length;
        else errBytes = tail.length;
      }
    };
    child.stdout.on('data', collect(out, 'out'));
    child.stderr.on('data', collect(err, 'err'));
    const kill = (signal) => killGroup(child, signal);
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    const beat = onHeartbeat ? setInterval(() => onHeartbeat(Math.round((Date.now() - started) / 1000)), heartbeatMs) : null;
    let spawnError = null;
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code, signal) => {
      live.delete(child);
      clearTimeout(timer);
      if (beat) clearInterval(beat);
      resolve({
        code,
        signal,
        stdout: keepTail(out, KEEP_BYTES),
        stderr: keepTail(err, KEEP_BYTES),
        timedOut,
        ms: Date.now() - started,
        error: spawnError,
      });
    });
  });
}

/** Totals from cargo's "test result: ok. N passed; M failed; ..." lines. */
export function parseCargoTest(text) {
  let passed = 0;
  let failed = 0;
  let suites = 0;
  for (const m of text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    suites++;
  }
  return { passed, failed, suites };
}

/** Totals from node --test, TAP ("# pass 3") or spec ("\u2139 pass 3") reporter. */
export function parseNodeTest(text) {
  const pass = text.match(/^(?:#|\u2139)\s*pass (\d+)/m);
  const fail = text.match(/^(?:#|\u2139)\s*fail (\d+)/m);
  return { passed: pass ? Number(pass[1]) : 0, failed: fail ? Number(fail[1]) : 0, suites: pass ? 1 : 0 };
}
