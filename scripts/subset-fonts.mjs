/**
 * Regenerate the latin-ext subset. Documented so the 3 KB file in public/fonts
 * is reproducible rather than a mystery binary someone is afraid to touch.
 *
 * Google ships Inter's latin-ext as an 85 KB variable font covering every
 * European accented form. This site needs ten of those glyphs: Turkish, and the
 * currency signs. Shipping the other 99% cost more than the entire CSS bundle,
 * at VeryHigh priority, on a page whose only latin-ext character is the ₮ in
 * USD₮0.
 *
 * Requires fonttools:  pip install fonttools brotli
 * Then:  pyftsubset <original> --text-file=... --flavor=woff2 --layout-features='*'
 *
 * The glyph list below is the union of what the prerendered pages actually
 * render and the full Turkish alphabet, so future Turkish copy cannot fall back
 * mid-word. Characters that live in the base latin file (ı, …, ›, and the
 * accented vowels) are deliberately absent here: they were never in latin-ext.
 */
export const LATIN_EXT_GLYPHS = 'ĞğİŞş₮₺'

/**
 * The heading face gets the same treatment, and it matters more: it is the font
 * the h1 is set in, the h1 is the LCP element, and a text LCP is recorded when
 * the final font paints. Every kilobyte of it sits directly on the critical
 * path. 45,628 bytes to 17,064.
 *
 * Its glyph set is every printable character the prerendered pages render, plus
 * the full Turkish alphabet, rather than a headings-only scrape: headings are
 * ordinary prose and the next one will contain a character the last one did not.
 */
export const HEADING_GLYPHS = 'every printable character on the site, plus ĞğİıŞşÇçÖöÜü'
