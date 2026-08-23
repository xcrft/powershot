/** Reading source that was not written on the reviewer's machine. */

/** Split on either line ending, so a CRLF checkout does not leave `\r` on every line. */
export function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Strip a single trailing carriage return, for text already split on `\n`. */
export function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

const BOMS: [Buffer, string][] = [
  [Buffer.from([0xef, 0xbb, 0xbf]), 'utf-8'],
  [Buffer.from([0xff, 0xfe]), 'utf-16le'],
  [Buffer.from([0xfe, 0xff]), 'utf-16be'],
]

/**
 * Decode bytes to text, honouring a byte-order mark and falling back rather than
 * throwing. `latin1` is the last resort precisely because it cannot fail: every byte
 * maps to a character, so a file in an encoding we cannot name still parses as code
 * instead of taking the whole review down with it.
 */
export function decode(buf: Buffer): string {
  for (const [bom, encoding] of BOMS) {
    if (buf.length >= bom.length && buf.subarray(0, bom.length).equals(bom)) {
      return new TextDecoder(encoding).decode(buf.subarray(bom.length))
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

/**
 * A path, made safe for every renderer that interpolates one.
 *
 * `stripControl` keeps tabs and newlines because a code frame is layout. A path is
 * not layout: one carrying a newline ended the markdown heading that held it and
 * turned everything after into the attacker's own document.
 */
export function stripPath(text: string): string {
  return stripControl(text).replace(/[\t\r\n]/g, ' ').trim()
}

export function stripControl(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC, terminated by BEL or ST
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, '') // CSI and the other escape families
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
