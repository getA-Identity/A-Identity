/** Number and id formatting shared by the /stellar cards. Pure, so it lives apart from the components. */

/** A whole number of dollars reads bare ($5); anything smaller keeps the digits it needs ($0.005). */
export const money = (n: number) => {
  if (!Number.isFinite(n)) return '$?'
  if (Number.isInteger(n)) return `$${n}`
  const s = n.toFixed(7).replace(/0+$/, '')
  return `$${s.split('.')[1].length < 2 ? n.toFixed(2) : s}`
}

export const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id)

/** Base units (seven decimals) as a dollar figure. */
export const fromRaw = (raw: string, decimals = 7) => {
  try {
    return Number(BigInt(raw)) / 10 ** decimals
  } catch {
    return NaN
  }
}
