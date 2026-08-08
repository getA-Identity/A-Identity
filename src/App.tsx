import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import ScrollToTop from './components/ScrollToTop'
import PageViews from './components/PageViews'
import { initAnalytics } from './lib/analytics'
import { registerWebMcpTools } from './lib/webmcp'
import { useAuth } from './store/auth'

// Landing stays in the entry chunk: it is the route almost everyone arrives on,
// and making it wait for a second round trip would trade a smaller bundle for a
// slower first paint on the only page that matters for that measurement.
import Landing from './routes/Landing'
import ProtectedRoute from './routes/ProtectedRoute'

/**
 * Everything else is split out. Before this, a visitor to the homepage
 * downloaded and parsed the entire authenticated console, the internal design
 * surfaces, the explorer and viem, in a single 1 MB chunk of which Lighthouse
 * measured 162 KB as unused on first paint.
 */
const Login = lazy(() => import('./routes/Login'))
const Signup = lazy(() => import('./routes/Signup'))
const AuthCallback = lazy(() => import('./routes/AuthCallback'))
const Manifesto = lazy(() => import('./routes/Manifesto'))
const Brand = lazy(() => import('./routes/Brand'))
const Contact = lazy(() => import('./routes/Contact'))
const Faq = lazy(() => import('./routes/Faq'))
const Blog = lazy(() => import('./routes/Blog'))
const BlogPost = lazy(() => import('./routes/BlogPost'))
const UseCase = lazy(() => import('./routes/UseCase'))
const Explorer = lazy(() => import('./routes/Explorer'))
const Architecture = lazy(() => import('./routes/Architecture'))
const Mascot = lazy(() => import('./routes/Mascot'))
const BrandKit = lazy(() => import('./routes/BrandKit'))
const Motion = lazy(() => import('./routes/Motion'))
const NotFound = lazy(() => import('./routes/NotFound'))
const AppLayout = lazy(() => import('./routes/app/AppLayout'))
const Dashboard = lazy(() => import('./routes/app/Dashboard'))
const AgentId = lazy(() => import('./routes/app/AgentId'))
const Wallet = lazy(() => import('./routes/app/Wallet'))
const Settlements = lazy(() => import('./routes/app/Settlements'))
const Permissions = lazy(() => import('./routes/app/Permissions'))
const Marketplace = lazy(() => import('./routes/app/Marketplace'))
const AgentProfile = lazy(() => import('./routes/app/AgentProfile'))
const Earnings = lazy(() => import('./routes/app/Earnings'))

export default function App() {
  // Restore the session from the HttpOnly cookie once on load (the token isn't in
  // localStorage anymore). A definitive 401 clears it; a cold backend leaves it intact.
  useEffect(() => {
    void useAuth.getState().restore()
  }, [])

  // Hand an agent driving this browser the same read tools a person gets from the
  // page, so it can ask "is this counterparty safe" directly instead of scraping.
  // No-op where the API is absent, which is most browsers today.
  useEffect(() => registerWebMcpTools(), [])

  // Nothing loads without a container id in the environment, which keeps local
  // development and preview deploys out of the numbers by construction.
  //
  // Deferred until the browser is idle. The tag is 167 KB and measuring a page
  // must not be a reason the page is slower to arrive; on a phone it was
  // competing for bandwidth with the fonts while the hero was still painting.
  // The first page view is recorded either way, because trackPageView runs off
  // the router and the timeout fires long before anyone can navigate.
  useEffect(() => {
    const start = () => initAnalytics()
    const id =
      window.requestIdleCallback?.(start, { timeout: 4000 }) ?? window.setTimeout(start, 1500)
    return () => {
      if (typeof id === 'number') window.clearTimeout(id)
      else window.cancelIdleCallback?.(id)
    }
  }, [])

  return (
    <BrowserRouter>
      <ScrollToTop />
      <PageViews />
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/manifesto" element={<Manifesto />} />
        <Route path="/brand" element={<Brand />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/faq" element={<Faq />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
        {/* Turkish lives under a locale prefix rather than a query string or a
            cookie, so each translation has its own crawlable, linkable URL. */}
        <Route path="/tr/blog" element={<Blog />} />
        <Route path="/tr/blog/:slug" element={<BlogPost />} />
        <Route path="/use-cases/:slug" element={<UseCase />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="/architecture" element={<Architecture />} />
        {/* Internal design surfaces. Unlinked and noindex. */}
        <Route path="/mascot" element={<Mascot />} />
        <Route path="/brand-kit" element={<BrandKit />} />
        <Route path="/motion" element={<Motion />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="agent-id" element={<AgentId />} />
            <Route path="wallet" element={<Wallet />} />
            <Route path="settlements" element={<Settlements />} />
            <Route path="permissions" element={<Permissions />} />
            <Route path="marketplace" element={<Marketplace />} />
            <Route path="marketplace/:agentId" element={<AgentProfile />} />
            <Route path="earnings" element={<Earnings />} />
          </Route>
        </Route>

        {/* Was a silent redirect home, which made a dead link look like a working one. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
