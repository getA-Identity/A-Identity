import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { trackPageView } from '../lib/analytics'

/**
 * Reports a page view on every client-side navigation.
 *
 * A single-page app only ever loads once, so the automatic page view a tag fires
 * on load describes the first URL and nothing after it. Without this, every
 * session looks like one visit to whichever page the visitor happened to land on.
 *
 * The document title is read a tick late on purpose: route components set it in
 * their own effects, and reading it synchronously here would report the previous
 * page's title against the new page's path.
 */
export default function PageViews() {
  const { pathname } = useLocation()

  useEffect(() => {
    const id = window.setTimeout(() => trackPageView(pathname), 0)
    return () => window.clearTimeout(id)
  }, [pathname])

  return null
}
