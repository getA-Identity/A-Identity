import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests,
  createAgent,
  listPlatformAgents,
  updateAgentLogo,
  sanitizeLogoUrl,
  MAX_LOGO_DATA_URL_CHARS,
  type PlatformAgent,
} from './platform.js'

/**
 * The agent avatar has two write paths now: registration, and the dashboard changing it
 * later. The point of these tests is that they are ONE path in every way that matters -
 * the same owner gate and the same size bound - because an avatar the wizard accepts and
 * the dashboard rejects (or the other way round) is the kind of drift nobody notices
 * until a user reports it.
 */

// Persistence is OFF for this whole process from the first line: these tests seed the
// in-memory state and must never overwrite the real persisted dev state.
__resetPlatformStateForTests()

const OWNER = 'owner@test'
const STRANGER = 'stranger@test'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ=='
/** One character past the shared bound. */
const TOO_BIG = 'data:image/png;base64,' + 'A'.repeat(MAX_LOGO_DATA_URL_CHARS)

let seq = 0
function seedAgent(logoUrl?: string): PlatformAgent {
  seq += 1
  return createAgent({
    name: `Logo Test Agent ${seq}`,
    description: 'Seeded for profile image tests.',
    category: 'Research',
    capabilities: [],
    permissions: {},
    logoUrl,
    owner: OWNER,
  })
}

/** Read the stored agent back from state, not the returned copy. */
function stored(id: string): PlatformAgent {
  const a = listPlatformAgents().find((x) => x.id === id)
  assert.ok(a, 'the seeded agent is missing from state')
  return a
}

test('the owner can set a profile image on an agent that registered without one', () => {
  const agent = seedAgent()
  assert.equal(agent.logoUrl, undefined)

  const r = updateAgentLogo(agent.id, PNG, OWNER)
  assert.ok(!('error' in r), 'the owner was refused')
  assert.equal(r.logo, 'set')
  assert.equal(r.agent.logoUrl, PNG)
  assert.equal(stored(agent.id).logoUrl, PNG)
})

test('replacing an existing image reports a replacement, not a first set', () => {
  const agent = seedAgent(PNG)
  const r = updateAgentLogo(agent.id, JPEG, OWNER)
  assert.ok(!('error' in r))
  assert.equal(r.logo, 'set')
  assert.equal(stored(agent.id).logoUrl, JPEG)
  assert.match(r.note, /replaced/i)
})

test('null removes the image and the agent falls back to its generated mark', () => {
  const agent = seedAgent(PNG)
  const r = updateAgentLogo(agent.id, null, OWNER)
  assert.ok(!('error' in r))
  assert.equal(r.logo, 'removed')
  assert.equal(stored(agent.id).logoUrl, undefined)
  assert.equal('logoUrl' in r.agent, false, 'a removed image must not be echoed back')
})

test('removing an image that was never there is a clean no-op, not an error', () => {
  const agent = seedAgent()
  const r = updateAgentLogo(agent.id, null, OWNER)
  assert.ok(!('error' in r), 'a double remove must not fail')
  assert.equal(r.logo, 'unchanged')
  assert.equal(stored(agent.id).logoUrl, undefined)
})

test('a stranger cannot change another owner\'s profile image', () => {
  const agent = seedAgent(PNG)
  const r = updateAgentLogo(agent.id, JPEG, STRANGER)
  assert.ok('error' in r)
  assert.match(r.error, /^Forbidden/, 'the ownership refusal must map to 403')
  assert.equal(stored(agent.id).logoUrl, PNG, 'the image changed despite the refusal')
})

test('an anonymous caller cannot change a profile image', () => {
  const agent = seedAgent(PNG)
  const r = updateAgentLogo(agent.id, JPEG, undefined)
  assert.ok('error' in r)
  assert.match(r.error, /^Forbidden/)
  assert.equal(stored(agent.id).logoUrl, PNG)
})

test('an unknown agent is a 404-shaped error, not a silent success', () => {
  const r = updateAgentLogo('agent_does_not_exist', PNG, OWNER)
  assert.ok('error' in r)
  assert.match(r.error, /^Unknown/)
})

test('the update path applies the same size bound registration applies', () => {
  // Registration drops an oversized logo; the update path refuses it. Same predicate,
  // different manners: one is a field on a bigger form, the other is the whole request.
  assert.equal(seedAgent(TOO_BIG).logoUrl, undefined, 'registration stored an oversized logo')

  const agent = seedAgent()
  const r = updateAgentLogo(agent.id, TOO_BIG, OWNER)
  assert.ok('error' in r)
  assert.match(r.error, new RegExp(String(MAX_LOGO_DATA_URL_CHARS)))
  assert.equal(stored(agent.id).logoUrl, undefined)
})

test('a remote URL is not a profile image, on either path', () => {
  assert.equal(seedAgent('https://example.com/logo.png').logoUrl, undefined)

  const agent = seedAgent()
  const r = updateAgentLogo(agent.id, 'https://example.com/logo.png', OWNER)
  assert.ok('error' in r, 'a remote URL was accepted as an inline image')
  assert.equal(stored(agent.id).logoUrl, undefined)
})

test('a non-image data URL is refused', () => {
  const agent = seedAgent()
  const r = updateAgentLogo(agent.id, 'data:text/html,<script>alert(1)</script>', OWNER)
  assert.ok('error' in r)
  assert.equal(stored(agent.id).logoUrl, undefined)
})

test('the shared sanitizer is the single definition of an acceptable logo', () => {
  // If this drifts, the wizard and the dashboard start disagreeing about the same file.
  const PREFIX = 'data:image/png;base64,'
  const exactlyAtBound = PREFIX + 'A'.repeat(MAX_LOGO_DATA_URL_CHARS - PREFIX.length)
  assert.equal(exactlyAtBound.length, MAX_LOGO_DATA_URL_CHARS)

  assert.equal(sanitizeLogoUrl(PNG), PNG)
  assert.equal(sanitizeLogoUrl(exactlyAtBound), exactlyAtBound, 'the bound is inclusive')
  assert.equal(sanitizeLogoUrl(TOO_BIG), undefined)
  assert.equal(sanitizeLogoUrl(''), undefined)
  assert.equal(sanitizeLogoUrl(null), undefined)
  assert.equal(sanitizeLogoUrl(42), undefined)
  assert.equal(sanitizeLogoUrl({ toString: () => PNG }), undefined)
})

test('a set and a remove are both written to the agent activity trail', () => {
  const agent = seedAgent()
  updateAgentLogo(agent.id, PNG, OWNER)
  updateAgentLogo(agent.id, null, OWNER)
  const trail = stored(agent.id).activity.map((e) => e.text)
  assert.ok(trail.some((t) => /Profile image set/.test(t)), 'the set is missing from the trail')
  assert.ok(trail.some((t) => /Profile image removed/.test(t)), 'the removal is missing from the trail')
})
