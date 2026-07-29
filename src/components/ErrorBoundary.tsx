import { Component, type ErrorInfo, type ReactNode } from 'react'
import { OwlMascot } from './OwlMascot'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * App-root error boundary. Without it, an unexpected render throw anywhere in the tree
 * blanks the whole page (React unmounts the root). This catches it and shows a calm,
 * on-brand recovery card with a reload. A broken panel never takes the app down.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it in the console for debugging; no remote logging on testnet.
    console.error('[A-Identity] render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          {/* Same owl as the 404, so a failure still reads as part of the product. */}
          <OwlMascot variant="officer" className="mx-auto mb-5 w-24" width={96} />
          <h1 className="text-lg font-bold">Something went wrong</h1>
          <p className="mt-2 text-sm text-foreground/60">
            A panel hit an unexpected error. Your data is safe, reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
