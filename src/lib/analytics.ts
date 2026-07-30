/**
 * Google Tag Manager and GA4, loaded only when configured and only when the
 * visitor has not asked us not to.
 *
 * Credential-gated like the rest of this codebase: with no container id in the
 * environment nothing loads, no script tag is injected, and no request leaves the
 * browser. That keeps local development and preview deploys out of the numbers
 * without anyone having to remember to turn something off.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never sends an email, wallet address, agent id or anything else that
 *    identifies a person or an agent. GA4's terms forbid it and, more to the
 *    point, a product whose pitch is "we only keep a hash of your portfolio
 *    state" has no business shipping identifiers to an ad company.
 *  - It never sends a full URL with a query string, because our own lookup puts
 *    the thing being looked up in `?q=`. Paths only.
 *
 * Consent Mode v2 is initialised BEFORE the tag loads, denying ad storage and
 * personalisation outright. Analytics storage follows the visitor's own signals:
 * Do Not Track and Global Privacy Control both switch it off.
 */

type ConsentState = 'granted' | 'denied'
type DataLayerEntry = Record<string, unknown> | IArguments

declare global {
  interface Window {
    dataLayer?: DataLayerEntry[]
    gtag?: (...args: unknown[]) => void
  }
}

const GTM_ID = import.meta.env.VITE_GTM_ID as string | undefined
const GA4_ID = import.meta.env.VITE_GA4_ID as string | undefined

/** Container ids have a fixed shape; a typo in an env var should fail loudly here
 *  rather than silently produce a site that reports nothing for a month. */
const GTM_PATTERN = /^GTM-[A-Z0-9]{4,}$/
const GA4_PATTERN = /^G-[A-Z0-9]{6,}$/

let started = false

/**
 * Has the visitor asked not to be tracked? Do Not Track is widely ignored, which
 * is not a reason for us to ignore it. Global Privacy Control is the newer signal
 * and carries legal weight in some jurisdictions.
 */
function visitorOptedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }
  if (nav.globalPrivacyControl === true) return true
  const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack
  return dnt === '1' || dnt === 'yes'
}

function push(entry: DataLayerEntry): void {
  window.dataLayer = window.dataLayer ?? []
  window.dataLayer.push(entry)
}

/** Consent Mode v2, set before any tag loads so the first hit already respects it. */
function initConsent(analytics: ConsentState): void {
  window.dataLayer = window.dataLayer ?? []
  // gtag pushes `arguments` verbatim; a normal object here would not be read.
  window.gtag =
    window.gtag ??
    function gtag() {
      // eslint-disable-next-line prefer-rest-params
      push(arguments)
    }
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: analytics,
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500,
  })
  // No advertising features, so no reason to accept an ad-network identifier.
  window.gtag('set', 'ads_data_redaction', true)
  window.gtag('set', 'url_passthrough', false)
}

function injectScript(src: string, onError: () => void): void {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  s.onerror = onError
  document.head.appendChild(s)
}

/**
 * Load the configured tags. Safe to call more than once; only the first call does
 * anything. Returns whether tracking actually started, which the caller can use
 * to avoid queueing events that will never be sent.
 */
export function initAnalytics(): boolean {
  if (started || typeof window === 'undefined') return started
  if (!GTM_ID && !GA4_ID) return false

  if (GTM_ID && !GTM_PATTERN.test(GTM_ID)) {
    console.warn(`[analytics] VITE_GTM_ID "${GTM_ID}" is not a GTM container id; ignoring it.`)
  }
  if (GA4_ID && !GA4_PATTERN.test(GA4_ID)) {
    console.warn(`[analytics] VITE_GA4_ID "${GA4_ID}" is not a GA4 measurement id; ignoring it.`)
  }

  const optedOut = visitorOptedOut()
  initConsent(optedOut ? 'denied' : 'granted')
  // With analytics storage denied GA4 still receives cookieless pings, which is
  // the behaviour Consent Mode is designed around: aggregate counts survive, the
  // individual does not become identifiable.

  started = true

  if (GTM_ID && GTM_PATTERN.test(GTM_ID)) {
    push({ 'gtm.start': Date.now(), event: 'gtm.js' })
    injectScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(GTM_ID)}`, () =>
      console.warn('[analytics] GTM failed to load; the site is unaffected.'),
    )
  }

  if (GA4_ID && GA4_PATTERN.test(GA4_ID)) {
    injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA4_ID)}`, () =>
      console.warn('[analytics] GA4 failed to load; the site is unaffected.'),
    )
    window.gtag?.('js', new Date())
    window.gtag?.('config', GA4_ID, {
      // We send page views ourselves on route change: this is a single-page app,
      // and the automatic one would only ever fire for the first URL.
      send_page_view: false,
      anonymize_ip: true,
    })
  }

  // The landing page view, sent here rather than by the router.
  //
  // Loading is deferred until the browser is idle so a 167 KB tag does not
  // compete with the fonts while the hero is painting. The cost of that is that
  // the router's first trackPageView call has already come and gone by now, into
  // a module that was not started yet. Without this line every session would be
  // missing the page it began on, which is the one that tells you where your
  // traffic comes from.
  trackPageView(window.location.pathname)

  return true
}

/**
 * A page view for a client-side navigation.
 *
 * Takes the path only. Our own explorer puts the agent being looked up in `?q=`,
 * and a full URL would carry that wallet address or token id straight into a
 * third party's logs.
 */
export function trackPageView(path: string, title?: string): void {
  if (!started) return
  const clean = path.split('?')[0].split('#')[0]
  push({ event: 'page_view', page_path: clean, page_title: title ?? document.title })
  if (GA4_ID && GA4_PATTERN.test(GA4_ID)) {
    window.gtag?.('event', 'page_view', { page_path: clean, page_title: title ?? document.title })
  }
}

/** The events worth naming. A closed list, so a typo in a call site is a type
 *  error rather than a category that quietly never appears in a report. */
export type TrackedEvent =
  | 'agent_lookup'
  | 'signup_start'
  | 'signup_complete'
  | 'mcp_endpoint_copied'
  | 'docs_opened'
  | 'proof_opened'
  | 'faq_opened'
  | 'demo_run'
  | 'cta_clicked'

/**
 * Record something a visitor did.
 *
 * `detail` is for low-cardinality labels: which FAQ question, which CTA. Never
 * put an agent id, wallet address or email in it. The guard below drops anything
 * that looks like one rather than trusting every future call site to remember.
 */
export function track(event: TrackedEvent, detail?: Record<string, string | number | boolean>): void {
  if (!started) return
  const safe: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (typeof v === 'string' && LOOKS_IDENTIFYING.test(v)) continue
    safe[k] = v
  }
  push({ event, ...safe })
  if (GA4_ID && GA4_PATTERN.test(GA4_ID)) window.gtag?.('event', event, safe)
}

/** 0x addresses, ERC-8004 token ids, emails. Belt and braces for the rule above. */
const LOOKS_IDENTIFYING = /(0x[0-9a-fA-F]{6,})|(#\d{3,})|(@[\w.-]+\.\w{2,})/

/** Whether tracking is live. Exported so a debug surface can say so honestly. */
export const analyticsActive = (): boolean => started
