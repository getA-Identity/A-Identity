/**
 * Console-wide text formatting helpers. One copy: these used to be re-declared
 * per screen (Dashboard, Wallet, Settlements, Marketplace, Permissions), which
 * let the truncation rules drift between screens.
 */

/** Shorten a long address/id for display: 0x1234abcd...ef56. */
export function short(a: string): string {
  return a && a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-4)}` : a
}

/** Shorten any full 40-hex address inside activity text so it never overflows a card. */
export function humanizeActivity(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}...${a.slice(-4)}`)
}

/** Compact "5h ago" style relative time. */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
