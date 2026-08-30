import type { Finding } from '#app/types.js'
import {
  modeNote,
  noFindingsLabel,
  scopeLine,
  type ReviewSummary,
} from './summary.js'
import { publishableFindings } from './publication.js'

const MARK: Record<string, string> = { verified: '▣', judged: '▚' }

/** Untrusted prose encoded as literal CommonMark text. */
function text(s: string): string {
  return s
    .replace(/\r?\n/g, ' ')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&')
}

function plural(count: number, singular: string, pluralForm = singular + 's'): string {
  return count + ' ' + (count === 1 ? singular : pluralForm)
}

/** Keep a PR summary scannable; the JSON report retains the complete prose. */
function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const boundary = flat.lastIndexOf(' ', limit)
  const end = boundary >= Math.floor(limit * 0.7) ? boundary : limit
  return flat.slice(0, end).trimEnd() + '…'
}

/** A path inside a code span: only a backtick or a newline can end one. */
function path(s: string): string {
  return s.replace(/[`\r\n]/g, '')
}

/** A repository-relative URL whose untrusted path cannot become a scheme or fragment. */
function href(s: string): string {
  const segment = (part: string): string =>
    (part === '.' || part === '..' ? part.replace(/\./g, '%2E') : encodeURIComponent(part))
      .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return './' + path(s).split('/').map(segment).join('/')
}

/**
 * A fence long enough that its content cannot close it.
 *
 * Indenting the content does not work: CommonMark lets a closing fence carry up to
 * three spaces, so a frame line holding a fence ended the block anyway and everything
 * below it rendered as markup. The rule the spec gives is to open with more backticks
 * than the longest run inside.
 */
function fenceFor(lines: string[], info = ''): { open: string; close: string } {
  const longest = Math.max(0, ...lines.flatMap((l) => [...l.matchAll(/`+/g)].map((m) => m[0].length)))
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return { open: bar + info, close: bar }
}

function languageFor(file: string): string {
  const ext = /\.([^.\/]+)$/.exec(file.toLowerCase())?.[1]
  return ({
    ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyi: 'python', rb: 'ruby', go: 'go', java: 'java',
    rs: 'rust', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    c: 'c', h: 'c', cs: 'csharp', php: 'php', kt: 'kotlin', kts: 'kotlin',
    swift: 'swift', sol: 'solidity',
  } as Record<string, string>)[ext ?? ''] ?? ''
}

function group(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = out.get(f.file) ?? []
    list.push(f)
    out.set(f.file, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.line - b.line)
  return out
}

function runSummary(run: ReviewSummary): string[] {
  const out: string[] = []
  const scope = scopeLine(run)
  const mode = modeNote(run, '`verify-only`')
  const details = run.state === 'complete'
    ? run.scopeDetails ?? []
    : [...run.notLookedAt, ...(run.scopeDetails ?? [])]
  if (scope) out.push(scope, '')
  if (mode) out.push(mode, '')
  if (details.length > 0) {
    out.push(
      '<details>',
      '<summary>' +
        (run.state !== 'complete'
          ? 'Why this is not a verdict'
          : run.coverage === 'portable' ? 'Coverage details' : 'Review scope') +
        '</summary>',
      '',
      ...details.map((detail) => '- ' + text(detail)),
      '',
      '</details>',
      '',
    )
  }
  return out
}

export function markdown(findings: Finding[], run?: ReviewSummary): string {
  // "No findings" from a run that could not look is the one thing this must never
  // say on its own — the reader takes a comment at face value, and a red job beside
  // a green comment is read as a flaky job
  const incomplete = run !== undefined && run.state !== 'complete'
  const banner = incomplete
    ? [
        '> [!WARNING]',
        '> **This review is ' + text(run!.state) + ' — not a verdict.** Some files or checks were not reviewed.',
        '',
      ]
    : []
  const summary = run ? runSummary(run) : []
  const publishable = publishableFindings(findings)
  const withheld = findings.length - publishable.length

  if (publishable.length === 0) {
    return [
      '## PowerShot', '', ...banner,
      incomplete
        ? 'No findings *from what it managed to review*.'
        : withheld > 0
          ? '✅ **No actionable findings**'
          : run ? '✅ **' + noFindingsLabel(run) + '**' : 'No findings.',
      '',
      ...(withheld > 0
        ? [plural(withheld, 'tentative agent suspicion') + ' withheld from this summary.', '']
        : []),
      '', ...summary,
    ].join('\n')
  }

  const verified = publishable.filter((f) => f.class === 'verified').length
  const judged = publishable.length - verified

  const out: string[] = ['## PowerShot', '', ...banner]
  out.push(
    '**' + plural(verified, 'deterministic finding') + '** · **' +
      plural(judged, 'actionable agent finding') + '**',
    '',
  )
  if (withheld > 0) {
    out.push(plural(withheld, 'tentative agent suspicion') + ' withheld from this summary.', '')
  }
  out.push(...summary)

  for (const [file, list] of group(publishable)) {
    out.push('### `' + path(file) + '`', '')
    for (const f of list) {
      out.push(
        MARK[f.class] +
          ' **' +
          f.severity.toUpperCase() +
          '** · `' +
          f.check.replace(/`/g, '') +
          '` · ' +
          f.confidence +
          ' — [' +
          text(path(file)) +
          ':' +
          f.line +
          '](' +
          href(file) +
          '#L' +
          f.line +
          ')',
      )
      out.push('', text(excerpt(f.title, 220)), '')
      if (f.frame) {
        const fence = fenceFor(f.frame.lines, languageFor(file))
        out.push(fence.open, ...f.frame.lines, fence.close, '')
      }
      if (f.evidence) {
        const source = f.evidence.oracle === 'agent'
          ? ''
          : ' (' + text(excerpt(f.evidence.oracle, 80)) + ')'
        out.push('> **Why' + source + ':** ' + text(excerpt(f.evidence.detail, 520)), '')
      }
      if (f.suggestion !== undefined) {
        // GitHub and GitLab both render this as a one-click "apply", so a finding the
        // checker knows the answer to becomes a fix rather than an instruction
        const fence = fenceFor([f.suggestion], 'suggestion')
        out.push(fence.open, f.suggestion, fence.close, '')
      } else if (f.fix) {
        out.push('> **Fix:** ' + text(excerpt(f.fix, 320)), '')
      }
    }
  }
  return out.join('\n')
}
