import { writeFileSync } from 'node:fs'
import { unavailableCoverage, type RunManifestV1 } from '#app/manifest.js'
import type { ReviewResult } from '#app/review.js'
import { dim } from '#app/report/ansi.js'
import { codeQuality } from '#app/report/codequality.js'
import { compact } from '#app/report/compact.js'
import { markdown } from '#app/report/markdown.js'
import { sarif } from '#app/report/sarif.js'
import { terminal } from '#app/report/terminal.js'

export const REPORT_FORMATS = ['text', 'compact', 'markdown', 'json', 'sarif', 'codequality', 'manifest'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]
export type ReportSpec = { format: ReportFormat; path: string }

export function isReportFormat(value: string): value is ReportFormat {
  return REPORT_FORMATS.includes(value as ReportFormat)
}

export function parseReportSpecs(values: string[] = []): ReportSpec[] | string {
  const reports: ReportSpec[] = []
  for (const spec of values) {
    const separator = spec.indexOf('=')
    const format = separator === -1 ? spec : spec.slice(0, separator)
    if (!isReportFormat(format)) return '--report format must be one of: ' + REPORT_FORMATS.join(', ')
    const path = separator === -1 ? '' : spec.slice(separator + 1)
    if (!path) return '--report needs a path: --report ' + format + '=<file>'
    reports.push({ format, path })
  }
  return reports
}

function jsonResult(result: ReviewResult): string {
  return JSON.stringify(result, (_key, value) => (value instanceof Set ? [...value] : value), 2) + '\n'
}

export function renderReport(
  format: ReportFormat,
  result: ReviewResult,
  manifest: RunManifestV1,
  target: string,
): string {
  if (format === 'manifest') return JSON.stringify(manifest, null, 2) + '\n'
  if (format === 'compact') return compact(result.findings)
  if (format === 'codequality') return codeQuality(result.findings)
  if (format === 'sarif') return sarif(result.findings)
  if (format === 'json') return jsonResult(result)
  if (format === 'markdown') return markdown(result.findings, manifest)
  return terminal(result.findings, {
    subtitle: target,
    ...result.stats,
    state: manifest.state,
    notLookedAt: manifest.notLookedAt,
    coverage: manifest.coverage,
    unavailableCoverage: unavailableCoverage(manifest),
  })
}

export function publishReports(options: {
  format: ReportFormat
  output?: string
  additional: ReportSpec[]
  result: ReviewResult
  manifest: RunManifestV1
  target: string
}): void {
  const { result, manifest, target } = options
  for (const report of options.additional) {
    writeFileSync(report.path, renderReport(report.format, result, manifest, target))
    process.stderr.write(dim(' written to ' + report.path) + '\n')
  }

  const primary = renderReport(options.format, result, manifest, target)
  if (options.output !== undefined) {
    writeFileSync(options.output, primary)
    process.stderr.write(dim(' written to ' + options.output) + '\n')
  } else {
    process.stdout.write(primary)
  }
}
