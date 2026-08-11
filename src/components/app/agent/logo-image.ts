/**
 * The browser side of an agent logo: one file picked by a human turned into one small
 * square data URL.
 *
 * This lived inside the registration wizard until the dashboard needed the same thing to
 * change a logo after the fact. Two copies would mean two definitions of "too large" and
 * two sets of wording for the same failure, so it is one function now and both callers
 * import it.
 *
 * Nothing here talks to the network. The resize happens locally, which is why the
 * original file never leaves the machine: only the 96px square does.
 */

/** The stored square, in CSS pixels. Every surface renders the logo at or under this. */
export const LOGO_PX = 96

/** The server's bound on a stored logo (mcp/src/platform/agents.ts MAX_LOGO_DATA_URL_CHARS).
 *  Checked here too so an image that would be refused fails while the picker is still on
 *  screen, instead of after a round trip. */
export const MAX_LOGO_DATA_URL_CHARS = 150_000

/**
 * Read an image file and return a cover-cropped {@link LOGO_PX} square as a PNG data URL.
 * Rejects with a message written for the person who picked the file, so callers can show
 * `err.message` verbatim.
 */
export function resizeLogoToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Pick an image file.'))
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = LOGO_PX
        canvas.height = LOGO_PX
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Could not read the image.'))
          return
        }
        // Cover-crop from the centre so a wide or tall picture is not squashed.
        const side = Math.min(img.width, img.height)
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, LOGO_PX, LOGO_PX)
        const data = canvas.toDataURL('image/png')
        if (data.length > MAX_LOGO_DATA_URL_CHARS) {
          reject(new Error('That image compresses too large; try a simpler one.'))
          return
        }
        resolve(data)
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Could not read the image.'))
    }
    img.src = objectUrl
  })
}

/** The message to show for a rejected pick. Never leaks a raw exception at a user. */
export function logoErrorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not read the image.'
}
