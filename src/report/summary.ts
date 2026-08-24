import type { PlanItem } from '#app/plan.js'
import type { Severity } from '#app/types.js'

export type ReviewState = 'complete' | 'partial' | 'failed' | 'unknown'

/** The small, shared presentation contract behind Markdown, terminal, and HTML. */
export type ReviewSummary<State extends ReviewState = ReviewState> = {
  state: State
  notLookedAt: string[]
  coverage?: 'full' | 'portable'
  verifyOnly?: boolean
  minSeverity?: Severity
  filesReviewed?: number
  deterministicChecks?: number
  scopeDetails?: string[]
}

export type SummaryRecord<State extends ReviewState = ReviewState> = {
  state: State
  notLookedAt: string[]
  coverage?: 'full' | 'portable'
  engine?: { verifyOnly?: boolean; minSeverity?: Severity }
  /** Paths deliberately stay in the manifest so a PR summary remains bounded. */
  files?: Pick<PlanItem, 'disposition' | 'reason' | 'unavailable'>[]
  checks?: {
    ran?: string[]
    unavailable?: { check: string; missing: string }[]
  }
}

function plural(count: number, singular: string, pluralForm = singular + 's'): string {
  return count + ' ' + (count === 1 ? singular : pluralForm)
}

function capabilityName(capability: string): string {
  return ({
    types: 'type information',
    references: 'a reference graph',
    'python-types': 'Python type information',
    base: 'a base revision',
    syntax: 'a syntax tree',
  } as Record<string, string>)[capability] ?? capability
}

function naturalList(values: string[], conjunction = 'and'): string {
  if (values.length < 2) return values[0] ?? ''
  if (values.length === 2) return values[0] + ' ' + conjunction + ' ' + values[1]
  return values.slice(0, -1).join(', ') + ', ' + conjunction + ' ' + values.at(-1)
}

function scopeDetails(record: SummaryRecord): string[] {
  const details: string[] = []
  const selected = (record.files ?? []).filter((file) => file.disposition === 'selected')
  const unavailableGroups = new Map<string, { capabilities: string[]; count: number }>()
  for (const file of selected) {
    if (!file.unavailable?.length) continue
    const order = ['types', 'references', 'python-types', 'base', 'syntax']
    const capabilities = [...new Set(file.unavailable)].sort((left, right) => {
      const leftRank = order.indexOf(left)
      const rightRank = order.indexOf(right)
      return (leftRank === -1 ? order.length : leftRank) - (rightRank === -1 ? order.length : rightRank) ||
        left.localeCompare(right)
    })
    const key = capabilities.join('\0')
    const group = unavailableGroups.get(key) ?? { capabilities, count: 0 }
    group.count++
    unavailableGroups.set(key, group)
  }
  for (const group of unavailableGroups.values()) {
    const capabilities = naturalList(group.capabilities.map(capabilityName))
    details.push(
      plural(group.count, 'reviewed file') + ' lacked ' + capabilities + '.',
    )
  }

  const unavailableChecks = record.checks?.unavailable ?? []
  if (unavailableChecks.length > 0) {
    const shown = unavailableChecks.slice(0, 8).map((check) => check.check)
    const requirements = [...new Set(unavailableChecks.flatMap((check) => check.missing.split(/,\s*/)))]
      .map(capabilityName)
    details.push(
      plural(unavailableChecks.length, 'check') + ' requiring ' + naturalList(requirements, 'or') +
      ' did not run: ' + shown.join(', ') +
      (unavailableChecks.length > shown.length ? ', and ' + (unavailableChecks.length - shown.length) + ' more' : '') + '.',
    )
  }

  const waived = new Map<string, number>()
  for (const file of record.files ?? []) {
    if (file.disposition !== 'waived') continue
    const reason = file.reason ?? 'unspecified reason'
    waived.set(reason, (waived.get(reason) ?? 0) + 1)
  }
  for (const [reason, count] of waived) {
    details.push(plural(count, 'changed file') + ' not reviewed: ' + reason + '.')
  }
  return details
}

export function summarizeRun<State extends ReviewState>(record: SummaryRecord<State>): ReviewSummary<State> {
  const hasFiles = record.files !== undefined
  const hasChecks = record.checks?.ran !== undefined
  return {
    state: record.state,
    notLookedAt: [...record.notLookedAt],
    coverage: record.coverage,
    verifyOnly: record.engine?.verifyOnly,
    minSeverity: record.engine?.minSeverity,
    filesReviewed: hasFiles
      ? record.files!.filter((file) => file.disposition === 'selected').length
      : undefined,
    deterministicChecks: hasChecks ? new Set(record.checks!.ran).size : undefined,
    scopeDetails: scopeDetails(record),
  }
}

export function noFindingsLabel(summary: ReviewSummary): string {
  const threshold = summary.minSeverity === undefined || summary.minSeverity === 'info'
    ? ''
    : summary.minSeverity === 'critical'
      ? 'critical '
      : summary.minSeverity + '-or-higher '
  const origin = summary.verifyOnly === true ? 'deterministic ' : ''
  return 'No ' + threshold + origin + 'findings'
}

export function scopeLine(summary: ReviewSummary): string | undefined {
  const parts: string[] = []
  if (summary.filesReviewed !== undefined) parts.push(plural(summary.filesReviewed, 'file') + ' reviewed')
  if (summary.deterministicChecks !== undefined) {
    parts.push(plural(summary.deterministicChecks, 'deterministic check'))
  }
  if (summary.coverage !== undefined) parts.push(summary.coverage + ' coverage')
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function modeNote(summary: ReviewSummary, verifyOnly = 'verify-only'): string | undefined {
  return summary.verifyOnly === true ? 'Model review was disabled (' + verifyOnly + ').' : undefined
}
