/**
 * A fingerprint of everything that determines the prerendered HTML.
 *
 * The prerendered snapshot lives in the repo rather than being generated at
 * deploy time, which buys a deploy that does not depend on a browser starting on
 * someone else's machine and costs the risk of the snapshot going stale. This is
 * how that risk is paid for: `npm run check` compares this hash against the one
 * recorded when the snapshot was taken, and fails the build when they diverge.
 *
 * Shipping a stale snapshot would be the worst outcome of the whole exercise,
 * because it fails silently and looks exactly like success: the pages are there,
 * they are full of text, and the text is last week's.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

/** Files whose content ends up in, or shapes, the rendered output. */
const ROOTS = ['src', 'index.html', 'public/sitemap.xml']
const EXTS = new Set(['.ts', '.tsx', '.css', '.html', '.xml'])

function walk(path, out) {
  let st
  try {
    st = statSync(path)
  } catch {
    return out
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path).sort()) walk(join(path, entry), out)
  } else if (EXTS.has(extname(path))) {
    out.push(path)
  }
  return out
}

export function sourceHash(root) {
  const files = ROOTS.flatMap((r) => walk(join(root, r), []))
  const h = createHash('sha256')
  for (const f of files) {
    // Path as well as content: moving a component changes the output even when
    // no byte of it changed.
    h.update(f.slice(root.length))
    h.update(readFileSync(f))
  }
  return `sha256:${h.digest('hex')}`
}
