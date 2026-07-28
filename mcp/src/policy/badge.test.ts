import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeFor, deriveBadges, renderBadgeSvg, type Badge } from './badge.js'
import { SURFACES } from './registry.js'
import { buildAuditEntry } from './audit.js'
import { evaluateAction } from './engine.js'
import { defaultActionPolicy } from './policy.js'
import type { AuditEntry } from './audit.js'
import type { AccountSnapshot, NormalizedIntent, Surface } from './types.js'

const NOW = new Date('2026-07-29T12:00:00Z')
const POLICY = defaultActionPolicy('pol_b', NOW.toISOString())

const snap = (): AccountSnapshot => ({
  todayNotionalUsd: 0,
  positions: [{ symbol: 'TSLA', valueUsd: 3_000 }],
  portfolioValueUsd: 10_000,
  cashAvailableUsd: 8_000,
  marginUsedUsd: 0,
  accountType: 'cash',
})

function entryOn(surface: Surface, over: Partial<AuditEntry> = {}, i = 0): AuditEntry {
  const intent: NormalizedIntent = { kind: 'order', side: 'buy', symbol: 'TSLA', notionalUsd: 40 }
  const decision = evaluateAction({ surface: 'trade', policy: POLICY, intent, snapshot: snap(), now: NOW })
  return {
    ...buildAuditEntry({ id: `aud_${i}`, ts: NOW.toISOString(), agentId: 'a', intent, snapshot: snap(), decision }),
    surface,
    ...over,
  }
}

const badges = (policyConfigured: boolean, entries: AuditEntry[] = []) =>
  deriveBadges({ surfaces: SURFACES, policyConfigured, entries })

const trade = (configured: boolean, entries: AuditEntry[] = []) =>
  badgeFor(badges(configured, entries), 'trade') as Badge

// ── a badge has to be earned ─────────────────────────────────────────────────────

test('an unconfigured agent gets "no policy", never a clean badge', () => {
  const b = trade(false)
  assert.equal(b.level, 'none')
  assert.equal(b.label, 'no policy')
  assert.ok(b.note.includes('Nothing is being enforced'))
})

test('a configured policy with no decisions is only "policy set"', () => {
  const b = trade(true)
  assert.equal(b.level, 'configured')
  assert.ok(
    b.note.includes('not yet a track record'),
    'a setting must not read as a history',
  )
})

test('configured plus recorded decisions earns "enforced"', () => {
  const b = trade(true, [entryOn('trade')])
  assert.equal(b.level, 'enforced')
  assert.equal(b.label, 'enforced')
})

test('a refused override attempt downgrades the badge instead of hiding', () => {
  // A badge that hid override attempts would be worse than no badge.
  const b = trade(true, [entryOn('trade', { overrideAttempts: 1 })])
  assert.equal(b.level, 'enforced_with_flags')
  assert.equal(b.label, 'enforced, flagged')
  assert.ok(b.note.includes('refused and is disclosed'))
})

test('decisions on another surface do not earn this surface a badge', () => {
  // A busy trade history must not mint a spend badge, and vice versa.
  const b = trade(true, [entryOn('spend' as Surface)])
  assert.equal(b.level, 'configured', 'no trade decisions means no trade track record')
})

// ── surfaces come from the registry, and planned means no claim ───────────────────

test('a badge exists for every registry surface, and only for those', () => {
  const set = badges(true, [entryOn('trade')])
  assert.deepEqual(set.map((b) => b.surface), SURFACES.map((s) => s.id))
})

test('a planned surface can only ever read unavailable', () => {
  const set = badges(true, [entryOn('trade')])
  for (const s of SURFACES.filter((s) => s.status !== 'live')) {
    const b = badgeFor(set, s.id) as Badge
    assert.equal(b.level, 'unavailable', s.id)
    assert.ok(b.note.includes('no guardrail claim is made'))
  }
})

test('badgeFor returns undefined for an unknown surface', () => {
  assert.equal(badgeFor(badges(true), 'casino'), undefined)
})

// ── the badge claims discipline, never performance ────────────────────────────────

test('the enforced note explicitly disclaims returns', () => {
  const b = trade(true, [entryOn('trade')])
  assert.ok(b.note.includes('makes no claim about returns'))
  assert.ok(b.note.includes('discipline, not performance'))
})

// ── the SVG is embeddable and leaks nothing ───────────────────────────────────────

test('the SVG is self-contained: no external font, image or stylesheet', () => {
  const svg = renderBadgeSvg(trade(true, [entryOn('trade')]))
  // The xmlns declaration is the one allowed URL: it is a namespace identifier, not a fetch.
  const body = svg.replace('xmlns="http://www.w3.org/2000/svg"', '')
  for (const bad of ['http://', 'https://', '<image', '@import', '<script', 'url(http']) {
    assert.equal(body.includes(bad), false, `SVG referenced ${bad}`)
  }
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
})

test('the SVG carries no number', () => {
  // A count or rate on a public page is both a leak and an invitation to read the badge
  // as a score. Only the level word may appear in the text nodes.
  const svg = renderBadgeSvg(trade(true, [entryOn('trade'), entryOn('trade', {}, 1)]))
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
  for (const txt of texts) {
    assert.equal(/\d/.test(txt), false, `badge text leaked a number: ${txt}`)
  }
})

test('SVG text is escaped', () => {
  const svg = renderBadgeSvg({ surface: 'trade', level: 'enforced', label: 'enforced', note: '' }, {
    label: '<script>x</script>&"',
  })
  assert.equal(svg.includes('<script>'), false)
  assert.ok(svg.includes('&lt;script&gt;'))
})

test('each level renders its own colour, so levels are visually distinct', () => {
  const colors = new Set(
    (['none', 'configured', 'enforced', 'enforced_with_flags'] as const).map((level) => {
      const svg = renderBadgeSvg({ surface: 'trade', level, label: level, note: '' })
      return /fill="(#[0-9a-f]{6})"\/>\s*<rect width/.exec(svg)?.[1] ?? svg
    }),
  )
  assert.equal(colors.size, 4)
})
