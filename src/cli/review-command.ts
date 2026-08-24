import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Budget, parseLimits, type Limits } from '#app/budget.js'
import { loadConfig, policyChanged } from '#app/config.js'
import { absorbDelegated, delegateBrief } from '#app/delegate.js'
import { baseRefOf, checkRange, headSha, repoRoot, shaOf } from '#app/git.js'
import { JUDGES } from '#app/judges/prompts.js'
import { RunManifest, coverageProblems, hashOf, writeManifest } from '#app/manifest.js'
import { Trace } from '#app/otel.js'
import { PACKAGE_VERSION } from '#app/package-meta.js'
import { dim, yellow } from '#app/report/ansi.js'
import { progress, stage } from '#app/report/terminal.js'
import { summarizeRun } from '#app/report/summary.js'
import { review } from '#app/review.js'
import { scanPaths } from '#app/scan.js'
import { Session } from '#app/session.js'
import { withTargetTree } from '#app/snapshot.js'
import { SEVERITIES, type Severity } from '#app/types.js'
import { VERIFIERS } from '#app/verifiers/index.js'
import { positiveNumber, type CliValues } from './args.js'
import {
  REPORT_FORMATS,
  isReportFormat,
  parseReportSpecs,
  publishReports,
  type ReportFormat,
} from './reports.js'

export type ReviewCommand = 'review' | 'scan' | 'delegate'

function targetName(command: ReviewCommand, values: CliValues, positionals: string[]): string {
  if (command === 'scan') return 'scan ' + (positionals[1] ?? '.')
  if (values.commit) return 'commit ' + values.commit
  if (values.from) return values.from + '...' + values.to
  return 'workspace'
}

export async function runReviewCommand(
  command: ReviewCommand,
  values: CliValues,
  positionals: string[],
): Promise<number> {
  if (!isReportFormat(values.format)) {
    process.stderr.write('--format must be one of: ' + REPORT_FORMATS.join(', ') + '\n')
    return 2
  }
  if ((values.from && !values.to) || (values.to && !values.from)) {
    process.stderr.write('--from and --to must be given together.\n')
    return 2
  }

  const root = repoRoot(process.cwd())
  const range = { from: values.from, to: values.to, commit: values.commit }

  // Ref validation must precede policy loading because the policy is read through Git.
  try {
    checkRange(root, range)
  } catch (error) {
    process.stderr.write((error as Error).message + '\n')
    return 2
  }

  const gated = values.from !== undefined || values.commit !== undefined
  const policyBase = gated ? baseRefOf(root, range) : undefined
  const config = loadConfig(
    root,
    {
      verifiers: [...new Set(VERIFIERS.flatMap((verifier) => [verifier.name, verifier.id ?? verifier.name]))],
      judges: JUDGES.map((judge) => judge.name),
    },
    policyBase,
  )
  const verifierChecks = new Set(VERIFIERS.flatMap((verifier) => [verifier.name, verifier.id ?? verifier.name]))
  const judgeChecks = new Set(JUDGES.map((judge) => judge.name))
  const requestedChecks = values.checks?.split(',').map((check) => check.trim()).filter(Boolean)
  if (values.checks !== undefined && requestedChecks?.length === 0) {
    process.stderr.write('--checks must name at least one check\n')
    return 2
  }
  if (requestedChecks) {
    const knownChecks = new Set([...verifierChecks, ...judgeChecks])
    const unknown = requestedChecks.filter((name) => !knownChecks.has(name))
    if (unknown.length > 0) {
      process.stderr.write('--checks has unknown name(s): ' + unknown.join(', ') + '\n')
      return 2
    }
    if (command === 'delegate') {
      const deterministic = requestedChecks.filter((name) => !judgeChecks.has(name))
      if (deterministic.length > 0) {
        process.stderr.write('delegate accepts judge names only, not: ' + deterministic.join(', ') + '\n')
        return 2
      }
    } else if (values['verify-only']) {
      const judges = requestedChecks.filter((name) => judgeChecks.has(name) && !verifierChecks.has(name))
      if (judges.length > 0) {
        process.stderr.write('--verify-only cannot run judge check(s): ' + judges.join(', ') + '\n')
        return 2
      }
    }
  }
  if (policyBase && policyChanged(root, policyBase)) {
    process.stderr.write(
      yellow(' ◇ policy') + dim('   this change edits powershot.config.json — reviewed under the base policy') + '\n',
    )
  }
  if (values['min-severity']) {
    const minimum = values['min-severity'] as Severity
    if (!SEVERITIES.includes(minimum)) {
      process.stderr.write('--min-severity must be one of: ' + SEVERITIES.join(', ') + '\n')
      return 2
    }
    config.minSeverity = minimum
  }

  const bundleLimit = positiveNumber(values['max-bundle'], '--max-bundle', 1200)
  if (bundleLimit === undefined) return 2
  const maxBundle = values['max-bundle'] === undefined ? undefined : bundleLimit

  const reportSpecs = parseReportSpecs(values.report)
  if (typeof reportSpecs === 'string') {
    process.stderr.write(reportSpecs + '\n')
    return 2
  }

  if (command === 'delegate' && values.absorb !== undefined) {
    process.stderr.write('--absorb cannot be used with delegate\n')
    return 2
  }
  // Invalid delegated output must not leave behind a resumable session.
  const absorbed = values.absorb !== undefined
    ? absorbDelegated(readFileSync(values.absorb, 'utf8'))
    : undefined

  let limits: Limits = {}
  if (values.budget !== undefined) {
    const parsed = parseLimits(values.budget)
    if (typeof parsed === 'string') {
      process.stderr.write(parsed + '\n')
      return 2
    }
    limits = parsed
  }

  const quiet = values.format === 'json' || values.format === 'sarif' || values.format === 'compact'
  const target = targetName(command, values, positionals)

  let session: Session | undefined
  if (values.resume !== undefined) {
    session = Session.open(root, values.resume)
    if (!session) {
      process.stderr.write('No session ' + values.resume + '. Try: psh session list\n')
      return 2
    }
    if (!session.askedBy(config.provider, config.model)) {
      const previous = session.asked
      process.stderr.write(
        'Session ' + values.resume + ' was judged by ' + previous?.provider + '/' + previous?.model +
          ', and this run would use ' + config.provider + '/' + config.model + '.\n' +
          'Resuming would mix two reviewers into one report. Start a fresh run, or switch back.\n',
      )
      return 2
    }
  } else if (!values['verify-only'] && command !== 'delegate') {
    session = Session.create(root, target, { provider: config.provider, model: config.model })
  }

  if (command === 'delegate') {
    const { buildGround } = await import('#app/ground.js')
    const { collectChanges, statedIntent } = await import('#app/git.js')
    const { matchesAny } = await import('#app/config.js')
    const changes = collectChanges(root, range).filter((change) => !matchesAny(change.path, config.ignore))
    if (changes.length === 0) {
      process.stderr.write('Nothing to review.\n')
      return 0
    }
    const ground = await withTargetTree(root, range, (tree) => buildGround(tree, changes))
    process.stdout.write(delegateBrief(ground, config, {
      intent: statedIntent(root, range),
      maxBundleLines: maxBundle,
      checks: requestedChecks,
    }))
    return 0
  }

  const canceller = new AbortController()
  let interrupted = false
  const onInterrupt = (): void => {
    if (interrupted) process.exit(130)
    interrupted = true
    canceller.abort()
    process.stderr.write(dim('\n ◇ stopping after the current unit — press Ctrl-C again to exit now') + '\n')
  }

  const manifest = new RunManifest(
    session?.id ?? createHash('sha1').update(target + ':' + Date.now()).digest('hex').slice(0, 8),
  )
  const trace = new Trace()
  const runSpan = trace.span('review', { target })

  const result = await withTargetTree(root, command === 'scan' ? {} : range, (tree) => review({
    root: tree,
    stateRoot: root,
    range,
    changes: command === 'scan' ? scanPaths(root, positionals[1] ?? '.') : undefined,
    config,
    session,
    tools: values.tools,
    maxBundleLines: maxBundle,
    signal: canceller.signal,
    cache: !values['no-cache'],
    budget: new Budget(limits),
    manifest,
    showDismissed: values['show-dismissed'],
    absorbed,
    onCancelable: (active) => {
      if (!active) {
        process.off('SIGINT', onInterrupt)
        process.off('SIGTERM', onInterrupt)
        return
      }
      process.on('SIGINT', onInterrupt)
      process.on('SIGTERM', onInterrupt)
    },
    verifyOnly: values['verify-only'],
    checks: requestedChecks,
    onProgress: quiet ? undefined : (line) => process.stderr.write(progress(line) + '\n'),
    onStage: quiet ? undefined : stage,
  }))

  runSpan({
    findings: result.findings.length,
    verified: result.stats.verified,
    judged: result.stats.judged,
    files: result.stats.files,
  })
  await trace.flush()

  const record = manifest.build({
    operation: command,
    repositoryHead: headSha(root),
    target: {
      requested: { from: values.from, to: values.to, commit: values.commit },
      base: policyBase ? shaOf(root, policyBase) : undefined,
      head: headSha(root),
    },
    policy: {
      source: policyBase ? 'base' : 'head',
      ref: policyBase,
      hash: hashOf(JSON.stringify(config)),
    },
    engine: {
      version: PACKAGE_VERSION,
      provider: config.provider,
      model: config.model,
      tools: values.tools,
      verifyOnly: values['verify-only'],
      minSeverity: config.minSeverity,
    },
    files: result.plan?.items() ?? [],
    skippedChecks: result.skippedChecks ?? [],
    unavailableChecks: result.unavailableChecks ?? [],
    findings: {
      total: result.findings.length,
      verified: result.stats.verified,
      judged: result.stats.judged,
      dismissed: result.stats.dismissed,
      droppedPosition: result.droppedPosition ?? 0,
    },
    usage: result.usage ?? { requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 0, units: 0 },
    failures: result.failures,
    cancelled: result.cancelled,
    budgetStop: result.budgetStop,
  })

  const gaps = coverageProblems(record)
  if (gaps.length > 0) {
    const failure = 'manifest: ' + gaps.join('; ')
    result.failures.push(failure)
    record.state = 'failed'
    record.failures.push(failure)
    record.notLookedAt.push(failure)
    process.stderr.write(yellow(' ◇ manifest') + dim(' ' + gaps.join('; ')) + '\n')
  }
  session?.saveReport(result.findings, summarizeRun(record))
  writeManifest(root, record)

  publishReports({
    format: values.format as ReportFormat,
    output: values.output,
    additional: reportSpecs,
    result,
    manifest: record,
    target,
  })
  if (values.format === 'text' && session && !values['verify-only']) {
    process.stderr.write(dim(' session ' + session.id + '  ·  psh review --resume ' + session.id) + '\n')
  }

  if (interrupted) return 130
  if (result.failures.length > 0 || gaps.length > 0 || record.state !== 'complete') return 3
  return result.findings.length > 0 ? 1 : 0
}
