import { execFileSync } from 'node:child_process'
import { decode } from '#app/text.js'

const HALLUCINATION_RULES = new Map<string, string>([
  ['reportAttributeAccessIssue', 'attribute does not exist on the type'],
  ['reportCallIssue', 'call does not match the signature'],
  ['reportArgumentType', 'argument type does not match the parameter'],
  ['reportIndexIssue', 'type does not support this indexing'],
  ['reportNoOverloadImplementation', 'no overload matches this call'],
  ['reportRedeclaration', 'redeclared with a different type'],
  ['reportUndefinedVariable', 'name is not defined'],
])

export type PyrightDiagnostic = {
  file: string
  line: number
  column: number
  rule: string
  message: string
  meaning: string
}

type RawDiagnostic = {
  file?: string
  severity?: string
  message?: string
  rule?: string
  range?: { start?: { line?: number; character?: number } }
}

type Command = { cmd: string; prefix: string[] }

/**
 * Where pyright might be — on PATH, put there by whoever runs this.
 *
 * Deliberately not the reviewed repository's `node_modules`. Resolving it there let a
 * repository supply the binary that reviews it, which is arbitrary code execution
 * dressed as a dev dependency, and it happens before a single finding is reported.
 */
const CANDIDATES: Command[] = [
  { cmd: 'pyright', prefix: [] },
  { cmd: 'basedpyright', prefix: [] },
]

let resolved: Command | null | undefined

export function pyrightCommand(root: string): Command | undefined {
  if (resolved !== undefined) return resolved ?? undefined
  for (const candidate of CANDIDATES) {
    try {
      execFileSync(candidate.cmd, [...candidate.prefix, '--version'], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 30_000,
      })
      resolved = candidate
      return candidate
    } catch {
      // try the next place it could live
    }
  }
  resolved = null
  return undefined
}

export function pyrightAvailable(root: string): boolean {
  return pyrightCommand(root) !== undefined
}

/**
 * Run pyright over the given files and keep only the diagnostics that mean something
 * was invented. Type-strictness complaints are deliberately not reported: a review
 * that argues about optional-ness on every line is a review nobody reads.
 */
export function pyrightDiagnostics(root: string, files: string[]): PyrightDiagnostic[] {
  if (files.length === 0) return []

  const command = pyrightCommand(root)
  if (!command) return []

  let raw: string
  try {
    raw = decode(
      execFileSync(command.cmd, [...command.prefix, '--outputjson', ...files], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        // pyright exits non-zero when it finds anything, which is the normal case
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 180_000,
      }),
    )
  } catch (e) {
    const err = e as { stdout?: Buffer; status?: number | null; signal?: string | null }
    // pyright exits non-zero whenever it finds something, which is the normal case and
    // still writes its report. What is not normal is dying without one: killed by a
    // signal, or out of time. Returning [] there would report "nothing found" about a
    // checker that never looked, so it is raised and becomes a recorded failure.
    // an empty Buffer is truthy, which is how the first attempt at this check missed
    // the very case it was written for
    if (!err.stdout || err.stdout.length === 0) {
      throw new Error(
        err.signal
          ? 'pyright was killed by ' + err.signal
          : 'pyright could not run (' + (err.status ?? 'no exit code') + ')',
      )
    }
    raw = decode(err.stdout)
  }

  let parsed: { generalDiagnostics?: RawDiagnostic[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const out: PyrightDiagnostic[] = []
  for (const d of parsed.generalDiagnostics ?? []) {
    if (d.severity !== 'error') continue
    const meaning = d.rule ? HALLUCINATION_RULES.get(d.rule) : undefined
    if (!meaning || !d.file) continue
    out.push({
      file: d.file,
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      rule: d.rule ?? '',
      message: (d.message ?? '').split('\n')[0] ?? '',
      meaning,
    })
  }
  return out
}
