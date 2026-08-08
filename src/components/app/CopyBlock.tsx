import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** A titled, copy-in-one-click code block for the metadata surfaces. */
export default function CopyBlock({ title, subtitle, text }: { title: string; subtitle: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div>
          <h3 className="text-sm font-bold text-foreground/80">{title}</h3>
          <p className="mt-0.5 text-xs text-foreground/55">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-foreground/[0.03] px-5 py-4 font-mono text-xs leading-relaxed text-foreground/80">
        {text}
      </pre>
    </section>
  )
}
