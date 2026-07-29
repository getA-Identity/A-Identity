import { useEffect } from 'react'

/**
 * Per-page title, description, canonical and structured data for a client-rendered SPA.
 *
 * The trap this exists to avoid: `index.html` already ships a description and a canonical
 * pointing at the homepage, so a page that *appends* its own publishes two of each. Two
 * canonicals is worse than none, because a crawler picks one and it may not be yours. So this
 * overwrites the existing tag when there is one and only creates a tag when there is not, then
 * puts the original value back on unmount, which matters because the router never reloads the
 * document.
 *
 * JSON-LD is different: a page may legitimately add a graph alongside the site-wide one in
 * index.html, so blocks are appended and tagged with `data-page-jsonld` for cleanup.
 */
export function usePageMeta({
  title,
  description,
  canonical,
  jsonLd,
  noindex,
}: {
  title: string
  description?: string
  /** Absolute URL. Anything relative would resolve against the current route. */
  canonical?: string
  jsonLd?: unknown
  noindex?: boolean
}) {
  useEffect(() => {
    const restore: (() => void)[] = []

    const prevTitle = document.title
    document.title = title
    restore.push(() => {
      document.title = prevTitle
    })

    const setTag = <T extends HTMLElement>(
      selector: string,
      create: () => T,
      apply: (el: T) => string,
    ) => {
      const existing = document.head.querySelector<T>(selector)
      if (existing) {
        const prev = apply(existing)
        restore.push(() => {
          apply(existing)
          // `apply` returns the previous value so it can be written straight back.
          if (existing instanceof HTMLMetaElement) existing.content = prev
          if (existing instanceof HTMLLinkElement) existing.href = prev
        })
      } else {
        const el = create()
        apply(el)
        document.head.appendChild(el)
        restore.push(() => el.remove())
      }
    }

    if (description) {
      setTag<HTMLMetaElement>(
        'meta[name="description"]',
        () => {
          const m = document.createElement('meta')
          m.name = 'description'
          return m
        },
        (el) => {
          const prev = el.content
          el.content = description
          return prev
        },
      )
    }

    if (canonical) {
      setTag<HTMLLinkElement>(
        'link[rel="canonical"]',
        () => {
          const l = document.createElement('link')
          l.rel = 'canonical'
          return l
        },
        (el) => {
          const prev = el.href
          el.href = canonical
          return prev
        },
      )
    }

    if (noindex) {
      setTag<HTMLMetaElement>(
        'meta[name="robots"]',
        () => {
          const m = document.createElement('meta')
          m.name = 'robots'
          return m
        },
        (el) => {
          const prev = el.content
          el.content = 'noindex, nofollow'
          return prev
        },
      )
    }

    if (jsonLd) {
      const s = document.createElement('script')
      s.type = 'application/ld+json'
      s.dataset.pageJsonld = 'true'
      s.text = JSON.stringify(jsonLd)
      document.head.appendChild(s)
      restore.push(() => s.remove())
    }

    return () => restore.forEach((f) => f())
  }, [title, description, canonical, jsonLd, noindex])
}
