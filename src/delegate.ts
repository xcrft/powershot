import type { Config } from './config.js'
import type { Finding, Ground } from './types.js'
import { bundle, bundleName } from './bundle.js'
import { renderChanges } from './judges/judge.js'
import { COMMON, JUDGES } from './judges/prompts.js'
import { enabled } from './config.js'
import type { PlanItem } from './plan.js'
import { stripPath } from './text.js'

export const DELEGATE_SCHEMA = 'powershot.delegate/v1' as const

type DelegateFile = Pick<PlanItem, 'path' | 'disposition' | 'reason' | 'bytes' | 'addedLines' | 'language'>

export type DelegateTaskV1 = {
  schema: typeof DELEGATE_SCHEMA
  state: 'complete' | 'failed'
  target: { from?: string; to?: string; commit?: string }
  intent?: string
  files: DelegateFile[]
  judges: {
    name: string
    brief: string
    applicable: boolean
    usesIntent: boolean
    reason?: string
  }[]
  instructions: {
    summary: string
    groundRules: string
    output: {
      type: 'json-array'
      empty: []
      example: {
        file: string
        line: number
        severity: string
        confidence: string
        check: string
        title: string
        why: string
        fix: string
      }[]
    }
  }
  units: { id: number; name: string; files: string[]; changes: string }[]
}

export function buildDelegateTask(
  g: Ground,
  cfg: Config,
  files: PlanItem[],
  opts: {
    intent?: string
    maxBundleLines?: number
    checks?: string[]
    target?: { from?: string; to?: string; commit?: string }
  },
): DelegateTaskV1 {
  const units = bundle(g, opts.maxBundleLines ?? 1200)
  const judges = JUDGES.filter((j) => opts.checks ? opts.checks.includes(j.name) : enabled(cfg.judges, j.name))

  return {
    schema: DELEGATE_SCHEMA,
    state: files.some((file) => file.disposition === 'failed') ? 'failed' : 'complete',
    target: opts.target ?? {},
    intent: opts.intent,
    files: files.map(({ path, disposition, reason, bytes, addedLines, language }) => ({
      path,
      disposition,
      reason,
      bytes,
      addedLines,
      language,
    })),
    judges: judges.map((judge) => {
      const usesIntent = judge.needsIntent === true
      const applicable = !usesIntent || Boolean(opts.intent)
      return {
        name: judge.name,
        brief: judge.brief,
        applicable,
        usesIntent,
        reason: applicable ? undefined : 'no stated intent available',
      }
    }),
    instructions: {
      summary:
        'Perform only the judgement work in this task. PowerShot runs its deterministic checks when these findings are absorbed.',
      groundRules: COMMON,
      output: {
        type: 'json-array',
        empty: [],
        example: [{
          file: 'src/a.ts',
          line: 12,
          severity: 'high',
          confidence: 'firm',
          check: 'plausible-logic',
          title: '…',
          why: '…',
          fix: '…',
        }],
      },
    },
    units: units.map((unit, index) => ({
      id: index + 1,
      name: bundleName(unit, g.root),
      files: unit.files.map((file) => file.path),
      changes: renderChanges(unit.files),
    })),
  }
}

const cell = (value: string): string => stripPath(value).replace(/\|/g, '\\|')

export function delegateBrief(task: DelegateTaskV1): string {
  const scope = task.files.length === 0
    ? ['_No changed files._']
    : [
        '| File | Disposition | Language | Added | Reason |',
        '|---|---|---|---:|---|',
        ...task.files.map((file) =>
          '| ' + cell(file.path) + ' | ' + file.disposition + ' | ' + file.language + ' | ' + file.addedLines +
          ' | ' + cell(file.reason ?? '') + ' |',
        ),
      ]

  const out: string[] = [
    '# PowerShot review brief',
    '',
    task.instructions.summary,
    'Act as each judge below over each review unit, then reply with a single JSON array',
    'combining every finding. Add nothing outside the array.',
    '',
    '## Scope',
    '',
    'Task state: **' + task.state + '**.',
    '',
    ...scope,
    '',
    '## Output contract',
    '',
    '```json',
    JSON.stringify(task.instructions.output.example, null, 2),
    '```',
    '',
    'Return `' + JSON.stringify(task.instructions.output.empty) +
      '` when a judge finds nothing. An empty array is a success, not a failure.',
    '',
    '## Ground rules',
    '',
    task.instructions.groundRules,
    '',
  ]

  for (const judge of task.judges) {
    out.push('## Judge: ' + judge.name, '', judge.brief, '')
    if (judge.usesIntent) {
      out.push(
        task.intent
          ? 'This change states that it does the following:\n\n> ' + task.intent.split('\n').join('\n> ')
          : '_No stated intent available (no commit in range) — skip this judge._',
        '',
      )
    }
  }

  out.push('## Review units', '')
  if (task.units.length === 0) {
    out.push('_No judgement units. Every changed file was excluded or failed preparation; inspect Scope._', '')
  } else {
    task.units.forEach((unit) => {
      out.push('### Unit ' + unit.id + ' — ' + cell(unit.name), '', '```', unit.changes, '```', '')
    })
  }

  return out.join('\n')
}

export function delegateJson(task: DelegateTaskV1): string {
  return JSON.stringify(task, null, 2) + '\n'
}

export function absorbDelegated(json: string): Finding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error('delegated findings are not valid JSON: ' + (error as Error).message)
  }
  if (!Array.isArray(parsed)) throw new Error('delegated findings must be a JSON array')

  const out: Finding[] = []
  for (const [index, value] of parsed.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('delegated finding ' + (index + 1) + ' must be an object')
    }
    const item = value as Record<string, unknown>
    if (
      typeof item.file !== 'string' || item.file.trim() === '' ||
      typeof item.line !== 'number' || !Number.isInteger(item.line) || item.line < 1 ||
      typeof item.title !== 'string' || item.title.trim() === ''
    ) {
      throw new Error('delegated finding ' + (index + 1) + ' needs a file, positive integer line, and title')
    }
    out.push({
      id: '',
      class: 'judged',
      check: typeof item.check === 'string' ? item.check : 'delegated',
      severity: (['critical', 'high', 'medium', 'low', 'info'] as const).includes(item.severity as never)
        ? (item.severity as Finding['severity'])
        : 'medium',
      confidence: item.confidence === 'firm' ? 'firm' : 'tentative',
      file: item.file,
      line: item.line,
      title: item.title,
      evidence: typeof item.why === 'string' ? { oracle: 'delegated agent', detail: item.why } : undefined,
      fix: typeof item.fix === 'string' ? item.fix : undefined,
      suggestion:
        typeof item.suggestion === 'string' && item.suggestion.trim() !== '' && !item.suggestion.includes('\n')
          ? item.suggestion
          : undefined,
    })
  }
  return out
}
