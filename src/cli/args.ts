import { parseArgs } from 'node:util'

export type CliValues = {
  from?: string
  to?: string
  commit?: string
  format: string
  checks?: string
  'min-severity'?: string
  'verify-only': boolean
  repo?: string
  last?: string
  cases?: string
  tools: boolean
  resume?: string
  output?: string
  'no-cache': boolean
  report?: string[]
  budget?: string
  'show-dismissed': boolean
  reason?: string
  'max-bundle'?: string
  absorb?: string
  help: boolean
}

export type CliInput = {
  values: CliValues
  positionals: string[]
}

export const HELP = `
psh — code review for machine-written code

  psh review                          staged + unstaged + untracked
  psh review --from main --to feat/x  branch range
  psh review --commit <hash>          a single commit
  psh scan <path>                     audit existing files, no git history needed
  psh delegate [--format text|markdown|json]
                                      emit a selection-accounted task for your existing agent
  psh session list | view <id>        runs that can be resumed, or replayed as a page
  psh session diff <a> <b>            what one review found that the other did not
  psh dismiss <id> [--reason "..."]   record that a finding is correct, and stop showing it
  psh dismiss list | restore <fp>     what has been waved through, and undoing it
  psh agent <name> | list             teach a coding agent to use this tool
  psh bench --repo <path>             replay real commits and count what the checks say

Options
  --verify-only          deterministic checks only — no model, no tokens
  --checks a,b           run only these checks
  --min-severity <s>     info | low | medium | high | critical   (default: low)
  --format <f>           text · compact · markdown · json · sarif · codequality · manifest
  --absorb <file>        merge findings a delegated agent produced
  --last <n>             bench: how many commits to replay (default 50)
  --cases <dir>          bench: labelled .json cases to score against
  --tools                let judges read files and search before answering
  --resume <id>          continue a run, reusing judge results already paid for
  --output <path>        write the report to a file instead of stdout
  --report <f>=<path>    write this format to that file; repeatable, one run
  --budget k=v,...       requests · inputTokens · outputTokens · toolCalls · elapsedMs · units
  --no-cache             ask every judge again, ignoring answers already paid for
  --max-bundle <n>       lines per judge prompt (default 1200)
  --help

Exit codes: 0 clean · 1 findings reported · 2 bad usage · 3 review incomplete.
A stage that failed makes the run non-zero even with nothing to report — "we found
nothing" and "we could not look" must not be the same answer to a pipeline.
`

export function parseCliArgs(args = process.argv.slice(2)): CliInput {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      commit: { type: 'string' },
      format: { type: 'string', default: 'text' },
      checks: { type: 'string' },
      'min-severity': { type: 'string' },
      'verify-only': { type: 'boolean', default: false },
      repo: { type: 'string' },
      last: { type: 'string' },
      cases: { type: 'string' },
      tools: { type: 'boolean', default: false },
      resume: { type: 'string' },
      output: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      report: { type: 'string', multiple: true },
      budget: { type: 'string' },
      'show-dismissed': { type: 'boolean', default: false },
      reason: { type: 'string' },
      'max-bundle': { type: 'string' },
      absorb: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }) as CliInput
}

export function positiveNumber(value: unknown, flag: string, fallback: number): number | undefined {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  process.stderr.write(flag + ' must be a positive number, got "' + String(value) + '"\n')
  return undefined
}
