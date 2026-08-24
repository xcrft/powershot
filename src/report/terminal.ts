import type { Finding, Severity } from '#app/types.js'
import { bold, brightRed, dim, gray, red, steel, yellow } from './ansi.js'
import { highlight, isJsx } from './highlight.js'

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: brightRed,
  high: red,
  medium: yellow,
  low: gray,
  info: gray,
}

function width(): number {
  // stdout.columns is undefined when piped; COLUMNS is the conventional fallback
  const columns = process.stdout.columns ?? (Number(process.env.COLUMNS) || 80)
  return Math.max(60, Math.min(columns, 100))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * The title is the finding, so it wraps instead of truncating — losing the end of
 * "…resolves as success" would cost the reader the point of the sentence.
 */
export function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= max) line += ' ' + word
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = out.get(f.file) ?? []
    list.push(f)
    out.set(f.file, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.line - b.line)
  return out
}

/**
 * The code frame. Only the offending line is syntax-highlighted; its context is
 * plain gray, so the eye lands on the line under review without needing a marker
 * to compete with the code.
 */
function emitFrame(out: string[], f: Finding, w: number): void {
  if (!f.frame) return
  const { firstLine, lines } = f.frame
  const gutterWidth = String(firstLine + lines.length - 1).length
  const room = w - gutterWidth - 9

  out.push('')
  lines.forEach((text, i) => {
    const lineNo = firstLine + i
    const isTarget = lineNo === f.line
    const gutter = String(lineNo).padStart(gutterWidth)
    const arrow = isTarget ? SEVERITY_COLOR[f.severity]('❯') : ' '
    const shown = truncate(text, room)
    const body = isTarget ? highlight(shown, isJsx(f.file)) : gray(shown)
    out.push('   ' + arrow + ' ' + dim(gutter + ' │ ') + body)

    // the caret sits directly under the token it marks, so "which part of this line"
    // never has to be guessed from the message
    if (isTarget && f.frame?.caret) {
      const { offset, length } = f.frame.caret
      if (offset < shown.length) {
        const run = Math.max(1, Math.min(length, shown.length - offset))
        out.push(
          '     ' + dim(' '.repeat(gutterWidth) + ' │ ') + ' '.repeat(offset) + SEVERITY_COLOR[f.severity]('^'.repeat(run)),
        )
      }
    }
  })
}

function emitEvidence(out: string[], f: Finding, w: number): void {
  if (!f.evidence) return
  const lead = '     ╰ '
  const indent = ' '.repeat(lead.length)
  wrap(f.evidence.oracle + ': ' + f.evidence.detail, w - lead.length - 2).forEach((line, i) =>
    out.push(dim((i === 0 ? lead : indent) + line)),
  )
}

function severityCounts(findings: Finding[]): string {
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
  return order
    .map((s) => ({ s, n: findings.filter((f) => f.severity === s).length }))
    .filter(({ n }) => n > 0)
    .map(({ s, n }) => SEVERITY_COLOR[s](String(n) + ' ' + s))
    .join(dim(' · '))
}

export type TerminalOptions = {
  /** what was reviewed, e.g. "workspace" or "main...feat/x" */
  subtitle: string
  verified: number
  judged: number
  state: 'complete' | 'partial' | 'failed'
  /** authoritative manifest reasons why a partial or failed run is not a verdict */
  notLookedAt: string[]
  coverage?: 'full' | 'portable'
  /** Optional semantic depth that did not block this portable verdict. */
  unavailableCoverage?: string[]
}

/**
 * The review view: findings grouped under the file they belong to, each showing the
 * code it is about. Seeing the line is what makes a finding actionable without
 * opening an editor, so the frame is the centre of the layout, not a decoration.
 */
export function terminal(findings: Finding[], opts: TerminalOptions): string {
  const w = width()
  const rule = dim(' ' + '─'.repeat(w - 2))
  const out: string[] = ['']

  out.push(' ' + bold('PowerShot') + dim('  ·  ' + opts.subtitle))
  out.push(rule)

  const incomplete = opts.state !== 'complete'
  const portable = !incomplete && opts.coverage === 'portable'

  if (findings.length === 0) {
    out.push(
      '',
      incomplete
        ? ' ' + yellow('!') + '  No findings — but this review is ' + opts.state + ', not a verdict.'
        : ' ' + steel('✔') + (portable ? '  No findings in portable coverage.' : '  No findings.'),
    )
    for (const reason of opts.notLookedAt) out.push(dim('    ' + reason))
    if (portable) {
      out.push(dim('    Portable coverage: self-contained oracles ran; enriched semantic depth was unavailable.'))
      for (const reason of opts.unavailableCoverage ?? []) out.push(dim('    ' + reason))
    }
    out.push('')
    return out.join('\n')
  }

  for (const [file, list] of groupByFile(findings)) {
    out.push('', ' ' + bold(file))

    for (const f of list) {
      const isVerified = f.class === 'verified'
      const mark = isVerified ? steel('▣') : red('▚')
      const badge = SEVERITY_COLOR[f.severity](f.severity.toUpperCase().padEnd(8))
      const origin = isVerified ? steel(f.check) : red(f.check)

      out.push('')
      out.push('  ' + mark + ' ' + badge + origin + dim(' · ' + f.confidence))
      for (const line of wrap(f.title, w - 6)) out.push('    ' + line)

      emitFrame(out, f, w)
      emitEvidence(out, f, w)

      if (f.fix) {
        const [head, ...rest] = wrap(f.fix, w - 7)
        out.push('    ' + yellow('→ ') + head)
        for (const line of rest) out.push('      ' + line)
      }
    }
  }

  const tally =
    findings.length + (findings.length === 1 ? ' finding' : ' findings') + dim('   ') + severityCounts(findings)
  const split = steel(String(opts.verified) + ' verified') + dim(' · ') + red(String(opts.judged) + ' judged')

  out.push('', rule)
  out.push(' ' + tally + dim('   ·   ') + split)
  if (incomplete) {
    out.push('')
    out.push(' ' + yellow('! this review is ' + opts.state + ' — findings may be missing'))
    for (const reason of opts.notLookedAt) out.push(dim('   ' + reason))
  } else if (portable) {
    out.push(' ' + steel('◇ portable coverage') + dim(' · enriched semantic depth was unavailable'))
    for (const reason of opts.unavailableCoverage ?? []) out.push(dim('   ' + reason))
  }
  out.push('')
  return out.join('\n')
}

export function progress(line: string): string {
  return dim(' ◇ ' + line)
}

export function stage(label: string): (result: string) => void {
  const tty = process.stderr.isTTY === true
  const started = Date.now()

  if (tty) process.stderr.write(dim(' ◇ ' + label.padEnd(9) + ' …'))

  return (result: string) => {
    const ms = Date.now() - started
    const took = ms >= 100 ? dim('  (' + (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms') + ')') : ''
    if (tty) {
      process.stderr.clearLine(0)
      process.stderr.cursorTo(0)
    }
    process.stderr.write(progress(label.padEnd(9) + ' ' + result) + took + '\n')
  }
}
