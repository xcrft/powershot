import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.js'
import { SEVERITIES, type Severity } from './types.js'

export type Config = {
  provider: 'anthropic' | 'openai' | 'gemini'
  model: string
  verifiers: string[] // check names, or ['*']
  judges: string[]
  minSeverity: Severity
  ignore: string[]
  /** Portable runs use self-contained oracles; strict runs require enriched semantic oracles too. */
  coverage: 'portable' | 'strict'
  /** mark the system prompt and tools cacheable (Anthropic); set false to opt out */
  promptCache: boolean
}

const DEFAULTS: Config = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  verifiers: ['*'],
  // security may duplicate SAST; convention needs repository idioms in the diff
  judges: ['plausible-logic', 'test-adequacy', 'intent'],
  minSeverity: 'low',
  coverage: 'portable',
  // findings in vendored trees are not decisions made by this repository
  ignore: [
    '**/node_modules/**', '**/dist/**', '**/build/**', '**/*.generated.*', '**/*.min.js',
    '**/vendor/**', '**/vendored/**', '**/third_party/**', '**/Pods/**',
    '**/.venv/**', '**/venv/**', '**/site-packages/**', '**/target/debug/**', '**/target/release/**',
  ],
  promptCache: true,
}

const FILE = 'powershot.config.json'

function atRef(root: string, ref: string): string | undefined {
  try {
    return git(root, ['show', ref + ':' + FILE], true)
  } catch {
    return undefined // no policy at that ref is the same as the default one
  }
}

export function policyChanged(root: string, baseRef: string): boolean {
  const path = join(root, FILE)
  const head = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  return (atRef(root, baseRef) ?? '') !== (head ?? '')
}

const KEYS = new Set([...Object.keys(DEFAULTS), 'checks'])
const PROVIDERS = new Set(['anthropic', 'openai', 'gemini'])
const COVERAGE = new Set(['portable', 'strict'])

/** A misspelled name in the config is the quietest way to get a clean review. */
export function validateConfig(raw: Record<string, unknown>, known: { verifiers: string[]; judges: string[] }): string[] {
  const problems: string[] = []
  const suggest = (name: string, from: string[]): string => {
    const near = from.find((k) => k.startsWith(name.slice(0, 4)) || name.startsWith(k.slice(0, 4)))
    return near ? ' — did you mean ' + near + '?' : ' — known: ' + from.join(', ')
  }

  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) problems.push('unknown setting "' + key + '"' + suggest(key, [...KEYS]))
  }
  if (raw.provider !== undefined && !PROVIDERS.has(String(raw.provider))) {
    problems.push('provider "' + String(raw.provider) + '" is not one of: ' + [...PROVIDERS].join(', '))
  }
  if (raw.minSeverity !== undefined && !SEVERITIES.includes(raw.minSeverity as Severity)) {
    problems.push('minSeverity "' + String(raw.minSeverity) + '" is not one of: ' + SEVERITIES.join(', '))
  }
  if (raw.coverage !== undefined && !COVERAGE.has(String(raw.coverage))) {
    problems.push('coverage "' + String(raw.coverage) + '" is not one of: ' + [...COVERAGE].join(', '))
  }
  for (const [field, names] of [['verifiers', known.verifiers], ['judges', known.judges]] as const) {
    const value = (raw as Record<string, any>)[field]
    if (value === undefined) continue
    // a bare string reaches `enabled()` as a string, whose `includes` matches
    // substrings — so "security" would quietly enable a judge named "secur"
    const list: unknown = Array.isArray(value) ? value : value?.enable
    if (!Array.isArray(list)) {
      problems.push(field + ' must be a list of names, or { "enable": [...] }')
      continue
    }
    for (const name of list) {
      if (name !== '*' && !names.includes(String(name))) {
        problems.push('no ' + field.slice(0, -1) + ' named "' + String(name) + '"' + suggest(String(name), names))
      }
    }
  }
  return problems
}

/**
 * The policy a review is judged under.
 *
 * `baseRef` is what stops a change from relaxing the gate that is judging it. The
 * config is a file in the repository, so a pull request can set `ignore: ["**"]`,
 * empty the check list, or raise `minSeverity`, and obtain a clean required check
 * from its own edit. Read from the base instead, a policy change takes effect once
 * it has been reviewed — like every other change. Workspace runs pass no base.
 */
export function loadConfig(
  root: string,
  known?: { verifiers: string[]; judges: string[] },
  baseRef?: string,
): Config {
  const path = join(root, FILE)
  const text = baseRef === undefined ? (existsSync(path) ? readFileSync(path, 'utf8') : undefined) : atRef(root, baseRef)
  if (text === undefined) return DEFAULTS
  let raw: Record<string, any>
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error('powershot.config.json is not valid JSON: ' + (e as Error).message)
  }
  if (known) {
    const problems = validateConfig(raw, known)
    if (problems.length > 0) {
      throw new Error('powershot.config.json:\n  ' + problems.join('\n  '))
    }
  }
  return {
    ...DEFAULTS,
    ...raw,
    verifiers: raw.verifiers?.enable ?? raw.verifiers ?? DEFAULTS.verifiers,
    judges: raw.judges?.enable ?? raw.judges ?? DEFAULTS.judges,
  }
}

export function enabled(list: string[], name: string): boolean {
  return list.includes('*') || list.includes(name)
}

/**
 * Minimal glob: `**` and `*` only, which is all an ignore pattern needs.
 *
 * A globstar before a slash matches zero directories as well as many, the way every
 * other glob reads it. Without that, a globstar-slash-vendor pattern covered a nested
 * vendor tree and missed one at the repository root, which is where most of them are.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const source =
      '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '<<dirs>>')
        .replace(/\*\*/g, '<<any>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<dirs>>/g, '(?:[^/]*\\/)*')
        .replace(/<<any>>/g, '.*') +
      '$'
    return new RegExp(source).test(path)
  })
}
