import type { Project, SourceFile } from 'ts-morph'

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

/** `verified` came from an oracle and cost no tokens. `judged` came from the model. */
export type FindingClass = 'verified' | 'judged'

/**
 * `proven` only when the oracle answered the exact question the finding asks.
 * "This key is in no manifest" is proven; "it will be undefined at runtime" is not.
 */
export type Confidence = 'proven' | 'firm' | 'tentative'

export type Finding = {
  id: string
  class: FindingClass
  check: string
  severity: Severity
  confidence: Confidence
  file: string
  line: number
  title: string
  evidence?: { oracle: string; detail: string }
  fix?: string
  /** 1-based column and width */
  span?: { column: number; length: number }
  replacement?: string
  /** how a judged finding's line was justified: the model saw it changed, or nearby */
  positioning?: 'added' | 'context'
  /** the whole line with `replacement` applied — what a reviewer would commit */
  suggestion?: string
  /** `caret` is already dedent-adjusted, so the renderer just counts characters */
  frame?: { firstLine: number; lines: string[]; caret?: { offset: number; length: number } }
}

export type ChangedFile = {
  path: string
  /** Repository path at the base ref when Git detected a rename or copy. */
  beforePath?: string
  /** The path has no current source to review, but its removal still affects proofs. */
  deleted?: boolean
  added: Set<number>
  /** undefined for a newly added file */
  before?: string
}

/** A changed file in a language the TypeScript compiler cannot read. */
export type ForeignFile = {
  path: string
  pack: import('./lang/packs.js').LanguagePack
  tree: import('./lang/packs.js').Tree
  beforeTree?: import('./lang/packs.js').Tree
  changed: ChangedFile
}

export type Ground = {
  root: string
  /** Deduplicated source closure of only the TypeScript projects relevant to the change. */
  sourceFiles: SourceFile[]
  /** Repo-relative configs selected for changed files; empty means syntax-only. */
  configFiles: string[]
  /** syntax-only, holding the base-ref version of each changed file */
  beforeProject: Project
  changed: ChangedFile[]
  /** Complete diff inventory, including policy-waived and deleted paths. */
  inventory?: ChangedFile[]
  /** `typed` is per file: a configured project supplies a resolved ambient environment */
  files: { sf: SourceFile; changed: ChangedFile; before?: SourceFile; typed: boolean }[]
  /** normalized name -> where a token-identical callable already lives */
  symbolIndex: Map<string, { file: string; name: string; line: number; fingerprint: string; existedInBase: boolean; scope: string }[]>
  deps: Set<string>
  /** walks up through workspace manifests: a monorepo declares deps per package */
  depsFor: (absPath: string) => Set<string>
  /** true when at least one changed file has a complete configured type environment */
  typed: boolean
  /** `compilerOptions.paths` prefixes — look like packages, resolve inside the repo */
  internalPrefixes: string[]
  foreign: ForeignFile[]
  envManifest?: { keys: Set<string>; file: string }
}

/**
 * What a check needs from the ground before it can answer.
 *
 * Declared rather than discovered: a verifier that quietly returns nothing when its
 * oracle is absent is indistinguishable from one that ran and found nothing, and the
 * difference is the whole contract. The orchestrator skips what it cannot supply and
 * records the skip, so "no findings" never covers for "never ran".
 */
export type Capability =
  /** a parse tree for the file — every language has one */
  | 'syntax'
  /** the TypeScript checker, which needs a tsconfig that owns the file */
  | 'types'
  /** pyright, which is optional and often absent — a separate question entirely */
  | 'python-types'
  /** a reference graph that can answer "what else names this" */
  | 'references'
  /** the base-ref version of each changed file, for before/after comparison */
  | 'base'

export type Verifier = {
  /**
   * Unique. `name` is what a finding is labelled with, and twelve of them are shared
   * by a TypeScript check and its tree-sitter twin — which made the run record say a
   * check both ran and was skipped, with no way to tell which half did what.
   */
  id?: string
  name: string
  /** Which files this oracle can inspect. Prevents an absent language from becoming a skip. */
  domain?: 'typescript' | 'foreign' | 'python'
  /**
   * Which foreign files have the language feature this check needs.
   *
   * A pack can parse a language without knowing its test conventions, dependency
   * manifests or documentation syntax. Keeping that distinction here prevents a
   * parse tree from being reported as proof that every foreign check ran.
   */
  supports?: (file: ForeignFile) => boolean
  /** the check does not run, and says so, when any of these is unavailable */
  needs: Capability[]
  /** one oracle per verifier; findings must be defensible without a model */
  run(g: Ground): Finding[]
}
