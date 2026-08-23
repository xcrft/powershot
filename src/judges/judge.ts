import type { Config } from '#app/config.js'
import type { Finding, Ground, Severity } from '#app/types.js'
import { lines as splitLines } from '#app/text.js'
import { complete, extractJsonArray } from './llm.js'
import type { Budget } from '#app/budget.js'
import { TOOLS, runTool } from './tools.js'
import { CONTEXT, reviewables, type Bundle, type Reviewable } from '#app/bundle.js'
import { COMMON, type JudgeSpec } from './prompts.js'

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

/**
 * The changed lines with a little context, marked so the model can tell what the
 * change introduced from what merely surrounds it.
 */
export function renderChanges(files: Reviewable[]): string {
  const parts: string[] = []
  for (const f of files) {
    const all = splitLines(f.text)
    const added = [...f.added].sort((a, b) => a - b)
    if (added.length === 0) continue

    const show = new Set<number>()
    for (const n of added) for (let i = n - CONTEXT; i <= n + CONTEXT; i++) if (i >= 1 && i <= all.length) show.add(i)

    const body = [...show]
      .sort((a, b) => a - b)
      .map((n) => (f.added.has(n) ? '+' : ' ') + String(n).padStart(5) + ' | ' + (all[n - 1] ?? ''))
      .join('\n')
    parts.push('=== ' + f.path + ' ===\n' + body)
  }
  return parts.join('\n\n')
}

/** Parse whatever the model returned into findings, discarding anything malformed. */
export function parseFindings(raw: string, check: string): Finding[] {
  const out: Finding[] = []
  for (const item of extractJsonArray(raw)) {
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file : undefined
    const line = typeof f.line === 'number' ? f.line : undefined
    const title = typeof f.title === 'string' ? f.title : undefined
    if (!file || !line || !title) continue

    out.push({
      id: '',
      class: 'judged',
      check,
      severity: (SEVERITIES.has(String(f.severity)) ? f.severity : 'medium') as Severity,
      confidence: f.confidence === 'firm' ? 'firm' : 'tentative',
      file,
      line,
      title,
      evidence: typeof f.why === 'string' ? { oracle: 'agent', detail: f.why } : undefined,
      fix: typeof f.fix === 'string' ? f.fix : undefined,
      // a patch, and only ever one line — anything longer is advice wearing a
      // suggestion's clothes, and it would be applied with a single click
      suggestion:
        typeof f.suggestion === 'string' && f.suggestion.trim() !== '' && !f.suggestion.includes('\n')
          ? f.suggestion
          : undefined,
    })
  }
  return out
}

export async function runJudge(
  spec: JudgeSpec,
  g: Ground,
  cfg: Config,
  opts: { intent?: string; bundle?: Bundle; useTools?: boolean; budget?: Budget } = {},
): Promise<Finding[]> {
  const files = opts.bundle?.files ?? reviewables(g)
  const changes = renderChanges(files)
  if (!changes.trim()) return []
  if (spec.needsIntent && !opts.intent) return [] // nothing to compare the diff against

  const preamble = spec.needsIntent
    ? 'This change states that it does the following:\n\n' + opts.intent + '\n\n'
    : ''

  const tools = opts.useTools
    ? { defs: TOOLS, run: (name: string, input: Record<string, unknown>) => runTool(g, name, input) }
    : undefined

  const guidance = tools
    ? '\n\nYou may read files, search the repository, and list references before answering.' +
      ' Check a suspicion rather than reporting it unverified. When done, answer with the JSON array.'
    : ''

  const { text: raw, usage } = await complete(
    cfg,
    {
      system: COMMON + '\n\n' + spec.brief + guidance,
      user: preamble + 'Review these changed lines (marked with +).\n\n' + changes,
    },
    2000,
    tools,
  )

  opts.budget?.spend({ ...usage, units: 1 })
  return parseFindings(raw, spec.name)
}
