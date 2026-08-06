/**
 * Which generated object stands for which agent category.
 *
 * Kept out of the component file so that module exports only a component: mixing the two
 * breaks fast refresh, and the console is exactly the surface you iterate on with the
 * browser open.
 *
 * Matching is loose on purpose. `category` is free text that arrives from a registration
 * form, an on-chain manifest or an imported listing, so an unrecognised value lands on the
 * generic module rather than throwing away the row.
 */
const CATEGORY_ART: { match: RegExp; file: string }[] = [
  { match: /trad|financ|defi|invest/i, file: 'trading' },
  { match: /research|data|analy/i, file: 'research' },
  { match: /content|writ|market/i, file: 'content' },
  { match: /dev|code|ops|engineer/i, file: 'devops' },
  { match: /support|service|customer/i, file: 'support' },
]

export function categoryArt(category?: string): string {
  const hit = category ? CATEGORY_ART.find((c) => c.match.test(category)) : undefined
  return `/art/cat/${hit?.file ?? 'other'}.webp`
}
