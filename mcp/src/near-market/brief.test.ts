import { test } from 'node:test'
import assert from 'node:assert/strict'
import { a2aText, clarifyingMessage, CLARIFY_PREFIX, disagreement, MESSAGE_MAX, parseAmount, parseBrief, SHOWN_MAX, unclearDeclineDetail, type BriefParse } from './brief.js'

/**
 * Brief parsing for the NEAR AI market worker: which one account a buyer asked about, or why the
 * brief names none we can check. The rule the tests hold: exactly one checkable account, or a
 * question, never a guess.
 */

const HEX = '98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de'

function one(text: string) {
  const p = parseBrief(text)
  assert.equal(p.kind, 'one', `expected one account in ${JSON.stringify(text)}, got ${JSON.stringify(p)}`)
  return (p as Extract<BriefParse, { kind: 'one' }>).target
}

function unclear(text: string) {
  const p = parseBrief(text)
  assert.equal(p.kind, 'unclear', `expected no single account in ${JSON.stringify(text)}, got ${JSON.stringify(p)}`)
  return p as Extract<BriefParse, { kind: 'unclear' }>
}

test('every documented form names its account and network: near:testnet:, near:mainnet:, .testnet, .near, and 64-hex with its network', () => {
  assert.deepEqual(one('Please check near:testnet:aid-demo-merchant.testnet before I pay.'), {
    network: 'testnet',
    account: 'aid-demo-merchant.testnet',
    kind: 'named',
    caip10: 'near:testnet:aid-demo-merchant.testnet',
  })
  assert.equal(one('near:mainnet:wrap.near').caip10, 'near:mainnet:wrap.near')
  assert.equal(one('Is bob.testnet safe to pay?').caip10, 'near:testnet:bob.testnet')
  assert.equal(one('Is (wrap.near) safe to pay?').caip10, 'near:mainnet:wrap.near')
  assert.equal(one(`check ${HEX} on mainnet`).caip10, `near:mainnet:${HEX}`)
  assert.equal(one(`check ${HEX} on NEAR testnet`).caip10, `near:testnet:${HEX}`)
  assert.equal(one(`near:testnet:${HEX}`).kind, 'near-implicit')
  // The prefix decides the network even for an id of the other network's shape, and takes any kind.
  assert.equal(one('near:mainnet:0x' + 'ab'.repeat(20)).kind, 'eth-implicit')
  // The same account twice, in two forms, is one account.
  assert.equal(one('bob.testnet, that is near:testnet:bob.testnet').caip10, 'near:testnet:bob.testnet')
})

test('punctuation, markdown and links around an id do not change it, and a host name is not an account', () => {
  assert.equal(one('**Payee:** `alice.near`.').account, 'alice.near')
  assert.equal(one('payee: alice.near, thanks!').account, 'alice.near')
  assert.equal(one('see https://nearblocks.io/address/alice.near for it').account, 'alice.near')
  assert.equal(one('Hired from https://market.near.ai/agents/a-identity-guard: check carol.testnet').account, 'carol.testnet')
  assert.equal(one('{"account_id":"dave.near"}').account, 'dave.near')
  assert.equal(one('Payee near:testnet:bob.testnet: please check it.').caip10, 'near:testnet:bob.testnet')
})

test('typographic punctuation next to an id ends it, as phones and models write it; a lookalike dash or dot inside an id is never split on', () => {
  // Smart quotes, an apostrophe, the em dash, the ellipsis, guillemets, CJK brackets, full-width
  // punctuation, and a trailing ideographic full stop or en dash: each is the account alice.near.
  for (const text of [
    '\u201Calice.near\u201D',
    '\u2018alice.near\u2019',
    'alice.near\u2019s payee',
    'pay alice.near\u2014it is the shop',
    'alice.near\u2026',
    'alice.near\uFF0C thanks',
    '\u00ABalice.near\u00BB',
    '\u300Calice.near\u300D',
    '\u300Ealice.near\u300F',
    '\uFF08alice.near\uFF09',
    'is alice.near\uFF1F',
    'pay alice.near\u3002',
    'pay alice.near\u2013 today',
    '\u2010alice.near',
  ]) {
    assert.equal(one(text).caip10, 'near:mainnet:alice.near', JSON.stringify(text))
  }
  assert.equal(one('\u201Cnear:testnet:bob.testnet\u201D').caip10, 'near:testnet:bob.testnet')
  assert.equal(one('Please check \u201Cmerchant.near\u201D \u2014 I\u2019m paying 5 NEAR').caip10, 'near:mainnet:merchant.near')
  assert.equal(parseBrief('Please check \u201Cmerchant.near\u201D \u2014 I\u2019m paying 5 NEAR').amount, '5 NEAR')
  assert.equal(one('It\u2019s \u201Cmerchant.near\u201D').account, 'merchant.near')
  assert.equal(one(`check \u201C${HEX}\u201D on \u201Ctestnet\u201D`).caip10, `near:testnet:${HEX}`)
  // Inside a name they stay part of it: the name is named back, never split into another account.
  for (const look of ['\u0430lice.near', 'ali\u200Bce.near', 'alice\u2010bob.near', 'alice\u2013bob.near', 'alice\u3002shop.near', 'near:testnet:bob\u2010x.testnet']) {
    const p = unclear(`check ${look}`)
    assert.equal(p.reason, 'invalid', look)
    assert.deepEqual(p.targets, [], look)
    assert.match(p.notes[0], /character outside a-z, 0-9 and \. - _, which is how lookalike names are made/, look)
    assert.ok(/^[\x20-\x7e]*$/.test(p.notes[0]), 'named back in ASCII')
  }
})

test('a 64-hex implicit account without its network, or with both named, is asked about, never guessed', () => {
  const p = unclear(`please check ${HEX}`)
  assert.equal(p.reason, 'invalid')
  assert.deepEqual(p.mentions, [HEX])
  assert.match(p.notes[0], /testnet and on mainnet alike/)
  assert.equal(unclear(`${HEX}: testnet or mainnet, not sure`).reason, 'invalid')
})

test('two accounts, or one plus an unusable mention, is ambiguous; nothing account-shaped is none', () => {
  const two = unclear('I will pay bob.near from alice.near')
  assert.equal(two.reason, 'many')
  assert.deepEqual(two.mentions, ['near:mainnet:bob.near', 'near:mainnet:alice.near'])
  assert.deepEqual(two.targets.map((t) => t.account), ['bob.near', 'alice.near'])
  assert.equal(unclear(`bob.near and ${HEX}`).reason, 'many')
  assert.equal(unclear('bob.near or near:betanet:bob').reason, 'many')
  const none = unclear('Hire A-Identity Guard for NEAR\nPlease check my payee before I send 5 NEAR.')
  assert.equal(none.reason, 'none')
  assert.deepEqual(none.mentions, [])
  assert.equal(none.amount, '5 NEAR')
})

test('near misses are named, not repaired: capitals, a lookalike character, a bad id, another network', () => {
  const caps = unclear('check Alice.near')
  assert.equal(caps.reason, 'invalid')
  assert.match(caps.notes[0], /lowercase \(alice\.near would be one\)/)
  // A Cyrillic a (U+0430) in place of the Latin one: how a lookalike is made. Shown escaped, ASCII only.
  const look = unclear('check \u0430lice.near')
  assert.match(look.notes[0], /\\u0430lice\.near: not a NEAR account id: it holds a character outside a-z, 0-9/)
  assert.ok(/^[\x20-\x7e]*$/.test(look.notes[0]))
  assert.match(unclear('check a..b.testnet').notes[0], /never a separator at either end or two in a row/)
  assert.match(unclear(`check ${'x'.repeat(70)}.near`).notes[0], /longer than 64 characters/)
  assert.match(unclear('near:betanet:bob.near').notes[0], /near:betanet is not a network this check reads/)
  assert.match(unclear('near:testnet:Bob.testnet').notes[0], /lowercase/)
})

test('an A2A opening message is read through its parts, text and data alike; prose passes through', () => {
  const body = JSON.stringify({ role: 'user', parts: [{ kind: 'text', text: 'Check this payee' }, { kind: 'data', data: { account_id: 'shop.near', amount: '12 USDC' } }] })
  assert.equal(a2aText(body), 'Check this payee\n{"account_id":"shop.near","amount":"12 USDC"}')
  assert.equal(one(a2aText(body)).caip10, 'near:mainnet:shop.near')
  assert.equal(parseBrief(a2aText(body)).amount, '12 USDC')
  assert.equal(a2aText('just check bob.testnet'), 'just check bob.testnet')
  assert.equal(a2aText('{not json'), '{not json')
})

test('the amount is read as stated and normalised, and is never taken from an account id', () => {
  assert.equal(parseAmount('pay 5 NEAR to bob.near'), '5 NEAR')
  assert.equal(parseAmount('about $12.50 today'), '12.50 USD')
  assert.equal(parseAmount('1,000.25 usdc'), '1000.25 USDC')
  assert.equal(parseAmount('ten dollars'), null)
  assert.equal(parseAmount('check 1234.near'), null)
  assert.equal(parseAmount('check 5near.testnet'), null)
  assert.equal(parseBrief('send 0.25 NEAR to bob.testnet').amount, '0.25 NEAR')
})

test('the clarifying message and the decline detail say what was wrong, list the forms, stay ASCII and fit the limits', () => {
  const many = unclear('pay bob.near from alice.near')
  const msg = clarifyingMessage(many)
  assert.ok(msg.startsWith(CLARIFY_PREFIX))
  assert.match(msg, /more than one account \(near:mainnet:bob\.near, near:mainnet:alice\.near\)/)
  assert.match(msg, /near:testnet:<account> or near:mainnet:<account>/)
  assert.match(msg, /A reply that names more than one, or one I cannot check as written, ends the job/)
  assert.match(msg, /refunded in full/)
  assert.equal(clarifyingMessage(many), msg, 'the same brief always asks the same question (its clientRequestId is fixed)')
  assert.ok(msg.length <= MESSAGE_MAX)
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(msg), 'plain ASCII')
  const reasons = [
    { when: 'reply', parse: many },
    { when: 'no_time', parse: many },
    { when: 'no_reply', replied: false },
    { when: 'no_reply', replied: true },
    { when: 'refused', code: 'validation_error' },
  ] as const
  for (const why of reasons) {
    const d = unclearDeclineDetail(why)
    assert.ok(d.length <= 1000, `${why.when}: ${d.length} characters`)
    assert.ok(/^[\x20-\x7e]*$/.test(d))
    assert.match(d, /^Declined before any check ran: nothing was checked and you are refunded in full\. To try again, hire with exactly one NEAR account/)
  }
  assert.match(unclearDeclineDetail({ when: 'reply', parse: many }), /Why: I asked once which account to check, and the reply names more than one account \(near:mainnet:bob\.near, near:mainnet:alice\.near\)\.$/)
  assert.match(unclearDeclineDetail({ when: 'reply', parse: unclear('Alice.near') }), /the reply names only Alice\.near: not a NEAR account id: NEAR ids are lowercase/)
  assert.match(unclearDeclineDetail({ when: 'no_reply', replied: false }), /no reply arrived before the deadline/)
  assert.match(unclearDeclineDetail({ when: 'no_time', parse: many }), /too little time was left before the deadline to ask/)
  assert.match(unclearDeclineDetail({ when: 'refused', code: 'validation_error' }), /the marketplace refused my question about which account to check \(validation_error\)/)
  // The brief and the buyer's message disagree: both named, each with where it came from.
  const split = disagreement(one('check alice.near'), one('I paid bob.near'), null)
  assert.match(clarifyingMessage(split), /more than one account \(near:mainnet:alice\.near, near:mainnet:bob\.near\)/)
  assert.match(clarifyingMessage(split), /- near:mainnet:alice\.near: named in the job brief\n- near:mainnet:bob\.near: named in your message/)

  // A huge brief full of accounts, or one huge account-shaped token, still yields bounded text:
  // every mention is cut, so the question fits the marketplace's 4000 characters and the refund
  // sentence is never what a cut drops.
  const flood = unclear(Array.from({ length: 300 }, (_, i) => `acct${i}.near`).join(' '))
  assert.ok(clarifyingMessage(flood).length <= MESSAGE_MAX)
  assert.ok(unclearDeclineDetail({ when: 'reply', parse: flood }).length <= 1000)
  for (const text of [`${'a'.repeat(3000)}.near`, `${'\u0430'.repeat(700)}.near`, `near:testnet:${'x'.repeat(5000)}`, `near:${'q'.repeat(5000)}:bob.near`, `${'b'.repeat(2000)}.near ${'b'.repeat(2000)}c.near`]) {
    const p = unclear(text)
    for (const m of p.mentions) assert.ok(m.length <= SHOWN_MAX, `a mention of ${m.length} characters`)
    for (const n of p.notes) assert.ok(n.length <= SHOWN_MAX + 200, `a note of ${n.length} characters`)
    const m = clarifyingMessage(p)
    assert.ok(m.length <= MESSAGE_MAX, `${m.length} characters`)
    assert.ok(/^[\x0a\x20-\x7e]*$/.test(m))
    assert.match(m, /refunded in full/)
    for (const why of [{ when: 'reply', parse: p }, { when: 'no_time', parse: p }] as const) {
      const d = unclearDeclineDetail(why)
      assert.ok(d.length <= 1000)
      assert.match(d, /refunded in full/)
    }
  }
  // Two long ids that share a beginning are still two mentions.
  assert.equal(unclear(`${'b'.repeat(2000)}.near ${'b'.repeat(2000)}c.near`).reason, 'many')
  // A cut never leaves half of a \u escape behind.
  assert.ok(!/\\u[0-9a-f]{0,3}\.\.\.$/.test(unclear(`${'\u0430'.repeat(700)}.near`).mentions[0]))
})
