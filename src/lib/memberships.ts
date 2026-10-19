/**
 * Programs A-Identity is a member of, in the order the landing shows them.
 *
 * One list, read by the "Member of" strip on the landing and the footer line, so a
 * membership is stated in one place and nowhere else. Only confirmed memberships belong
 * here: an application in flight is not a membership, and a badge for a program that has
 * not admitted us is exactly the kind of claim this site does not make. The Organization
 * node in index.html carries the same list as schema.org memberOf and is kept by hand,
 * because that file is static HTML.
 */
export type Membership = {
  id: string
  /** The organisation that runs the program, as the badge's main line. */
  org: string
  /** The program itself, as the badge's caption. */
  program: string
  /** The program's own page. */
  href: string
  /** The full-colour mark, a square file under /public/logos, with its intrinsic size. */
  mark: { src: string; width: number; height: number }
  /** The accessible name of the whole badge. */
  label: string
}

export const MEMBERSHIPS: readonly Membership[] = [
  {
    id: 'circle-alliance',
    org: 'Circle',
    program: 'Alliance Program',
    href: 'https://www.circle.com/alliance-program',
    // The same 512px mark the "Built on" rail uses, so Circle is drawn once on the site.
    mark: { src: '/logos/circle-mark.webp', width: 512, height: 512 },
    label: 'Member of the Circle Alliance Program',
  },
]

/**
 * Below this many memberships the strip is a centred row; from here on it becomes a
 * marquee. A marquee of one or two badges is the same badge sliding past again and
 * again, which reads as padding rather than as a list.
 */
export const MEMBERSHIP_MARQUEE_MIN = 4
