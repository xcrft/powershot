import { Dismissals, lastReport } from '#app/dismissed.js'
import { repoRoot } from '#app/git.js'
import { dim, bold, steel } from '#app/report/ansi.js'

export function runDismissCommand(positionals: string[], reason?: string): number {
  const root = repoRoot(process.cwd())
  const dismissals = Dismissals.open(root)
  const subject = positionals[1]

  if (!subject || subject === 'list') {
    const all = dismissals.list()
    if (all.length === 0) {
      process.stdout.write(dim('\n Nothing has been dismissed.\n\n'))
      return 0
    }
    process.stdout.write('\n ' + bold('Dismissed') + dim('  ·  committed, so the team shares it') + '\n\n')
    for (const dismissal of all) {
      process.stdout.write('  ' + steel(dismissal.fingerprint.slice(0, 8)) + '  ' + dismissal.check + dim(' · ' + dismissal.file) + '\n')
      process.stdout.write(dim('            ' + dismissal.code.slice(0, 68)) + '\n')
      if (dismissal.reason) process.stdout.write(dim('            because: ' + dismissal.reason) + '\n')
    }
    process.stdout.write('\n' + dim(' psh dismiss restore <fingerprint>') + '\n\n')
    return 0
  }

  if (subject === 'restore') {
    const fingerprint = positionals[2]
    if (!fingerprint || !dismissals.remove(fingerprint)) {
      process.stderr.write('No dismissal starting with "' + (fingerprint ?? '') + '". Try: psh dismiss list\n')
      return 2
    }
    process.stdout.write(dim(' restored — it will be reported again\n'))
    return 0
  }

  const finding = lastReport(root).find((item) => item.id.toLowerCase() === subject.toLowerCase())
  if (!finding) {
    process.stderr.write('No finding "' + subject + '" in the last review. Run psh review first.\n')
    return 2
  }
  const added = dismissals.add(finding, reason, new Date().toISOString())
  process.stdout.write(
    (added ? ' dismissed ' : ' already dismissed ') + finding.check + ' at ' + finding.file + ':' + finding.line + '\n',
  )
  return 0
}
