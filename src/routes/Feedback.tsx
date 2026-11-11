import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { Check, Loader2, Mail, Send } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import FeedbackOwl, { type OwlMood } from '../components/FeedbackOwl'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { CAL_URL, CONTACT, EASE_OUT_EXPO } from '../lib/brand'
import { usePageMeta } from '../lib/head'
import { cn } from '../lib/utils'
import {
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  feedbackMailto,
  INQUIRY_KINDS,
  submitFeedback,
  type FeedbackDraft,
  type FeedbackKind,
} from '../lib/feedback'

/**
 * /feedback: feedback, general inquiries and requests. The closing slide of the deck (Demo Day
 * has no live Q&A) sends people here through a QR code, so most arrive on a phone, once.
 *
 * Two halves and nothing else: the owl in the deck's night sky on one side, one short form on
 * the other, and the direct addresses in a single row underneath.
 *
 * It posts to the same /api/feedback as the corner widget (src/lib/feedback.ts), so the same
 * honest outcomes apply: "Message sent" only when the server said `delivered: true` after the
 * email provider accepted the message; when the server cannot send, the reason and a
 * prefilled mailto, so nothing typed is lost.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'sending' }
  | { name: 'sent' }
  | { name: 'fallback'; reason: string }
  | { name: 'error'; reason: string }

const EMPTY: FeedbackDraft = { kind: 'feedback', message: '', email: '', website: '' }

const fieldClass =
  'flex w-full rounded-xl border border-foreground/15 bg-card px-4 py-3 text-[15px] text-foreground shadow-sm transition-colors placeholder:text-foreground/65 focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

/** The direct addresses: the two inboxes, the booking link, and the three people the deck names. */
const DIRECT = [
  { label: 'General', value: CONTACT.hello, href: `mailto:${CONTACT.hello}` },
  { label: 'Developers and agents', value: CONTACT.agents, href: `mailto:${CONTACT.agents}` },
  { label: 'A call with the founders', value: 'Book 15 minutes', href: CAL_URL, external: true },
  { label: 'Aybars Dorman, CEO', value: 'aybars@a-identity.xyz', href: 'mailto:aybars@a-identity.xyz' },
  { label: 'Meriç Cintosun, CTO', value: 'meric@a-identity.xyz', href: 'mailto:meric@a-identity.xyz' },
  { label: 'Müge Ayşe Polat, Head of Brand and Strategy', value: 'muge@a-identity.xyz', href: 'mailto:muge@a-identity.xyz' },
]

const rise = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

export default function Feedback() {
  usePageMeta({
    title: 'Feedback and inquiries · A-Identity',
    description:
      'Send the A-Identity team feedback, a general inquiry or a request. It is emailed to the team inbox, and every direct address is on this page.',
    canonical: 'https://a-identity.xyz/feedback',
  })

  const uid = useId()
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [focused, setFocused] = useState(false)
  // Set when Send was pressed on a note that is too short, so the length line turns into an error.
  const [tried, setTried] = useState(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const notSentRef = useRef<HTMLParagraphElement>(null)

  // React applies autoFocus only to form controls, not to the mailto link, so the fallback's
  // outcome line takes focus: a screen reader reads why, and the next Tab reaches the link.
  useEffect(() => {
    if (phase.name === 'fallback') notSentRef.current?.focus()
  }, [phase.name])

  const messageLength = draft.message.trim().length
  const canSend = messageLength >= FEEDBACK_MESSAGE_MIN && messageLength <= FEEDBACK_MESSAGE_MAX
  const sending = phase.name === 'sending'
  const tooShort = messageLength < FEEDBACK_MESSAGE_MIN
  const showLength = tooShort && (tried || messageLength > 0)

  const mood: OwlMood =
    phase.name === 'sending' || phase.name === 'sent' || phase.name === 'fallback' || phase.name === 'error'
      ? phase.name
      : focused || messageLength > 0
        ? 'typing'
        : 'idle'

  // Editing after an error clears it: the person is already fixing whatever it was.
  const edit = (patch: Partial<FeedbackDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setPhase((p) => (p.name === 'error' ? { name: 'idle' } : p))
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    // The button is never greyed out: a greyed button with a small hint under the field read as
    // "Send does nothing". A note that is too short gets the reason in red and the cursor instead.
    if (!canSend) {
      setTried(true)
      messageRef.current?.focus()
      return
    }
    setTried(false)
    setPhase({ name: 'sending' })
    const outcome = await submitFeedback(draft)
    if (outcome.kind === 'sent') setPhase({ name: 'sent' })
    else if (outcome.kind === 'fallback') setPhase({ name: 'fallback', reason: outcome.reason })
    else setPhase({ name: 'error', reason: outcome.reason })
  }

  const onFormBlur = (e: FocusEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
  }

  // The form remounts on the way back, so focus goes to the message once it is there again,
  // instead of falling to the top of the page.
  const backToForm = (draftToKeep: FeedbackDraft) => {
    setTried(false)
    setDraft(draftToKeep)
    setPhase({ name: 'idle' })
    window.setTimeout(() => messageRef.current?.focus(), 0)
  }

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-4 sm:px-6 sm:pt-6 lg:px-8 lg:pb-24">
        <div className="grid gap-8 lg:min-h-[640px] lg:grid-cols-[1.05fr_1fr] lg:gap-12">
          <motion.div {...rise} className="h-[340px] sm:h-[420px] lg:h-auto">
            <FeedbackOwl mood={mood} className="h-full" />
          </motion.div>

          <motion.section {...rise} transition={{ ...rise.transition, delay: 0.08 }} className="flex flex-col lg:py-8">
            <p className="text-sm font-semibold tracking-wide text-accent">Get in touch</p>
            <h1
              className="mt-3 text-5xl font-bold leading-[1.02] tracking-[-0.03em] text-foreground sm:text-6xl"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Let's talk.
            </h1>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-foreground/70">
              Feedback, a question or a request. It goes straight to the team.
            </p>

            <div className="mt-8">
              {phase.name === 'sent' ? (
                <div className="flex flex-col items-start gap-5 rounded-3xl border border-border bg-card p-7 shadow-sm" role="status">
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-ok/10 text-ok">
                    <Check size={24} aria-hidden="true" />
                  </div>
                  <div id={`${uid}-sent`}>
                    <p className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                      Message sent.
                    </p>
                    <p className="mt-2 text-foreground/70 wrap-anywhere">
                      {draft.email.trim()
                        ? `We will reply to ${draft.email.trim()}.`
                        : 'You left no address, so we cannot reply, but we read every note.'}
                    </p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => backToForm(EMPTY)} aria-describedby={`${uid}-sent`} autoFocus>
                    Send another
                  </Button>
                </div>
              ) : phase.name === 'fallback' ? (
                <div className="flex flex-col items-start gap-4 rounded-3xl border border-border bg-card p-7 shadow-sm" role="status">
                  <p ref={notSentRef} tabIndex={-1} className="font-semibold text-term-warn outline-none">
                    Not sent. {phase.reason}
                  </p>
                  <p className="text-sm text-foreground/70">
                    Your message is kept below. Email it instead, and it opens in your mail app with the text filled in.
                  </p>
                  <div className="w-full whitespace-pre-wrap wrap-anywhere rounded-xl bg-background px-4 py-3 text-sm text-foreground/80">
                    {draft.message.trim()}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild>
                      <a href={feedbackMailto(draft)}>
                        <Mail size={16} aria-hidden="true" />
                        Email {CONTACT.hello}
                      </a>
                    </Button>
                    <Button type="button" variant="outline" onClick={() => backToForm(draft)}>
                      Back to the form
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={onSubmit} onFocus={() => setFocused(true)} onBlur={onFormBlur} noValidate>
                  {/* Everything is read-only while a send is in flight, so what was sent is what is shown. */}
                  <fieldset disabled={sending} className="flex min-w-0 flex-col gap-4">
                    <fieldset className="min-w-0">
                      <legend className="sr-only">Topic</legend>
                      <div className="grid grid-cols-3 gap-1 rounded-full border border-border bg-card p-1 shadow-sm">
                        {INQUIRY_KINDS.map((k) => {
                          const active = draft.kind === k.id
                          return (
                            <label
                              key={k.id}
                              className="relative flex cursor-pointer items-center justify-center rounded-full px-2 py-2.5 text-sm font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                            >
                              {active && (
                                <motion.span
                                  layoutId={`${uid}-topic`}
                                  className="absolute inset-0 rounded-full bg-foreground"
                                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                                />
                              )}
                              <input
                                type="radio"
                                name={`${uid}-kind`}
                                value={k.id}
                                checked={active}
                                onChange={() => edit({ kind: k.id as FeedbackKind })}
                                className="sr-only"
                              />
                              <span className={cn('relative transition-colors', active ? 'text-background' : 'text-foreground/70 hover:text-foreground')}>
                                {k.short}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </fieldset>

                    <div>
                      <label htmlFor={`${uid}-message`} className="sr-only">
                        How can we help?
                      </label>
                      <textarea
                        ref={messageRef}
                        id={`${uid}-message`}
                        required
                        minLength={FEEDBACK_MESSAGE_MIN}
                        maxLength={FEEDBACK_MESSAGE_MAX}
                        rows={5}
                        value={draft.message}
                        onChange={(e) => edit({ message: e.target.value })}
                        placeholder="How can we help?"
                        aria-invalid={tried && tooShort ? true : undefined}
                        aria-describedby={showLength ? `${uid}-length` : undefined}
                        className={cn(fieldClass, 'min-h-[8.5rem] resize-y', tried && tooShort && 'border-term-bad/60')}
                      />
                      {showLength && (
                        <p
                          id={`${uid}-length`}
                          role={tried ? 'alert' : undefined}
                          className={cn('mt-1.5 text-sm', tried ? 'font-semibold text-term-bad' : 'text-foreground/70')}
                        >
                          At least {FEEDBACK_MESSAGE_MIN} characters, {FEEDBACK_MESSAGE_MIN - messageLength} to go.
                        </p>
                      )}
                    </div>

                    <div>
                      <label htmlFor={`${uid}-email`} className="sr-only">
                        Your email, so we can reply (optional)
                      </label>
                      <Input
                        id={`${uid}-email`}
                        type="email"
                        autoComplete="email"
                        inputMode="email"
                        maxLength={254}
                        value={draft.email}
                        onChange={(e) => edit({ email: e.target.value })}
                        placeholder="Your email, so we can reply (optional)"
                        className="h-12 px-4 text-[15px] placeholder:text-foreground/65"
                      />
                    </div>

                    {/* The honeypot, as in the widget: hidden from people and from the tab order,
                        so only a form filler writes into it, and the server quietly drops that. */}
                    <div className="hidden" aria-hidden="true">
                      <label htmlFor={`${uid}-website`}>Website</label>
                      <input
                        id={`${uid}-website`}
                        name="website"
                        type="text"
                        tabIndex={-1}
                        autoComplete="off"
                        value={draft.website}
                        onChange={(e) => setDraft((d) => ({ ...d, website: e.target.value }))}
                      />
                    </div>

                    {phase.name === 'error' && (
                      <p className="rounded-xl border border-danger/30 bg-card px-4 py-3 text-sm text-danger" role="alert">
                        {phase.reason}
                      </p>
                    )}

                    <Button type="submit" className="h-12 w-full text-[15px]" disabled={sending} aria-busy={sending}>
                      {sending ? (
                        <>
                          <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                          Sending
                        </>
                      ) : (
                        <>
                          Send message
                          <Send size={16} aria-hidden="true" />
                        </>
                      )}
                    </Button>

                    <p className="text-xs leading-relaxed text-foreground/70">
                      We attach the page, your browser details, your account if you are signed in, and a hashed
                      connection marker. Never your IP address.
                    </p>
                  </fieldset>
                </form>
              )}
            </div>
          </motion.section>
        </div>

        <section aria-labelledby={`${uid}-direct`} className="mt-16 border-t border-border pt-10 lg:mt-20">
          <h2 id={`${uid}-direct`} className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/70">
            Reach us directly
          </h2>
          <dl className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {DIRECT.map((d) => (
              <div key={d.href}>
                <dt className="text-sm text-foreground/70">{d.label}</dt>
                <dd className="mt-1">
                  <a
                    href={d.href}
                    {...(d.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    className="break-all text-[15px] font-semibold text-foreground transition-colors hover:text-accent"
                  >
                    {d.value}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
