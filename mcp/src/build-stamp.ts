/**
 * Which build is answering.
 *
 * `version` in package.json is hand-bumped and therefore useless for telling a fresh
 * deploy from a stale one: after pushing a backend change there was no way to confirm from
 * outside that the host had actually redeployed, only to assume it. This exposes the
 * commit the running process was built from, so a deploy becomes a thing you can verify
 * instead of a thing you hope happened.
 *
 * Render injects RENDER_GIT_COMMIT and RENDER_GIT_BRANCH into the build and runtime
 * environment. Other hosts use different names, so the common CI variables are checked
 * too, and everything is optional: a local run simply reports "unknown" rather than
 * failing to boot. Nothing here is a secret, these values are already public in the repo.
 */
const COMMIT_VARS = [
  'RENDER_GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT',
  'SOURCE_VERSION', // Heroku
  'COMMIT_SHA',
]

const BRANCH_VARS = ['RENDER_GIT_BRANCH', 'VERCEL_GIT_COMMIT_REF', 'GIT_BRANCH']

function firstOf(names: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim()
    if (v) return v
  }
  return undefined
}

/** Fixed at process start: a long-running instance should keep reporting the build it
 *  was started from, not re-read a mutated environment. */
const STARTED_AT = new Date().toISOString()

export function buildStamp(env: NodeJS.ProcessEnv = process.env): {
  commit: string
  commitShort: string
  branch: string | null
  startedAt: string
} {
  const commit = firstOf(COMMIT_VARS, env) ?? 'unknown'
  return {
    commit,
    commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
    branch: firstOf(BRANCH_VARS, env) ?? null,
    startedAt: STARTED_AT,
  }
}
