import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { CalendarDays, CheckCircle2, Loader2, Mail } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import FeedbackOwl, { type OwlMood } from '../components/FeedbackOwl'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { CAL_URL, CONTACT, EASE_OUT_EXPO, SOCIALS } from '../lib/brand'
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
 * /feedback: feedback, general inquiries and requests, with the owl and every address that
 * reaches the team. The closing slide of the deck (Demo Day has no live Q&A) sends people here
 * through a QR code, which is why the choices differ from the corner widget's.
 *
 * It posts to the same /api/feedback as the widget (src/lib/feedback.ts), so the same honest
 * outcomes apply: "It reached our inbox" only when the server said `delivered: true` after
 * the email provider accepted the message; when the server cannot send, the reason and a
 * prefilled mailto, so nothing typed is lost. The widget stays mounted on this page too.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'sending' }
  | { name: 'sent' }
  | { name: 'fallback'; reason: string }
  | { name: 'error'; reason: string }

const EMPTY: FeedbackDraft = { kind: 'feedback', message: '', email: '', website: '' }

const fieldClass =
  'flex w-full rounded-xl border border-foreground/15 bg-card px-3.5 py-2.5 text-sm text-foreground shadow-sm transition-colors placeholder:text-foreground/40 focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

const INBOXES = [
  { title: 'General', address: CONTACT.hello, body: 'Partnerships, press, and anything else.' },
  { title: 'Developers and agents', address: CONTACT.agents, body: 'Integration, SDK and MCP questions.' },
]

/** The same three people, with the same titles, that the deck names. */
const TEAM = [
  { name: 'Aybars Dorman', role: 'CEO', address: 'aybars@a-identity.xyz' },
  { name: 'Meriç Cintosun', role: 'CTO', address: 'meric@a-identity.xyz' },
  { name: 'Müge Ayşe Polat', role: 'Head of Brand and Strategy', address: 'muge@a-identity.xyz' },
]

const SOCIAL_LINKS = [
  { label: 'X', href: SOCIALS.x },
  { label: 'LinkedIn', href: SOCIALS.linkedin },
  { label: 'Discord', href: SOCIALS.discord },
  { label: 'GitHub', href: SOCIALS.github },
  { label: 'YouTube', href: SOCIALS.youtube },
].filter((s) => s.href)

const reveal = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

export default function Feedback() {
  usePageMeta({
    title: 'Feedback and inquiries · A-Identity',
    description:
      'Send the A-Identity team feedback, a general inquiry or a request. It is emailed to the team inbox, and every address that reaches us is on this page.',
    canonical: 'https://a-identity.xyz/feedback',
  })

  const uid = useId()
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [focused, setFocused] = useState(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const notSentRef = useRef<HTMLParagraphElement>(null)

  // React applies autoFocus only to form controls, not to the mailto link, so the fallback's
  // outcome line takes focus: a screen reader reads why, and the next Tab reaches the link.
  useEffect(() => {
    if (phase.name === 'fallback') notSentRef.current?.focus()
  }, [phase.name])

  const messageLength = draft.message.trim().length
  const canSend = messageLength >= FEEDBACK_MESSAGE_MIN && messageLength <= FEEDBACK_MESSAGE_MAX

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
    if (!canSend || phase.name === 'sending') return
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
    setDraft(draftToKeep)
    setPhase({ name: 'idle' })
    window.setTimeout(() => messageRef.current?.focus(), 0)
  }

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[1040px] px-5 py-14 sm:px-8 sm:py-20">
        <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14">
          <motion.div {...reveal} className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <span className="text-sm font-semibold tracking-wide text-accent">Feedback and inquiries</span>
            <h1
              className="mt-3 text-4xl font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Tell us what you think.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-foreground/65 sm:text-lg">
              Feedback, a general inquiry, or a request. Your note is emailed to the team, and we read every one.
            </p>
            <FeedbackOwl mood={mood} className="mt-6 self-center" />
          </motion.div>

          <motion.div {...reveal} className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8">
            {phase.name === 'sent' ? (
              <div className="flex flex-col items-start gap-4 py-6" role="status">
                <div className="flex items-center gap-2 text-base font-semibold text-ok">
                  <CheckCircle2 size={20} aria-hidden="true" />
                  Thanks. It reached our inbox.
                </div>
                <p className="text-sm text-foreground/60">
                  {draft.email.trim()
                    ? 'We will reply to the address you left.'
                    : 'You did not leave an address, so we cannot reply, but we read every note.'}
                </p>
                <Button type="button" variant="inverse" onClick={() => backToForm(EMPTY)} autoFocus>
                  Send another
                </Button>
              </div>
            ) : phase.name === 'fallback' ? (
              <div className="flex flex-col items-start gap-4 py-2" role="status">
                <p ref={notSentRef} tabIndex={-1} className="text-sm font-semibold text-warn outline-none">
                  Not sent. {phase.reason}
                </p>
                <p className="text-sm text-foreground/60">
                  Your message is kept below. Send it by email instead, and it opens in your mail app with the text filled in.
                </p>
                <div className="w-full whitespace-pre-wrap rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground/80">
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
                <fieldset disabled={phase.name === 'sending'} className="flex min-w-0 flex-col gap-5">
                  <fieldset className="min-w-0">
                    <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
                      What kind of note is this?
                    </legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {INQUIRY_KINDS.map((k) => (
                        <label
                          key={k.id}
                          className="flex cursor-pointer items-center justify-center rounded-full border border-border px-2 py-2.5 text-sm font-semibold text-foreground/70 transition-colors hover:text-foreground has-[:checked]:border-foreground has-[:checked]:bg-foreground has-[:checked]:text-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card"
                        >
                          <input
                            type="radio"
                            name={`${uid}-kind`}
                            value={k.id}
                            checked={draft.kind === k.id}
                            onChange={() => edit({ kind: k.id as FeedbackKind })}
                            className="sr-only"
                          />
                          {k.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <label htmlFor={`${uid}-message`} className="text-sm font-semibold">
                        What would you like to tell us?
                      </label>
                      <span
                        className={cn(
                          'font-mono text-[11px] tabular-nums',
                          draft.message.length > FEEDBACK_MESSAGE_MAX ? 'text-danger' : 'text-foreground/50',
                        )}
                      >
                        {draft.message.length}/{FEEDBACK_MESSAGE_MAX}
                      </span>
                    </div>
                    <textarea
                      ref={messageRef}
                      id={`${uid}-message`}
                      required
                      minLength={FEEDBACK_MESSAGE_MIN}
                      maxLength={FEEDBACK_MESSAGE_MAX}
                      rows={6}
                      value={draft.message}
                      onChange={(e) => edit({ message: e.target.value })}
                      placeholder="Your feedback, your question, or what you need from us."
                      className={cn(fieldClass, 'min-h-[9rem] resize-y')}
                    />
                    {messageLength > 0 && messageLength < FEEDBACK_MESSAGE_MIN && (
                      <p className="mt-1 text-xs text-foreground/50">At least {FEEDBACK_MESSAGE_MIN} characters.</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor={`${uid}-email`} className="mb-1.5 block text-sm font-semibold">
                      Email, so we can reply <span className="font-normal text-foreground/50">(optional)</span>
                    </label>
                    <Input
                      id={`${uid}-email`}
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      maxLength={254}
                      value={draft.email}
                      onChange={(e) => edit({ email: e.target.value })}
                      placeholder="you@example.com"
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
                    <p className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger" role="alert">
                      {phase.reason}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <p className="max-w-xs text-xs text-foreground/50">
                      Along with your note we send the page, your browser's user agent, your account if you are signed in, and a salted connection marker, never your IP address.
                    </p>
                    <Button
                      type="submit"
                      disabled={!canSend || phase.name === 'sending'}
                      aria-busy={phase.name === 'sending'}
                    >
                      {phase.name === 'sending' ? (
                        <>
                          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                          Sending
                        </>
                      ) : (
                        'Send'
                      )}
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
          </motion.div>
        </div>

        <section className="mt-16 sm:mt-20" aria-labelledby={`${uid}-reach`}>
          <h2
            id={`${uid}-reach`}
            className="text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Other ways to reach us
          </h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {INBOXES.map((box) => (
              <div key={box.address} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center gap-2">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent/10 text-accent">
                    <Mail size={16} aria-hidden="true" />
                  </div>
                  <h3 className="font-semibold text-foreground">{box.title}</h3>
                </div>
                <p className="mt-2 text-sm text-foreground/60">{box.body}</p>
                <a href={`mailto:${box.address}`} className="mt-3 inline-block break-all text-sm font-semibold text-accent hover:underline">
                  {box.address}
                </a>
              </div>
            ))}
            <div className="rounded-2xl border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent/10 text-accent">
                  <CalendarDays size={16} aria-hidden="true" />
                </div>
                <h3 className="font-semibold text-foreground">Book a call</h3>
              </div>
              <p className="mt-2 text-sm text-foreground/60">Fifteen minutes with the founders, at a time that suits you.</p>
              <a
                href={CAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-sm font-semibold text-accent hover:underline"
              >
                Pick a time
              </a>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-semibold text-foreground">The team</h3>
              <ul className="mt-3 divide-y divide-border">
                {TEAM.map((p) => (
                  <li key={p.address} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <span className="text-sm text-foreground">
                      <span className="font-semibold">{p.name}</span>
                      <span className="text-foreground/55">, {p.role}</span>
                    </span>
                    <a href={`mailto:${p.address}`} className="break-all text-sm font-semibold text-accent hover:underline">
                      {p.address}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-semibold text-foreground">Follow along</h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {SOCIAL_LINKS.map((s) => (
                  <li key={s.label}>
                    <a
                      href={s.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex rounded-full border border-border px-3.5 py-1.5 text-sm font-semibold text-foreground/75 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
