import { f1, loadCases, precision, recall, replayRepo, runCases, type Score } from '#app/bench.js'
import { repoRoot } from '#app/git.js'
import { dim, bold, steel, yellow } from '#app/report/ansi.js'
import { positiveNumber, type CliValues } from './args.js'

function percentage(value: number): string {
  return (value * 100).toFixed(1) + '%'
}

function total(scores: Score[]): Score {
  return scores.reduce(
    (sum, score) => ({ tp: sum.tp + score.tp, fp: sum.fp + score.fp, fn: sum.fn + score.fn }),
    { tp: 0, fp: 0, fn: 0 },
  )
}

export async function runBenchCommand(values: CliValues): Promise<number> {
  const root = values.repo !== undefined ? repoRoot(values.repo) : repoRoot(process.cwd())
  const out = process.stdout

  if (values.cases !== undefined) {
    const cases = loadCases(values.cases)
    if (cases.length === 0) {
      process.stderr.write('No .json cases found in ' + values.cases + '\n')
      return 2
    }
    const reports = await runCases(root, cases)
    out.write('\n ' + bold('PowerShot bench') + dim('  ·  ' + cases.length + ' labelled case(s)') + '\n\n')
    for (const report of reports) {
      if (!report.complete) {
        out.write('  ' + yellow(report.state) + '  ' + report.name + dim('   ' + report.reasons.join('; ')) + '\n')
        continue
      }
      const exact = report.score.fp === 0 && report.score.fn === 0
      out.write('  ' + (exact ? steel('pass') : yellow('diff')) + '  ' + report.name +
        dim('   tp ' + report.score.tp + ' · fp ' + report.score.fp + ' · fn ' + report.score.fn) + '\n')
    }
    const complete = reports.filter((report): report is Extract<(typeof reports)[number], { complete: true }> => report.complete)
    const score = total(complete.map((report) => report.score))
    if (complete.length > 0) {
      out.write('\n ' + bold('precision ' + percentage(precision(score))) + dim('  ·  ') +
        'recall ' + percentage(recall(score)) + dim('  ·  ') + 'F1 ' + percentage(f1(score)) + '\n\n')
    } else {
      out.write('\n ' + yellow('No complete case could be scored.') + '\n\n')
    }
    if (complete.length !== reports.length) return 3
    return score.fp + score.fn > 0 ? 1 : 0
  }

  const last = positiveNumber(values.last, '--last', 50)
  if (last === undefined) return 2
  process.stderr.write(dim(' ◇ replaying ' + last + ' commit(s) from ' + root) + '\n')
  const report = await replayRepo(root, last, (line) => process.stderr.write(dim(' ◇ ' + line) + '\n'))

  out.write('\n ' + bold('PowerShot bench') + dim('  ·  ' + report.commits + ' complete commit(s)') + '\n')
  out.write(dim(' ' + '─'.repeat(70)) + '\n\n')

  if (report.findings === 0 && report.partial === 0 && report.failed === 0 && report.falseClean === 0) {
    out.write(' ' + steel('✔') + '  No findings across ' + report.commits + ' reviewed commits.\n')
    out.write(dim('    On already-merged history that is the result to want: the checks stayed quiet.') + '\n\n')
    return 0
  }

  out.write(' ' + report.findings + ' finding(s) on ' + report.noisy.length + ' of ' + report.commits + ' complete commits\n')
  out.write(
    dim('    ' + report.verified + ' verified · ' + report.judged + ' judged' +
      (report.positions.added + report.positions.context > 0
        ? '  ·  judged on a changed line: ' + report.positions.added + '/' + (report.positions.added + report.positions.context)
        : '')) + '\n',
  )
  const coverage = report.coverage
  out.write(dim('    coverage ' + coverage.selected + ' reviewed · ' + coverage.limited + ' limited · ' +
    coverage.waived + ' waived · ' + coverage.failed + ' failed') + '\n')
  out.write(
    (report.falseClean > 0 ? yellow('    ' + report.falseClean + ' commit(s) reported clean by an incomplete run')
      : dim('    no commit was reported clean by an incomplete run')) + '\n',
  )
  if (report.usage.requests > 0) {
    out.write(dim('    ' + report.usage.requests + ' request(s) · ' + report.usage.inputTokens + ' in · ' +
      report.usage.outputTokens + ' out · ' + Math.round(report.usage.elapsedMs / 1000) + 's') + '\n')
  }
  out.write(dim('    Already-merged code — treat each as a likely false positive until read.') + '\n\n')

  const rows = [...report.byCheck.entries()].sort((left, right) => right[1] - left[1])
  for (const [check, count] of rows) {
    out.write('   ' + String(count).padStart(4) + '  ' + check + dim('   ' + (count / report.commits).toFixed(2) + ' per commit') + '\n')
  }
  out.write('\n')
  for (const commit of report.noisy.slice(0, 12)) {
    out.write(dim('   ' + commit.commit + '  ' + commit.subject.slice(0, 58)) + '\n')
    for (const finding of commit.findings.slice(0, 4)) {
      out.write('     ' + yellow(finding.check) + ' ' + dim(finding.file + ':' + finding.line) + '  ' + finding.title.slice(0, 60) + '\n')
    }
  }
  if (report.partial > 0) out.write(dim('\n   ' + report.partial + ' commit(s) were partial and not scored') + '\n')
  if (report.failed > 0) out.write(dim('   ' + report.failed + ' commit(s) failed and were not scored') + '\n')
  out.write('\n')
  return report.partial > 0 || report.failed > 0 || report.falseClean > 0 ? 3 : 0
}
