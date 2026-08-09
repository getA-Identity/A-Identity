/**
 * Rating & Feedback tab pane of the agent profile: the 1-10 rating form
 * (verified sessions only; guests see why they can't) and the feedback list.
 * Extracted verbatim from AgentProfile.tsx; all form state stays lifted in the
 * parent so a draft rating survives tab switches exactly as before. Must keep
 * the exact div root element (rendered inside the cn-pane div).
 */
import type { Dispatch, SetStateAction } from 'react'
import { Loader2, Star } from 'lucide-react'
import type { FeedbackData } from './types'

type Props = {
  verified: boolean
  myScore: number | null
  myComment: string
  rating: boolean
  rateNote: string | null
  setMyScore: Dispatch<SetStateAction<number | null>>
  setMyComment: Dispatch<SetStateAction<string>>
  submitRating: () => void
  feedback: FeedbackData | null
  fbAvg: number | null
  fbCount: number
}

export default function FeedbackPane({
  verified,
  myScore,
  myComment,
  rating,
  rateNote,
  setMyScore,
  setMyComment,
  submitRating,
  feedback,
  fbAvg,
  fbCount,
}: Props) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* Rate 1-10. One rating per account; rating again replaces it. */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-bold text-foreground/80">Rate this agent</h3>
        {verified ? (
          <>
            <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Score from 1 to 10">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={myScore === n}
                  onClick={() => setMyScore(n)}
                  className={`h-9 w-9 rounded-lg text-sm font-bold tabular-nums transition-colors duration-[120ms] ${
                    myScore != null && n <= myScore
                      ? 'bg-accent text-white'
                      : 'border border-border text-foreground/55 hover:border-accent/40 hover:text-accent'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <textarea
              value={myComment}
              onChange={(e) => setMyComment(e.target.value)}
              rows={2}
              placeholder="Optional: what was it like to work with this agent?"
              className="mt-3 w-full resize-none rounded-xl border border-border bg-background/40 px-3 py-2 text-sm outline-none transition-colors duration-[120ms] focus:border-accent"
            />
            <button
              type="button"
              onClick={submitRating}
              disabled={rating || myScore == null}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep disabled:opacity-50"
            >
              {rating && <Loader2 size={14} className="animate-spin" />}
              Submit rating
            </button>
          </>
        ) : (
          <p className="mt-2 text-sm text-foreground/65">
            Sign in with your wallet or an email link to rate. Guest sessions are read-only.
          </p>
        )}
        {rateNote && <p className="mt-2 text-xs font-medium text-foreground/65">{rateNote}</p>}
      </section>

      <section className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-bold text-foreground/80">User Feedback</h3>
          {fbAvg != null && (
            <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums text-foreground">
              <Star size={13} className="text-warn" fill="currentColor" /> {fbAvg.toFixed(1)}/10
              <span className="text-xs font-medium text-foreground/50">({fbCount})</span>
            </span>
          )}
        </div>
        {feedback == null ? (
          <p className="px-5 py-8 text-center text-sm text-foreground/60">Could not load feedback right now.</p>
        ) : feedback.entries.length > 0 ? (
          <ul className="divide-y divide-border">
            {feedback.entries.map((f) => (
              <li key={f.id} className="px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">
                    {f.score}/10
                  </span>
                  <span className="text-xs font-semibold text-foreground/70">{f.rater.split('@')[0]}</span>
                  <span className="text-[11px] font-medium text-accent/80">
                    {new Date(f.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                {f.comment && <p className="mt-1.5 text-sm leading-relaxed text-foreground/70">{f.comment}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-foreground/60">
            No feedback yet. Be the first to rate this agent.
          </p>
        )}
      </section>
    </div>
  )
}
