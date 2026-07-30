import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import ScrollToTop from './components/ScrollToTop'
import PageViews from './components/PageViews'
import { initAnalytics } from './lib/analytics'
import { registerWebMcpTools } from './lib/webmcp'
import { useAuth } from './store/auth'
import Landing from './routes/Landing'
import Login from './routes/Login'
import Signup from './routes/Signup'
import AuthCallback from './routes/AuthCallback'
import Manifesto from './routes/Manifesto'
import Brand from './routes/Brand'
import Contact from './routes/Contact'
import Faq from './routes/Faq'
import Blog from './routes/Blog'
import BlogPost from './routes/BlogPost'
import UseCase from './routes/UseCase'
import Explorer from './routes/Explorer'
import Architecture from './routes/Architecture'
import Mascot from './routes/Mascot'
import BrandKit from './routes/BrandKit'
import Motion from './routes/Motion'
import NotFound from './routes/NotFound'
import ProtectedRoute from './routes/ProtectedRoute'
import AppLayout from './routes/app/AppLayout'
import Dashboard from './routes/app/Dashboard'
import AgentId from './routes/app/AgentId'
import Wallet from './routes/app/Wallet'
import Settlements from './routes/app/Settlements'
import Permissions from './routes/app/Permissions'
import Marketplace from './routes/app/Marketplace'
import Earnings from './routes/app/Earnings'

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
  useEffect(() => {
    initAnalytics()
  }, [])

  return (
    <BrowserRouter>
      <ScrollToTop />
      <PageViews />
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
            <Route path="earnings" element={<Earnings />} />
          </Route>
        </Route>

        {/* Was a silent redirect home, which made a dead link look like a working one. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
