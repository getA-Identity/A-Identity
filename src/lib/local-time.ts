/**
 * The viewer's own clock and time zone, for read stamps on the vault pages. A module with no imports,
 * so mcp/src tests can load the Arc read module, which re-exports these, straight from src/.
 */

/** "14:02:11" in the viewer's own clock. */
export function localTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** "Oct 2, 2026, 03:00" in the viewer's own clock. */
export function localDateTime(iso: string | number): string {
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The viewer's IANA time zone and its short offset name, e.g. "Europe/Istanbul, GMT+3". */
export function viewerTimeZone(at: Date = new Date()): string {
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    zone = ''
  }
  let short = ''
  try {
    short =
      new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    short = ''
  }
  if (zone && short && zone !== short) return `${zone}, ${short}`
  return zone || short || 'your local time'
}
