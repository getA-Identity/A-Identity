import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../store/auth'

/**
 * Gate for the `/app` tree. A signed-in caller (verified wallet/email OR a browse-only
 * guest) may enter; a session with no user at all is redirected to sign-in. Guests are
 * intentionally allowed in read-only. AppLayout surfaces a banner telling them their
 * writes won't persist until they verify, so a write never fails silently.
 *
 * The `restored` wait closes a race: on a hard reload of /app the persisted store can
 * be empty while a valid HttpOnly cookie is still being checked by restore(). Bouncing
 * to /login before that check settles would sign out a signed-in user. Until it
 * settles, render nothing, which matches the app-level Suspense fallback.
 */
export default function ProtectedRoute() {
  const user = useAuth((s) => s.user)
  const restored = useAuth((s) => s.restored)
  if (user) return <Outlet />
  if (!restored) return null
  return <Navigate to="/login" replace />
}
