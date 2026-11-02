/**
 * Keeps one vault's panel from taking the page with it. A contract can answer anything, this page
 * renders what it answers, and a link can be shared, so a value nothing here expected must leave a
 * message about that vault, with the page and the box to pick another still working. Without this,
 * only the app's root boundary catches it, and its Reload button crashes again on the same link.
 * Give it key={the vault} so another vault starts clean.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../../ui/button'

type Props = { what: string; children: ReactNode }
type State = { failed: boolean }

export default class VaultBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[A-Identity] Arc vault panel:', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="rounded-2xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
        <div className="font-semibold text-foreground">{this.props.what} could not be shown.</div>
        <p className="mt-1 text-foreground/80">
          This page hit a value it could not display. Nothing was sent, and nothing in your wallet changed. Do not send USDC to this vault from
          here. Pick another vault, or try again.
        </p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    )
  }
}
