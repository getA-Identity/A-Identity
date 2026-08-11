/**
 * Number formatting for /stats. Its own module so the component files stay component-only
 * (an exported constant beside a component breaks React Fast Refresh for the whole file).
 */

export const nf = new Intl.NumberFormat('en-US')

/** Whole counts. Also called mid-animation with a fractional value, hence the round. */
export const int = (n: number) => nf.format(Math.round(n))

/**
 * Money at a fixed precision. Fixed rather than "up to N digits" on purpose: a counter
 * animating through 0.5 would otherwise render "$0.5" one frame and "$0.528" the next,
 * and a value whose digit count flickers reads as noise even with tabular figures.
 */
export const usdFixed = (n: number, digits: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
