import type { Config } from './config.js'
import type { Finding, Ground } from './types.js'
import { bundle, bundleName } from './bundle.js'
import { renderChanges } from './judges/judge.js'
import { COMMON, JUDGES } from './judges/prompts.js'
import { enabled } from './config.js'

export function delegateBrief(
  g: Ground,
  cfg: Config,
  opts: { intent?: string; maxBundleLines?: number; checks?: string[] },
): string {
  const units = bundle(g, opts.maxBundleLines ?? 1200)
  const judges = JUDGES.filter((j) => opts.checks ? opts.checks.includes(j.name) : enabled(cfg.judges, j.name))

  const out: string[] = [
    '# PowerShot review brief',
    '',
    'The deterministic checks have already run; what follows is the judgement work.',
    'Act as each judge below over each review unit, then reply with a single JSON array',
    'combining every finding. Add nothing outside the array.',
    '',
    '## Output contract',
    '',
    '```json',
    '[{"file":"src/a.ts","line":12,"severity":"high","confidence":"firm",',
    '  "check":"plausible-logic","title":"…","why":"…","fix":"…"}]',
    '```',
    '',
    'Return `[]` when a judge finds nothing. An empty array is a success, not a failure.',
    '',
    '## Ground rules',
    '',
    COMMON,
    '',
  ]

  for (const judge of judges) {
    out.push('## Judge: ' + judge.name, '', judge.brief, '')
    if (judge.needsIntent) {
      out.push(
        opts.intent
          ? 'This change states that it does the following:\n\n> ' + opts.intent.split('\n').join('\n> ')
          : '_No stated intent available (no commit in range) — skip this judge._',
        '',
      )
    }
  }

  out.push('## Review units', '')
  units.forEach((unit, i) => {
    out.push('### Unit ' + (i + 1) + ' — ' + bundleName(unit, g.root), '', '```', renderChanges(unit.files), '```', '')
  })

  return out.join('\n')
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
