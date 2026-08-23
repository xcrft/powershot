/**
 * Colour is opt-out via NO_COLOR and off automatically when piped, so redirecting
 * to a file or a PR comment never lands escape codes in the output.
 */
export const COLOR =
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true)

const ESC = '['
export const paint = (code: string) => (s: string) => (COLOR ? ESC + code + 'm' + s + ESC + '0m' : s)

export const dim = paint('2')
export const bold = paint('1')
export const red = paint('31')
export const brightRed = paint('91')
export const green = paint('32')
export const steel = paint('36')
export const yellow = paint('33')
export const magenta = paint('35')
export const gray = paint('90')
