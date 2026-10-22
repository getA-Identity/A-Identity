/**
 * The feedback widget's one promise is that what a person typed reaches the team inbox, or
 * they are told plainly that it did not. These pin both halves: what is accepted, what is
 * refused, what the email carries, and that `delivered: true` only ever follows a provider
 * acceptance. No network: Resend is a fake fetch that records what it was asked to send.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateFeedback,
  feedbackEmail,
  feedbackSubject,
  sendFeedback,
  handleFeedback,
  visitorMarker,
  NOT_CONFIGURED_REASON,
  type Feedback,
  type FeedbackMeta,
} from './feedback.js'

const META: FeedbackMeta = { receivedAt: '2026-10-22T10:00:00.000Z' }
const GOOD = {
  kind: 'bug',
  message: 'The explorer search box loses my query when I press back.',
  email: 'Someone@Example.com',
  page: 'https://a-identity.xyz/explorer?q=0xabc',
  userAgent: 'Mozilla/5.0 (test)',
}

type Call = { url: string; init: RequestInit }
/** A Resend stand-in: records the call, answers with the status and body it is given. */
function fakeFetch(status: number, body: unknown): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetch: impl }
}

const ENV = { RESEND_API_KEY: 're_test', MAGIC_FROM_EMAIL: 'A-Identity <hello@a-identity.xyz>', FEEDBACK_TO_EMAIL: 'team@example.com' } as NodeJS.ProcessEnv

test('a good body is accepted, trimmed and normalized', () => {
  const r = validateFeedback({ ...GOOD, message: `  ${GOOD.message}  ` })
  assert.ok(r.ok)
  assert.deepEqual(r.value, {
    kind: 'bug',
    message: GOOD.message,
    email: 'someone@example.com',
    page: GOOD.page,
    userAgent: GOOD.userAgent,
  })
  // The optional fields really are optional, and an empty string counts as absent.
  const bare = validateFeedback({ kind: 'idea', message: GOOD.message, email: '', page: '', userAgent: '' })
  assert.ok(bare.ok)
  assert.deepEqual(bare.value, { kind: 'idea', message: GOOD.message })
})

test('a short message, an over-long message and an unknown kind are refused with a reason', () => {
  const short = validateFeedback({ kind: 'bug', message: 'too short' })
  assert.equal(short.ok, false)
  assert.match((short as { error: string }).error, /at least 10/)
  const long = validateFeedback({ kind: 'bug', message: 'x'.repeat(2001) })
  assert.equal(long.ok, false)
  assert.match((long as { error: string }).error, /2000/)
  assert.ok(validateFeedback({ kind: 'bug', message: 'x'.repeat(2000) }).ok, 'exactly the maximum is fine')
  const kind = validateFeedback({ kind: 'rant', message: GOOD.message })
  assert.equal(kind.ok, false)
  assert.equal(validateFeedback(null).ok, false)
  assert.equal(validateFeedback([]).ok, false)
})

test('a bad email and a non-http page are refused', () => {
  const email = validateFeedback({ ...GOOD, email: 'not-an-email' })
  assert.equal(email.ok, false)
  assert.match((email as { error: string }).error, /email/)
  const tooLong = validateFeedback({ ...GOOD, email: `${'a'.repeat(250)}@x.io` })
  assert.equal(tooLong.ok, false)
  for (const page of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url']) {
    const r = validateFeedback({ ...GOOD, page })
    assert.equal(r.ok, false, `${page} should be refused`)
    assert.match((r as { error: string }).error, /http/)
  }
  // The two browser-supplied fields are cut rather than refused: a long query string is
  // not the person's fault and must not cost them their message.
  const cut = validateFeedback({ ...GOOD, page: `https://a-identity.xyz/?q=${'z'.repeat(600)}`, userAgent: 'u'.repeat(400) })
  assert.ok(cut.ok)
  assert.equal(cut.value.page?.length, 500)
  assert.equal(cut.value.userAgent?.length, 300)
})

test('the honeypot makes the request look accepted and never reaches the provider', async () => {
  const resend = fakeFetch(200, { id: 'should-not-happen' })
  const r = await handleFeedback({ ...GOOD, website: 'https://spam.example' }, META, ENV, resend.fetch)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, delivered: false, reason: 'ignored' })
  assert.equal(resend.calls.length, 0, 'a tripped honeypot must not send anything')
  // Even an otherwise invalid body gets the same bland answer, so a bot learns nothing.
  const r2 = await handleFeedback({ kind: 'bug', message: 'x', website: 'y' }, META, ENV, resend.fetch)
  assert.equal(r2.status, 200)
  assert.equal(r2.body.reason, 'ignored')
  assert.equal(resend.calls.length, 0)
})

test('the email escapes markup and carries the kind, the page and the reply hint', () => {
  const value: Feedback = {
    kind: 'question',
    message: 'Does <script>alert("x")</script> get rendered? Also "quotes" & ampersands.',
    email: 'ask@example.com',
    page: 'https://a-identity.xyz/faq?a=1&b=2',
    userAgent: 'UA <b>bold</b>',
  }
  const { subject, html, text } = feedbackEmail(value, { ...META, caller: 'wallet:0xabc', visitor: 'deadbeef' })
  assert.doesNotMatch(html, /<script>/, 'the message must be escaped, not rendered')
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('&amp; ampersands'))
  assert.doesNotMatch(html, /<b>bold<\/b>/)
  assert.ok(html.includes('Question'), 'the kind is shown')
  assert.ok(html.includes('href="https://a-identity.xyz/faq?a=1&amp;b=2"'), 'the page is a link, escaped in the attribute')
  assert.ok(html.includes('reply to this email'), 'the reply hint is there when an address was left')
  assert.ok(html.includes('ask@example.com'))
  assert.ok(html.includes('wallet:0xabc') && html.includes('deadbeef'))
  assert.ok(text.includes(value.message) && text.includes('Page: https://a-identity.xyz/faq?a=1&b=2'))
  assert.ok(subject.startsWith('[A-Identity feedback] question: Does <script>'))
  // Without an address the email says so instead of pretending there is someone to answer.
  const anon = feedbackEmail({ kind: 'other', message: 'anonymous note of enough length' }, META)
  assert.ok(anon.html.includes('cannot be answered'))
  assert.ok(anon.text.includes('no address left'))
})

test('the subject is the kind plus the first sixty characters, on one line', () => {
  const long = 'A'.repeat(70)
  assert.equal(feedbackSubject({ kind: 'idea', message: long }), `[A-Identity feedback] idea: ${'A'.repeat(60)}...`)
  assert.equal(feedbackSubject({ kind: 'bug', message: 'line one\n\nline   two' }), '[A-Identity feedback] bug: line one line two')
})

test('without a key, sending is a labeled no-op: not configured, not delivered, nothing fetched', async () => {
  const resend = fakeFetch(200, { id: 'x' })
  const r = await sendFeedback({ kind: 'bug', message: GOOD.message }, META, {} as NodeJS.ProcessEnv, resend.fetch)
  assert.deepEqual(r, { delivered: false, configured: false, reason: NOT_CONFIGURED_REASON })
  assert.equal(resend.calls.length, 0)
  const h = await handleFeedback(GOOD, META, {} as NodeJS.ProcessEnv, resend.fetch)
  assert.equal(h.status, 503)
  assert.equal(h.body.delivered, false)
  assert.equal(h.body.configured, false)
})

test('with a key it posts to Resend with the configured to, from, reply_to and subject prefix', async () => {
  const resend = fakeFetch(200, { id: 'email_123' })
  const r = await sendFeedback(
    { kind: 'bug', message: GOOD.message, email: 'someone@example.com' },
    META,
    ENV,
    resend.fetch,
  )
  assert.deepEqual(r, { delivered: true, id: 'email_123' })
  assert.equal(resend.calls.length, 1)
  const [call] = resend.calls
  assert.equal(call.url, 'https://api.resend.com/emails')
  assert.equal(call.init.method, 'POST')
  assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer re_test')
  const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>
  assert.deepEqual(sent.to, ['team@example.com'])
  assert.equal(sent.from, 'A-Identity <hello@a-identity.xyz>')
  assert.equal(sent.reply_to, 'someone@example.com')
  assert.ok(String(sent.subject).startsWith('[A-Identity feedback] bug: '))
  assert.ok(typeof sent.html === 'string' && typeof sent.text === 'string')
})

test('the defaults are the team inbox and the Resend test sender, and no reply_to without an address', async () => {
  const resend = fakeFetch(200, {})
  const r = await sendFeedback({ kind: 'other', message: GOOD.message }, META, { RESEND_API_KEY: 'k' } as NodeJS.ProcessEnv, resend.fetch)
  assert.deepEqual(r, { delivered: true, id: null })
  const sent = JSON.parse(String(resend.calls[0].init.body)) as Record<string, unknown>
  assert.deepEqual(sent.to, ['hello@a-identity.xyz'])
  assert.equal(sent.from, 'A-Identity <onboarding@resend.dev>')
  assert.equal('reply_to' in sent, false)
})

test('a provider refusal surfaces its own message and is never reported as delivered', async () => {
  const resend = fakeFetch(422, { statusCode: 422, name: 'validation_error', message: 'The from address is not verified.' })
  const r = await sendFeedback({ kind: 'bug', message: GOOD.message }, META, ENV, resend.fetch)
  assert.deepEqual(r, { delivered: false, configured: true, reason: 'The from address is not verified.' })
  const h = await handleFeedback(GOOD, META, ENV, resend.fetch)
  assert.equal(h.status, 502)
  assert.deepEqual(h.body, { ok: false, delivered: false, configured: true, reason: 'The from address is not verified.' })
  // A network failure is the same honest shape, with the exception text as the reason.
  const down = (async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com') }) as unknown as typeof fetch
  const n = await sendFeedback({ kind: 'bug', message: GOOD.message }, META, ENV, down)
  assert.equal(n.delivered, false)
  assert.match((n as { reason: string }).reason, /ENOTFOUND/)
})

test('a valid request through the whole path answers 200 with delivered true and the provider id', async () => {
  const resend = fakeFetch(200, { id: 'email_456' })
  const h = await handleFeedback(GOOD, { ...META, caller: 'someone@example.com' }, ENV, resend.fetch)
  assert.equal(h.status, 200)
  assert.deepEqual(h.body, { ok: true, delivered: true, id: 'email_456' })
  assert.equal(h.kind, 'bug')
  const bad = await handleFeedback({ kind: 'bug', message: 'nope' }, META, ENV, resend.fetch)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
  assert.equal(resend.calls.length, 1, 'an invalid body never reaches the provider')
})

test('the visitor marker is stable, short, and never the address', () => {
  const a = visitorMarker('203.0.113.9')
  assert.ok(a && a.length === 8 && /^[0-9a-f]+$/.test(a))
  assert.equal(visitorMarker('203.0.113.9'), a)
  assert.notEqual(visitorMarker('203.0.113.10'), a)
  assert.ok(!a.includes('203'))
  assert.equal(visitorMarker(undefined), undefined)
  assert.equal(visitorMarker('unknown'), undefined)
})
