import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider } from './components/ThemeProvider'
import './index.css'

const root = document.getElementById('root')!

/**
 * Hydrate when there is prerendered markup, mount fresh when there is not.
 *
 * The build ships a static snapshot of every public route, so in production this
 * container arrives full. `createRoot` would throw all of that away and rebuild
 * the tree from scratch, which is exactly what it looked like in the trace:
 * first paint at 2.2s from the snapshot, then the largest element repainting
 * more than two seconds later when React replaced it. The pixels were there and
 * then briefly stopped being there.
 *
 * `hydrateRoot` adopts the existing DOM instead. The check is on the container
 * rather than an environment flag so `vite dev`, which serves an empty shell,
 * keeps mounting normally without a special case.
 */
const app = (
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)

if (root.firstElementChild) {
  ReactDOM.hydrateRoot(root, app, {
    // A mismatch here is not fatal: React re-renders the offending subtree and
    // the page is correct either way. It is worth knowing about, though, because
    // a systematic one means the snapshot and the runtime disagree about
    // something, and silently repainting half the page is how the LCP problem
    // this change fixes got introduced in the first place.
    onRecoverableError: (error) => {
      if (import.meta.env.DEV) console.warn('[hydrate] recovered:', error)
    },
  })
} else {
  ReactDOM.createRoot(root).render(app)
}
