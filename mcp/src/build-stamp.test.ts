import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStamp } from './build-stamp.js'

test('reports the Render commit when the host provides it', () => {
  const s = buildStamp({ RENDER_GIT_COMMIT: 'abc1234def5678', RENDER_GIT_BRANCH: 'main' } as NodeJS.ProcessEnv)
  assert.equal(s.commit, 'abc1234def5678')
  assert.equal(s.commitShort, 'abc1234')
  assert.equal(s.branch, 'main')
})

test('falls back through the other common CI variables', () => {
  assert.equal(buildStamp({ VERCEL_GIT_COMMIT_SHA: 'v1' } as NodeJS.ProcessEnv).commit, 'v1')
  assert.equal(buildStamp({ SOURCE_VERSION: 'h1' } as NodeJS.ProcessEnv).commit, 'h1')
})

test('a local run reports unknown instead of throwing', () => {
  const s = buildStamp({} as NodeJS.ProcessEnv)
  assert.equal(s.commit, 'unknown')
  assert.equal(s.commitShort, 'unknown')
  assert.equal(s.branch, null)
})

test('blank and whitespace-only values are not treated as a commit', () => {
  assert.equal(buildStamp({ RENDER_GIT_COMMIT: '   ' } as NodeJS.ProcessEnv).commit, 'unknown')
})

test('earlier variables win over later ones', () => {
  const s = buildStamp({ RENDER_GIT_COMMIT: 'render', GIT_COMMIT: 'generic' } as NodeJS.ProcessEnv)
  assert.equal(s.commit, 'render')
})

test('startedAt is a valid ISO instant and stable across calls', () => {
  const a = buildStamp({} as NodeJS.ProcessEnv).startedAt
  assert.ok(!Number.isNaN(Date.parse(a)))
  assert.equal(a, buildStamp({} as NodeJS.ProcessEnv).startedAt)
})
