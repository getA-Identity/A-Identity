import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Loader2, Mail, MessageSquare, X } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useTheme } from './ThemeProvider'
import { cn } from '../lib/utils'
import { CONTACT } from '../lib/brand'
import {
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  feedbackMailto,
  hasCornerFab,
  submitFeedback,
  type FeedbackDraft,
  type FeedbackKind,
} from '../lib/feedback'

/**
 * The feedback button in the bottom-right corner of every page, and the dialog it opens.
 *
 * Mounted once in App, inside the router (it reads the location to place itself) and
 * outside the routes, so the console gets it too. The dark theme is a scoped class, not a
 * class on <html>, so this applies the scope to its own root from the same preference the
 * pages read; otherwise a dialog over the dark console would render permanently light.
 *
 * Status is honest end to end: "It reached our inbox" appears only when the server said
 * `delivered: true`, which it only says after the email provider accepted the message.
 * When the server cannot send (no key, the provider refused, or it ignored the request),
 * the dialog shows the reason and a mailto link with the message prefilled, so nothing typed is lost.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'sending' }
  | { name: 'sent' }
  | { name: 'fallback'; reason: string }
  | { name: 'error'; reason: string }

const EMPTY: FeedbackDraft = { kind: 'idea', message: '', email: '', website: '' }

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const fieldClass =
  'flex w-full rounded-xl border border-foreground/15 bg-card px-3.5 py-2.5 text-sm text-foreground shadow-sm transition-colors placeholder:text-foreground/40 focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

export default function FeedbackWidget() {
  const { pathname } = useLocation()
  const { theme } = useTheme()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const uid = useId()

  const close = useCallback(() => {
    setOpen(false)
    // A delivered note is done and the draft is cleared. A fallback or an error goes back
    // to the form with the draft kept, so nothing typed is lost between opens. A send in
    // flight is left alone: it finishes and the next open shows what happened.
    if (phase.name === 'sent') {
      setDraft(EMPTY)
      setPhase({ name: 'idle' })
    } else if (phase.name === 'fallback' || phase.name === 'error') {
      setPhase({ name: 'idle' })
    }
  }, [phase.name])

  // Body scroll lock, Escape, and focus restored to the button that opened the dialog.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 30)
    const opener = triggerRef.current
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
      opener?.focus()
    }
  }, [open, close])

  // A small trap: Tab and Shift+Tab cycle inside the panel while it is open.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    )
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const messageLength = draft.message.trim().length
  const canSend = messageLength >= FEEDBACK_MESSAGE_MIN && messageLength <= FEEDBACK_MESSAGE_MAX

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSend || phase.name === 'sending') return
    setPhase({ name: 'sending' })
    const outcome = await submitFeedback(draft)
    if (outcome.kind === 'sent') setPhase({ name: 'sent' })
    else if (outcome.kind === 'fallback') setPhase({ name: 'fallback', reason: outcome.reason })
    else setPhase({ name: 'error', reason: outcome.reason })
  }

  const lifted = hasCornerFab(pathname)
  const dark = theme === 'dark' ? 'dark' : ''
  const titleId = `${uid}-title`
  const noteId = `${uid}-note`

  return (
    <>
      {/* The trigger. The corner already holds a stack on the landing (the "Verify an agent"
          FAB at the base, back-to-top above it); there this sits one slot up, and the
          back-to-top button moves up with it, so nothing overlaps on any page. It sits at
          z-30, under the z-40 scrims of the mobile menu, the console drawer and the
          spotlight dialog, so an open overlay covers it; the dialog below is z-[70] so it
          covers them in turn. Hidden in print, because /deck?print=1 is the PDF source. */}
      <div className={cn(dark, 'print:hidden')}>
        <Button
          ref={triggerRef}
          type="button"
          variant="inverse"
          aria-label="Send feedback"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="fixed right-6 z-30 h-11 gap-2 px-[13px] shadow-lg sm:px-4"
          style={{ bottom: `calc(${lifted ? '5.5rem' : '1.5rem'} + env(safe-area-inset-bottom, 0px))` }}
        >
          <MessageSquare size={18} className="shrink-0" aria-hidden="true" />
          <span className="hidden text-sm sm:inline">Feedback</span>
        </Button>
      </div>

      <AnimatePresence>
        {open && (
          <div className={cn(dark, 'fixed inset-0 z-[70] flex items-center justify-center p-4 text-foreground')}>
            <motion.div
              className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={close}
              aria-hidden="true"
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={phase.name === 'sent' || phase.name === 'fallback' ? undefined : noteId}
              onKeyDown={onPanelKeyDown}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="relative max-h-[calc(100dvh-2rem)] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl sm:p-6"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id={titleId} className="font-heading text-lg font-bold tracking-tight">
                    Tell us what you think
                  </h2>
                  <p className="mt-1 text-sm text-foreground/60">A bug, an idea, a question. It goes to the team inbox.</p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              {phase.name === 'sent' ? (
                <div className="mt-6 flex flex-col items-start gap-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ok">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    Thanks. It reached our inbox.
                  </div>
                  <p className="text-sm text-foreground/60">
                    {draft.email.trim() ? 'We will reply to the address you left.' : 'You did not leave an address, so we cannot reply, but we read every note.'}
                  </p>
                  <Button type="button" variant="inverse" onClick={close} autoFocus>
                    Close
                  </Button>
                </div>
              ) : phase.name === 'fallback' ? (
                <div className="mt-6 flex flex-col items-start gap-4">
                  <p className="text-sm font-semibold text-warn">Not sent. {phase.reason}</p>
                  <p className="text-sm text-foreground/60">
                    Your message is kept below. Send it by email instead, and it opens in your mail app with the text filled in.
                  </p>
                  <div className="w-full whitespace-pre-wrap rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground/80">{draft.message.trim()}</div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild autoFocus>
                      <a href={feedbackMailto(draft)}>
                        <Mail size={16} aria-hidden="true" />
                        Email {CONTACT.hello}
                      </a>
                    </Button>
                    <Button type="button" variant="outline" onClick={close}>
                      Close
                    </Button>
                  </div>
                </div>
              ) : (
                <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
                  <fieldset className="min-w-0">
                    <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">What kind of note is this?</legend>
                    <div className="grid grid-cols-4 gap-1.5" role="radiogroup">
                      {FEEDBACK_KINDS.map((k) => (
                        <label
                          key={k.id}
                          className="flex cursor-pointer items-center justify-center rounded-full border border-border px-1 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:text-foreground has-[:checked]:border-foreground has-[:checked]:bg-foreground has-[:checked]:text-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card"
                        >
                          <input
                            ref={k.id === draft.kind ? firstFieldRef : undefined}
                            type="radio"
                            name={`${uid}-kind`}
                            value={k.id}
                            checked={draft.kind === k.id}
                            onChange={() => setDraft((d) => ({ ...d, kind: k.id as FeedbackKind }))}
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
                        What happened, or what would help?
                      </label>
                      <span
                        className={cn('font-mono text-[11px] tabular-nums', draft.message.length > FEEDBACK_MESSAGE_MAX ? 'text-danger' : 'text-foreground/50')}
                        aria-live="polite"
                      >
                        {draft.message.length}/{FEEDBACK_MESSAGE_MAX}
                      </span>
                    </div>
                    <textarea
                      id={`${uid}-message`}
                      required
                      minLength={FEEDBACK_MESSAGE_MIN}
                      maxLength={FEEDBACK_MESSAGE_MAX}
                      rows={5}
                      value={draft.message}
                      onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
                      placeholder="The more specific, the faster we can act on it."
                      className={cn(fieldClass, 'min-h-[7rem] resize-y')}
                    />
                    {messageLength > 0 && messageLength < FEEDBACK_MESSAGE_MIN && (
                      <p className="mt-1 text-xs text-foreground/50">At least {FEEDBACK_MESSAGE_MIN} characters.</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor={`${uid}-email`} className="mb-1.5 block text-sm font-semibold">
                      Email, if you want a reply <span className="font-normal text-foreground/50">(optional)</span>
                    </label>
                    <Input
                      id={`${uid}-email`}
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      maxLength={254}
                      value={draft.email}
                      onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                      placeholder="you@example.com"
                    />
                  </div>

                  {/* The honeypot. Hidden from people and from the tab order; a form filler
                      that writes into every field trips it and the server quietly drops the
                      request. */}
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

                  <p id={noteId} className="text-xs text-foreground/50">
                    We include the page you are on and your browser name, nothing else.
                  </p>

                  {phase.name === 'error' && (
                    <p className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger" role="alert">
                      {phase.reason}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <Button type="button" variant="outline" onClick={close} disabled={phase.name === 'sending'}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={!canSend || phase.name === 'sending'} aria-busy={phase.name === 'sending'}>
                      {phase.name === 'sending' ? (
                        <>
                          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                          Sending
                        </>
                      ) : phase.name === 'error' ? (
                        'Retry'
                      ) : (
                        'Send'
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
