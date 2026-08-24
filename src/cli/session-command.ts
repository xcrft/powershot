import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '#app/git.js'
import { dim, bold, steel, yellow } from '#app/report/ansi.js'
import { viewer } from '#app/report/viewer.js'
import { Session } from '#app/session.js'

export function runSessionCommand(positionals: string[]): number {
  const root = repoRoot(process.cwd())
  const operation = positionals[1]

  if (operation === 'diff') {
    const older = positionals[2] ? Session.open(root, positionals[2]) : undefined
    const newer = positionals[3] ? Session.open(root, positionals[3]) : undefined
    if (!older?.report || !newer?.report || older.report.state !== 'complete' || newer.report.state !== 'complete') {
      process.stderr.write('Need two complete sessions: psh session diff <older> <newer>\n')
      return 2
    }
    const { fixed, introduced, remaining } = Session.compare(older, newer)
    const out = process.stdout
    out.write('\n ' + bold('Between ') + older.id + dim(' and ') + newer.id + '\n\n')
    const show = (label: string, list: typeof fixed, paint: (text: string) => string): void => {
      out.write(' ' + paint(String(list.length).padStart(3) + '  ' + label) + '\n')
      for (const finding of list.slice(0, 10)) {
        out.write(dim('      ' + finding.check + '  ' + finding.file + ':' + finding.line + '  ') + finding.title.slice(0, 60) + '\n')
      }
    }
    show('fixed', fixed, steel)
    show('introduced', introduced, yellow)
    out.write(' ' + dim(String(remaining.length).padStart(3) + '  still there') + '\n\n')
    return introduced.length > 0 ? 1 : 0
  }

  if (operation === 'view') {
    const id = positionals[2]
    const session = id ? Session.open(root, id) : undefined
    if (!session?.report) {
      process.stderr.write('No finished session ' + (id ?? '') + '. Try: psh session list\n')
      return 2
    }
    const output = join(root, '.powershot', 'sessions', session.id + '.html')
    writeFileSync(output, viewer(session.report.findings, {
      id: session.id,
      target: session.target,
      started: session.started,
      state: session.report.state ?? 'unknown',
      notLookedAt: session.report.notLookedAt ?? ['session predates verdict recording'],
      coverage: session.report.coverage,
      verifyOnly: session.report.verifyOnly,
      minSeverity: session.report.minSeverity,
      filesReviewed: session.report.filesReviewed,
      deterministicChecks: session.report.deterministicChecks,
      scopeDetails: session.report.scopeDetails,
    }))
    process.stdout.write(output + '\n')
    return 0
  }

  const rows = Session.list(root)
  if (rows.length === 0) {
    process.stdout.write(dim('\n No resumable sessions.\n\n'))
    return 0
  }
  process.stdout.write('\n ' + bold('Sessions') + '\n\n')
  for (const row of rows) {
    process.stdout.write('  ' + steel(row.id) + '  ' + dim(row.started.slice(0, 19).replace('T', ' ')) +
      '  ' + row.target + dim('   ' + row.done + ' unit(s) done') + '\n')
  }
  process.stdout.write('\n' + dim(' psh review --resume <id>') + '\n\n')
  return 0
}
