/**
 * One runnable check. Every verifier is asserted in BOTH directions: it must fire
 * on the defect, and stay silent on the clean version. A verifier that only ever
 * fires is a rubber stamp.
 */
import assert from 'node:assert/strict'
import { Project } from 'ts-morph'
import type { ChangedFile, Finding, Ground, Verifier } from './types.js'
import { phantomApi, phantomDep, reinvented, droppedGuard, swallowedError, vacuousTest, assertionDrift, scopeCreep, contractDrift, copyPasteDrift, deadOnArrival, lyingComment } from './verifiers/index.js'
import { extractJsonArray, endpoint } from './judges/llm.js'
import { matchesAny, validateConfig } from './config.js'
import { titleOverlap } from './review.js'
import { caretFor, validateSuggestion } from './position.js'
import { parseFindings } from './judges/judge.js'
import { JUDGES, COMMON } from './judges/prompts.js'
import { bundle, groupKey, uncovered } from './bundle.js'
import { Session } from './session.js'
import { Dismissals, lastReport, rememberReport } from './dismissed.js'
import { JudgeCache } from './cache.js'
import { scanPaths } from './scan.js'
import { checkRange, collectChanges } from './git.js'
import { stripControl } from './text.js'
import { review } from './review.js'
import { withTargetTree } from './snapshot.js'
import { loadConfig } from './config.js'
import { execFileSync } from 'node:child_process'
import { insideRepo, repoPath } from './fspolicy.js'
import { Budget, parseLimits } from './budget.js'
import { SelectionPlan, capabilitiesOf } from './plan.js'
import { RunManifest, SCHEMA, coverageProblems } from './manifest.js'
import { ProviderError, redact } from './judges/llm.js'
import { VERIFIERS } from './verifiers/index.js'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { runTool } from './judges/tools.js'
import { codeQuality } from './report/codequality.js'
import { viewer } from './report/viewer.js'
import { absorbDelegated, delegateBrief } from './delegate.js'
import { TARGETS, findTarget } from './agents.js'
import { packFor } from './lang/packs.js'
import { isPhantom, pythonManifest, localModules } from './lang/python-deps.js'
import { isPhantomGem, rubyManifest } from './lang/ruby-deps.js'
import { pyrightAvailable } from './lang/pyright.js'
import { decode, lines as splitLines, stripCR } from './text.js'
import { parseAddedLines } from './git.js'
import { terminal } from './report/terminal.js'
import { compact } from './report/compact.js'
import { apiKey } from './judges/llm.js'
import { sarif } from './report/sarif.js'
import { markdown } from './report/markdown.js'
import { wrap } from './report/terminal.js'
import { highlight, isJsx } from './report/highlight.js'
import { normalizeName, readEnvManifest, relPath } from './ground.js'
import { incompleteReasons } from './bench.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-meta.js'
import {
  addedLinesFromPatch,
  createReviewPayload,
  GitHubPullRequestApi,
  inlineMarker,
  parseReviewFindings,
  reconcileInlineComments,
  selectInlineComments,
  syncInlineComments,
  type ExistingReviewComment,
  type PullRequestApi,
} from './github/inline-comments.js'

const root = '/repo'

/** Build a Ground by hand so verifiers are testable without git or a real repo. */
function ground(files: { path: string; after: string; before?: string }[], deps: string[] = []): Ground {
  const project = new Project({ useInMemoryFileSystem: true })
  const beforeProject = new Project({ useInMemoryFileSystem: true })

  const changed: ChangedFile[] = []
  const entries: Ground['files'] = []

  for (const f of files) {
    const sf = project.createSourceFile(root + '/' + f.path, f.after, { overwrite: true })
    const lineCount = f.after.split('\n').length
    const c: ChangedFile = {
      path: f.path,
      added: new Set(Array.from({ length: lineCount }, (_, i) => i + 1)),
      before: f.before,
    }
    changed.push(c)
    entries.push({
      sf,
      changed: c,
      before: f.before === undefined ? undefined : beforeProject.createSourceFile('/before/' + f.path, f.before, { overwrite: true }),
      typed: true,
    })
  }

  const symbolIndex: Ground['symbolIndex'] = new Map()
  for (const sf of project.getSourceFiles()) {
    const rel = sf.getFilePath().slice(root.length + 1)
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const decl = decls[0]
      if (!decl) continue
      const key = normalizeName(name)
      const list = symbolIndex.get(key) ?? []
      list.push({ file: rel, name, line: decl.getStartLineNumber() })
      symbolIndex.set(key, list)
    }
  }

  return { root, project, beforeProject, changed, files: entries, symbolIndex, deps: new Set(deps), depsFor: () => new Set(deps), typed: false, internalPrefixes: [], foreign: [] }
}

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures++
    console.log('  FAIL ' + name + '\n       ' + (e as Error).message)
  }
}

/** The same, for a check that has to run the real pipeline rather than one verifier. */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures++
    console.log('  FAIL ' + name + '\n       ' + (e as Error).message)
  }
}

function fires(v: Verifier, g: Ground): boolean {
  return v.run(g).length > 0
}

console.log('\nphantom-dep')
check('fires on an import that is not a declared dependency', () => {
  const g = ground([{ path: 'a.ts', after: "import ky from 'ky'\nexport const x = ky\n" }], ['zod'])
  const found = phantomDep.run(g)
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /"ky"/)
  assert.equal(found[0]!.confidence, 'proven')
})
check('silent on a declared dependency', () => {
  const g = ground([{ path: 'a.ts', after: "import { z } from 'zod'\nexport const x = z\n" }], ['zod'])
  assert.equal(fires(phantomDep, g), false)
})
check('silent on node builtins and relative imports', () => {
  const g = ground([{ path: 'a.ts', after: "import fs from 'node:fs'\nimport path from 'path'\nimport { y } from './b.js'\nexport const x = [fs, path, y]\n" }], ['zod'])
  assert.equal(fires(phantomDep, g), false)
})
check('silent on native package imports', () => {
  const g = ground([{ path: 'a.ts', after: "import '#app/start.js'\nexport const x = import('#app/runtime.js')\n" }], ['zod'])
  assert.equal(fires(phantomDep, g), false)
})
check('resolves a scoped subpath to its package', () => {
  const g = ground([{ path: 'a.ts', after: "import x from '@scope/pkg/deep/path'\nexport const y = x\n" }], ['@scope/pkg'])
  assert.equal(fires(phantomDep, g), false)
})

console.log('\nreinvented')
check('fires when a helper already exists elsewhere', () => {
  const g = ground([
    { path: 'lib/currency.ts', after: 'export function formatMinorUnits(n: number) { return n / 100 }\n' },
    { path: 'utils/money.ts', after: 'export function formatMinorUnits(n: number) { return n / 100 }\n' },
  ])
  const found = reinvented.run(g)
  assert.ok(found.length >= 1, 'expected a duplication finding')
  assert.equal(found[0]!.confidence, 'firm') // heuristic, never claims `proven`
})
check('silent on a genuinely new name', () => {
  const g = ground([
    { path: 'lib/currency.ts', after: 'export function formatMinorUnits(n: number) { return n / 100 }\n' },
    { path: 'utils/tax.ts', after: 'export function computeVatRate(n: number) { return n * 0.2 }\n' },
  ])
  assert.equal(fires(reinvented, g), false)
})
check('silent on short and generic names', () => {
  const g = ground([
    { path: 'a/render.ts', after: 'export function render() { return 1 }\n' },
    { path: 'b/render.ts', after: 'export function render() { return 2 }\n' },
  ])
  assert.equal(fires(reinvented, g), false)
})

console.log('\ndropped-guard')
check('fires when an early-return guard disappears', () => {
  const before = 'export function close(inv: any) {\n  if (!inv.customer) return null\n  return inv.total\n}\n'
  const after = 'export function close(inv: any) {\n  return inv.total\n}\n'
  const g = ground([{ path: 'close.ts', after, before }])
  const found = droppedGuard.run(g)
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /!inv\.customer/)
})
check('fires when a throwing guard disappears', () => {
  const before = 'export function pay(a: any) {\n  if (a <= 0) { throw new Error("bad") }\n  return a\n}\n'
  const after = 'export function pay(a: any) {\n  return a\n}\n'
  assert.equal(fires(droppedGuard, ground([{ path: 'pay.ts', after, before }])), true)
})
check('silent when the guard is kept, even if reformatted', () => {
  const before = 'export function close(inv: any) {\n  if (!inv.customer) return null\n  return inv.total\n}\n'
  const after = 'export function close(inv: any) {\n  if (!inv.customer)\n    return null\n  return inv.total * 2\n}\n'
  assert.equal(fires(droppedGuard, ground([{ path: 'close.ts', after, before }])), false)
})
check('silent when a rewrite respells the same guard for a new type', () => {
  // found by bench on a real repo: `pool` went from array to number, so
  // `pool.length === 0` became `pool === 0` — a rewrite, not a removal
  const before = 'export function check(pool: any[]) {\n  if (pool.length === 0) return null\n  return pool\n}\n'
  const after = 'export function check(pool: number) {\n  if (pool === 0) return null\n  return pool\n}\n'
  assert.equal(fires(droppedGuard, ground([{ path: 'c.ts', after, before }])), false)
})
check('silent when the guard became obsolete with the code it protected', () => {
  // found by bench: formatWeight moved from ounces to grams, so the old guards
  // referenced locals the rewritten function no longer has
  const before = 'export function fmt(totalOunces: number) {\n  const pounds = totalOunces / 16\n  if (pounds === 0) return "0"\n  return String(pounds)\n}\n'
  const after = 'export function fmt(grams: number) {\n  return String(grams / 1000)\n}\n'
  assert.equal(fires(droppedGuard, ground([{ path: 'c.ts', after, before }])), false)
})
check('silent for a new file, which cannot have dropped anything', () => {
  const after = 'export function close(inv: any) {\n  return inv.total\n}\n'
  assert.equal(fires(droppedGuard, ground([{ path: 'close.ts', after }])), false)
})

console.log('\nvacuous-test')
check('fires on a test that asserts nothing', () => {
  const src = "import { close } from './close.js'\nit('closes the invoice', () => {\n  close({})\n})\n"
  const found = vacuousTest.run(ground([{ path: 'close.test.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /asserts nothing/)
})
check('silent on a test that does assert', () => {
  const src = "import { close } from './close.js'\nit('closes the invoice', () => {\n  expect(close({})).toBe(1)\n})\n"
  assert.equal(fires(vacuousTest, ground([{ path: 'close.test.ts', after: src }])), false)
})
check('fires when the test mocks the module under test', () => {
  const src = "import { close } from './close.js'\nvi.mock('./close.js')\nit('works', () => {\n  expect(close({})).toBe(1)\n})\n"
  const found = vacuousTest.run(ground([{ path: 'close.test.ts', after: src }]))
  assert.ok(
    found.some((f) => /mocks/.test(f.title)),
    'expected a mocked-unit-under-test finding',
  )
})
check('silent when the test mocks a dependency rather than its subject', () => {
  // found by bench: mocking a collaborator you also import is ordinary practice —
  // only the module the test file is named after counts as the unit under test
  const src =
    "import { toast } from '@lakeside/ui-sdk'\nimport { useThing } from './useThing.js'\n" +
    "vi.mock('@lakeside/ui-sdk')\nit('works', () => {\n  expect(useThing()).toBe(1)\n})\n"
  const found = vacuousTest.run(ground([{ path: 'useThing.test.ts', after: src }]))
  assert.equal(found.filter((f) => /mocks/.test(f.title)).length, 0)
})
check('ignores files that are not tests', () => {
  const src = "it('not really a test file', () => { doThing() })\n"
  assert.equal(fires(vacuousTest, ground([{ path: 'src/app.ts', after: src }])), false)
})

console.log('\nswallowed-error')
check('fires on an empty catch block', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) {}\n}\n'
  const found = swallowedError.run(ground([{ path: 'a.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'proven')
  assert.match(found[0]!.title, /Empty catch/)
})
check('fires on a catch that only logs', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) { console.error(e) }\n}\n'
  const found = swallowedError.run(ground([{ path: 'a.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'firm') // a top-level log-only handler can be correct
  assert.match(found[0]!.title, /only logs/)
})
check('fires on an empty .catch() handler', () => {
  const src = 'export function f() {\n  fetchThing().catch(() => {})\n}\n'
  const found = swallowedError.run(ground([{ path: 'a.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /Empty \.catch/)
})
check('silent when the catch rethrows', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) { throw e }\n}\n'
  assert.equal(fires(swallowedError, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent when the catch logs and then rethrows', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) { console.error(e); throw e }\n}\n'
  assert.equal(fires(swallowedError, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent when the catch recovers with real work', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) { return fallback() }\n}\n'
  assert.equal(fires(swallowedError, ground([{ path: 'a.ts', after: src }])), false)
})
check('respects a comment as a deliberate ignore', () => {
  const src = 'export function f() {\n  try { risky() } catch (e) { /* offline is fine here */ }\n}\n'
  assert.equal(fires(swallowedError, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent on .catch(handler) that names a real function', () => {
  const src = 'export function f() {\n  fetchThing().catch(reportError)\n}\n'
  assert.equal(fires(swallowedError, ground([{ path: 'a.ts', after: src }])), false)
})

console.log('\nassertion-drift')
check('fires when an expectation is edited under a stable subject', () => {
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { expect(add(2,2)).toBe(5) })\n"
  const found = assertionDrift.run(ground([{ path: 'a.test.ts', after, before }]))
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'firm')  // updating an expectation can be legitimate
  assert.match(found[0]!.title, /from 4 to 5/)
})
check('rates it high when no source file changed in the diff', () => {
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { expect(add(2,2)).toBe(5) })\n"
  const found = assertionDrift.run(ground([{ path: 'a.test.ts', after, before }]))
  assert.equal(found[0]!.severity, 'high')
})
check('silent when the test itself was rewritten, not merely bent', () => {
  // narrowed after bench: a "add tests" commit legitimately reshapes existing tests,
  // and only an otherwise-identical test signals an expectation bent to fit the code
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { const r = add(2,2); expect(r).toBe(5) })\n"
  assert.equal(fires(assertionDrift, ground([{ path: 'a.test.ts', after, before }])), false)
})
check('silent when the module under test changed too', () => {
  // narrowed after bench: an expectation moving alongside a change to the module it
  // covers is a deliberate behaviour change, not a bent test
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { expect(add(2,2)).toBe(5) })\n"
  const found = assertionDrift.run(
    ground([
      { path: 'add.test.ts', after, before },
      { path: 'add.ts', after: 'export const add = (a: number, b: number) => a + b + 1\n', before: 'export const add = (a: number, b: number) => a + b\n' },
    ]),
  )
  assert.equal(found.length, 0)
})
check('still fires when an unrelated module changed', () => {
  // a large change may edit one module and bend a test that covers a different one
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { expect(add(2,2)).toBe(5) })\n"
  const found = assertionDrift.run(
    ground([
      { path: 'add.test.ts', after, before },
      { path: 'unrelated.ts', after: 'export const x = 2\n', before: 'export const x = 1\n' },
    ]),
  )
  assert.equal(found.length, 1)
})
check('silent when the assertion is untouched', () => {
  const src = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  assert.equal(fires(assertionDrift, ground([{ path: 'a.test.ts', after: src, before: src }])), false)
})
check('silent on a brand new assertion', () => {
  const before = "it('adds', () => { expect(add(2,2)).toBe(4) })\n"
  const after = "it('adds', () => { expect(add(2,2)).toBe(4) })\nit('subs', () => { expect(sub(2,2)).toBe(0) })\n"
  assert.equal(fires(assertionDrift, ground([{ path: 'a.test.ts', after, before }])), false)
})
check('tracks node assert.equal too', () => {
  const before = "it('adds', () => { assert.equal(add(2,2), 4) })\n"
  const after = "it('adds', () => { assert.equal(add(2,2), 5) })\n"
  assert.equal(fires(assertionDrift, ground([{ path: 'a.test.ts', after, before }])), true)
})
check('ignores non-test files', () => {
  const before = "it('x', () => { expect(a).toBe(1) })\n"
  const after = "it('x', () => { expect(a).toBe(2) })\n"
  assert.equal(fires(assertionDrift, ground([{ path: 'src/app.ts', after, before }])), false)
})

console.log('\nbundling')
check('keeps files that import one another in the same unit', () => {
  const g = ground([
    { path: 'core.ts', after: 'export function core(n: number) { return n }\n' },
    { path: 'user.ts', after: "import { core } from './core.js'\nexport const go = () => core(1)\n" },
  ])
  const units = bundle(g, 10_000)
  assert.equal(units.length, 1, 'linked files must share a unit')
})
check('splits when one unit would exceed the prompt budget', () => {
  const big = (name: string) => ({
    path: name,
    after: 'export const ' + name.replace('.ts', '') + ' = [\n' + Array.from({ length: 60 }, (_, i) => '  ' + i + ',').join('\n') + '\n]\n',
  })
  const g = ground([big('a.ts'), big('b.ts'), big('c.ts')])
  const units = bundle(g, 250)
  assert.ok(units.length > 1, 'expected the change to be split')
})
check('a language without an import graph still groups by what its paths encode', () => {
  const same = (a: string, b: string) => groupKey(a) === groupKey(b)
  // a header and its implementation are the pair a contract-drift judge needs at once
  assert.ok(same('src/net.h', 'src/net.c'))
  assert.ok(same('a/util.hpp', 'a/util.cpp'))
  // a module and the tests that cover it argue about the same behaviour
  assert.ok(same('pkg/svc.py', 'pkg/test_svc.py'))
  assert.ok(same('pkg/svc.py', 'pkg/svc_test.py'))
  assert.ok(same('a/lib.rs', 'a/lib_test.rs'))
  // a package is the unit in Go and Java, where a file name means less
  assert.ok(same('api/handler.go', 'api/router.go'))
  assert.ok(same('m/A.java', 'm/B.java'))
  // and two unrelated Rust modules are not one conversation
  assert.ok(!same('a/one.rs', 'a/two.rs'))
})
check('cuts a file too large for one prompt into several units, losing nothing', () => {
  const g = ground([{ path: 'big.ts', after: Array.from({ length: 900 }, (_, i) => 'export const v' + i + ' = ' + i).join('\n') + '\n' }])
  const units = bundle(g, 10_000)
  const chunks = units.flatMap((u) => u.files)
  assert.ok(chunks.length > 1, 'a 900-line change must not be one unit')
  const all = g.files[0]!.changed.added.size
  const covered = new Set(chunks.flatMap((c) => [...c.added]))
  assert.equal(covered.size, all, 'every added line must reach a judge')
  assert.equal(chunks.reduce((n, c) => n + c.added.size, 0), all, 'no line may be sent twice')
  assert.deepEqual(uncovered(g, units), [])
})
check('packs unrelated small components together rather than one unit each', () => {
  const g = ground([
    { path: 'a.ts', after: 'export const a = 1\n' },
    { path: 'b.ts', after: 'export const b = 2\n' },
    { path: 'c.ts', after: 'export const c = 3\n' },
  ])
  // unrelated but tiny: every extra unit is an extra bill
  assert.equal(bundle(g, 10_000).length, 1)
})

console.log('\nagent tools')
const toolGround = ground([{ path: 'money.ts', after: 'export function formatCents(n: number) { return n / 100 }\n' }])

check('grep finds code in the repository', () => {
  const out = runTool(toolGround, 'grep', { pattern: 'formatCents' })
  assert.match(out, /money\.ts:1/)
})
check('references reports where a symbol is used', () => {
  const out = runTool(toolGround, 'references', { symbol: 'formatCents' })
  assert.match(out, /formatCents/)
})
check('read_file refuses to escape the repository', () => {
  const out = runTool(toolGround, 'read_file', { path: '../../../etc/passwd' })
  assert.match(out, /Refused/)
})
check('read_file refuses secrets even inside the repository', () => {
  // reviewed code is untrusted input; containment lives in the tool layer
  for (const path of ['.env', '.env.production', 'certs/server.key', 'id_rsa', '.npmrc']) {
    assert.match(runTool(toolGround, 'read_file', { path }), /Refused/, path + ' should be refused')
  }
})
check('a symlink cannot carry a read out of the repository', () => {
  // resolve() normalises `..` but follows nothing — only the real path settles this
  const dir = mkdtempSync(join(tmpdir(), 'psh-sym-'))
  const outside = join(tmpdir(), 'psh-outside-' + Date.now() + '.txt')
  writeFileSync(outside, 'secret')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'real.ts'), 'export const x = 1\n')
  symlinkSync(outside, join(dir, 'src', 'linked.ts'))

  const g = { ...ground([{ path: 'src/real.ts', after: 'export const x = 1\n' }]), root: dir }
  assert.match(runTool(g, 'read_file', { path: 'src/linked.ts' }), /Refused/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { force: true })
})
check('an unknown tool is reported, not thrown', () => {
  assert.match(runTool(toolGround, 'rm_rf', {}), /Unknown tool/)
})
check('a broken regex is reported, not thrown', () => {
  assert.match(runTool(toolGround, 'grep', { pattern: '([' }), /valid regular expression/)
})

console.log('\nlanguages beyond TypeScript')
check('files are routed to the right language pack', () => {
  assert.equal(packFor('src/a.py')?.name, 'python')
  assert.equal(packFor('src/a.pyi')?.name, 'python')
  assert.equal(packFor('cmd/main.go')?.name, 'go')
  assert.equal(packFor('src/a.ts'), undefined) // TypeScript keeps its own oracle
  assert.equal(packFor('README.md'), undefined)
})

// Per-language pack checks live in langtest.ts, one process each: eleven wasm
// grammars cannot share a process without exhausting it. `npm test` runs both.

console.log('\neditor and provider surface')
check('compact output is the shape editors already parse', () => {
  const f: Finding = { id: 'F1', class: 'verified', check: 'phantom-dep', severity: 'high',
    confidence: 'proven', file: 'src/a.ts', line: 42, title: 'missing dep', span: { column: 9, length: 4 } }
  const line = compact([f]).trim()
  assert.equal(line, 'src/a.ts:42:9: error: missing dep [phantom-dep]')
  // the same regex the shipped VS Code task uses
  assert.ok(/^(.+?):(\d+):(\d+):\s+(error|warning|info):\s+(.*)$/.test(line))
})
check('compact maps severity onto the three levels editors understand', () => {
  const at = (severity: Finding['severity']): string => {
    const f: Finding = { id: 'F', class: 'verified', check: 'c', severity, confidence: 'proven',
      file: 'a.ts', line: 1, title: 't' }
    return compact([f]).split(': ')[1]!
  }
  assert.equal(at('critical'), 'error')
  assert.equal(at('high'), 'error')
  assert.equal(at('medium'), 'warning')
  assert.equal(at('low'), 'info')
})
check('compact defaults the column when a finding has no span', () => {
  const f: Finding = { id: 'F', class: 'judged', check: 'plausible-logic', severity: 'low',
    confidence: 'tentative', file: 'a.ts', line: 3, title: 'x' }
  assert.match(compact([f]), /^a\.ts:3:1: /)
})
check('each provider reads its own key', () => {
  const base = { model: 'm', verifiers: ['*'], judges: ['*'], minSeverity: 'low' as const,
    ignore: [], promptCache: true }
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY,
    g: process.env.GEMINI_API_KEY, gg: process.env.GOOGLE_API_KEY }
  process.env.ANTHROPIC_API_KEY = 'a'; process.env.OPENAI_API_KEY = 'o'
  delete process.env.GEMINI_API_KEY; process.env.GOOGLE_API_KEY = 'g'
  assert.equal(apiKey({ ...base, provider: 'anthropic' }), 'a')
  assert.equal(apiKey({ ...base, provider: 'openai' }), 'o')
  assert.equal(apiKey({ ...base, provider: 'gemini' }), 'g') // GOOGLE_API_KEY also works
  for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['OPENAI_API_KEY', saved.o],
    ['GEMINI_API_KEY', saved.g], ['GOOGLE_API_KEY', saved.gg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

console.log('\nreading foreign source')
check('a CRLF diff is parsed, not silently ignored', () => {
  // Without stripping CR, the captured path contains a character that Git rejects.
  // is "src/a.ts\r" and matches no file, so the whole review comes back empty
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,0 +2,2 @@', '+const x = 1']
    .join('\r\n')
  const parsed = parseAddedLines(diff)
  assert.deepEqual([...parsed.keys()], ['src/a.ts'])
  assert.deepEqual([...parsed.get('src/a.ts')!], [2, 3])
})
check('an LF diff still parses exactly as before', () => {
  const diff = ['+++ b/src/a.ts', '@@ -1 +1 @@', '+const x = 1'].join('\n')
  assert.deepEqual([...parseAddedLines(diff).get('src/a.ts')!], [1])
})
check('Git paths are read as NUL-delimited data and passed back literally', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-git-path-')))
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  }
  try {
    run('init', '-q', '.')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    // Windows forbids control characters, `:` and `*` in filenames. Keep the
    // strongest legal fixture on each platform while exercising the same NUL and
    // literal-path pipeline.
    const tracked = process.platform === 'win32' ? 'line ## heading.ts' : 'line\n## heading.ts'
    const untracked = process.platform === 'win32' ? '[literal].ts' : ':(glob)*.ts'
    const renamed = 'renamed.ts'
    writeFileSync(join(dir, tracked), Array.from({ length: 10 }, (_, i) => 'export const before' + i + ' = ' + i).join('\n') + '\n')
    run('add', '--', tracked)
    run('commit', '-qm', 'seed')
    run('mv', '--', tracked, renamed)
    writeFileSync(join(dir, renamed), Array.from({ length: 10 }, (_, i) => 'export const ' + (i === 9 ? 'after' : 'before' + i) + ' = ' + i).join('\n') + '\n')
    writeFileSync(join(dir, untracked), 'export const literal = 1\n')
    const changes = collectChanges(dir, {})
    const moved = changes.find((change) => change.path === renamed)
    assert.ok(moved?.before?.includes('before9'))
    assert.deepEqual([...moved!.added], [10])
    assert.ok(changes.some((change) => change.path === untracked))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('lines split on either ending', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c'])
  assert.equal(stripCR('a\r'), 'a')
  assert.equal(stripCR('a'), 'a')
})
check('bytes decode without throwing, whatever the encoding', () => {
  assert.equal(decode(Buffer.from('plain ascii')), 'plain ascii')
  assert.equal(decode(Buffer.from('héllo', 'utf8')), 'héllo')
  // a UTF-8 BOM is consumed rather than becoming a stray character
  assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x = 1')])), 'x = 1')
  // Latin-1: invalid UTF-8, must fall back rather than take the review down
  const latin = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9])])
  assert.equal(typeof decode(latin), 'string')
  assert.equal(decode(latin).length, 4)
})

console.log('\nincomplete reviews')
check('a review that did not complete never renders as clean', () => {
  // "Found nothing" and "could not look" must remain different outcomes.
  // are different answers, and only one of them should let a pipeline through
  const clean = terminal([], {
    subtitle: 'workspace', verified: 0, judged: 0, state: 'complete', notLookedAt: [],
  })
  assert.match(clean, /No findings\./)
  assert.equal(/not a verdict/.test(clean), false)

  const partial = terminal([], {
    subtitle: 'workspace', verified: 0, judged: 0, state: 'partial',
    notLookedAt: ['outside.ts (no types)'],
  })
  assert.match(partial, /partial, not a verdict/)
  assert.match(partial, /outside\.ts \(no types\)/)
})
check('findings are still shown when a stage failed, with the warning kept', () => {
  const f: Finding = { id: 'F1', class: 'verified', check: 'phantom-dep', severity: 'high',
    confidence: 'proven', file: 'a.ts', line: 1, title: 'missing dep' }
  const out = terminal([f], {
    subtitle: 'workspace', verified: 1, judged: 0, state: 'failed', notLookedAt: ['intent: timeout'],
  })
  assert.match(out, /missing dep/)
  assert.match(out, /review is failed/)
  assert.match(out, /intent: timeout/)
})

console.log('\nenv manifests')
check('a commented entry in a template documents an optional variable', () => {
  // found by reviewing our own commit: `# OPENAI_BASE_URL=` is how a template says
  // "this exists and may be left unset", so reading it as undeclared reports the
  // very file that documents it
  const dir = mkdtempSync(join(tmpdir(), 'psh-env-'))
  writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=x\n# OPTIONAL_TUNING=\n#export LEGACY_FLAG=1\n')
  const manifest = readEnvManifest(dir)
  assert.ok(manifest)
  assert.equal(manifest.keys.has('DATABASE_URL'), true)
  assert.equal(manifest.keys.has('OPTIONAL_TUNING'), true)
  assert.equal(manifest.keys.has('LEGACY_FLAG'), true)
  assert.equal(manifest.keys.has('NEVER_WRITTEN'), false) // still absent when truly absent
  rmSync(dir, { recursive: true, force: true })
})

console.log('\npython dependencies')
const pyManifest = { names: new Set(['requests', 'pyyaml', 'scikit-learn', 'python-dateutil']) }
const pyLocal = new Set(['helpers', 'app'])

check('the standard library needs no dependency', () => {
  for (const m of ['os', 'json', 'typing', 'asyncio', 'dataclasses', 'zoneinfo', 'tomllib', 'concurrent']) {
    assert.equal(isPhantom(m, pyManifest, pyLocal), false, m + ' is stdlib')
  }
})
check('a declared dependency is accounted for', () => {
  assert.equal(isPhantom('requests', pyManifest, pyLocal), false)
})
check('an import whose distribution is named differently is accounted for', () => {
  // the trap: depending on PyYAML while importing yaml. Reporting that would be
  // exactly the confidently-wrong answer this tool exists to avoid
  assert.equal(isPhantom('yaml', pyManifest, pyLocal), false)
  assert.equal(isPhantom('sklearn', pyManifest, pyLocal), false)
  assert.equal(isPhantom('dateutil', pyManifest, pyLocal), false)
})
check('a module living in this repository is accounted for', () => {
  assert.equal(isPhantom('helpers', pyManifest, pyLocal), false)
  assert.equal(isPhantom('helpers.util', pyManifest, pyLocal), false) // submodule of a local package
})
check('an import nothing installs is reported', () => {
  assert.equal(isPhantom('tensorflow', pyManifest, pyLocal), true)
  assert.equal(isPhantom('prefect', pyManifest, pyLocal), true)
})
check('manifest names are matched the way PyPI matches them', () => {
  const m = { names: new Set(['python-dateutil']) }
  // PyPI treats - _ . alike and ignores case, so all of these are the same package
  assert.equal(isPhantom('dateutil', m, new Set()), false)
})
check('no manifest means nothing to be wrong about', () => {
  assert.equal(pythonManifest('/definitely/not/a/repo'), undefined)
  assert.deepEqual(localModules('/definitely/not/a/repo'), new Set())
})

console.log('\nruby gems')
const gems = { names: new Set(['rails', 'httparty', 'sidekiq']) }
const rbLocal = new Set(['helpers', 'models'])

check('the standard library needs no gem', () => {
  for (const r of ['json', 'net/http', 'yaml', 'set', 'openssl', 'digest', 'fileutils']) {
    assert.equal(isPhantomGem(r, gems, rbLocal), false, r + ' is stdlib')
  }
})
check('a require provided by a declared gem is accounted for', () => {
  // the Rails trap: the Gemfile says `rails`, the code requires `active_record`
  assert.equal(isPhantomGem('active_record', gems, rbLocal), false)
  assert.equal(isPhantomGem('active_support/core_ext', gems, rbLocal), false)
  assert.equal(isPhantomGem('httparty', gems, rbLocal), false)
})
check("a require of this repository's own code is accounted for", () => {
  assert.equal(isPhantomGem('helpers', gems, rbLocal), false)
  assert.equal(isPhantomGem('models/user', gems, rbLocal), false)
})
check('a gem nothing declares is reported', () => {
  assert.equal(isPhantomGem('nokogiri', gems, rbLocal), true)
  assert.equal(isPhantomGem('faraday', gems, rbLocal), true)
})
check('no Gemfile means nothing to be wrong about', () => {
  assert.equal(rubyManifest('/definitely/not/a/repo'), undefined)
})

console.log('\npython semantics')
check('pyright is optional — its absence is answered, not guessed at', () => {
  // whichever way this machine is set up, the answer must be a boolean rather than
  // a throw: a missing checker means those findings simply do not exist
  assert.equal(typeof pyrightAvailable(process.cwd()), 'boolean')
})

console.log('\nintegrations')
const sample: Finding[] = [
  { id: 'F1', class: 'verified', check: 'phantom-dep', severity: 'high', confidence: 'proven',
    file: 'src/a.ts', line: 3, title: 'missing dep', evidence: { oracle: 'package.json', detail: 'not declared' } },
  { id: 'F2', class: 'judged', check: 'plausible-logic', severity: 'low', confidence: 'tentative',
    file: 'src/b.ts', line: 9, title: 'off by one' },
]

check('GitHub patches expose only added right-side lines for inline comments', () => {
  const patch = [
    '@@ -1,3 +1,4 @@',
    ' context',
    '-old',
    '+new',
    '+extra',
    ' tail',
    '@@ -20,0 +22,2 @@',
    '+later',
    '\\ No newline at end of file',
    '+latest',
  ].join('\n')
  assert.deepEqual([...addedLinesFromPatch(patch)], [2, 3, 22, 23])
})

check('inline review selects only proven medium-or-higher verified findings on added lines', () => {
  const finding = (overrides: Partial<Finding>): Finding => ({
    id: 'F', class: 'verified', check: 'phantom-dep', severity: 'high', confidence: 'proven',
    file: 'src/a.ts', line: 3, title: 'finding', ...overrides,
  })
  const findings = [
    finding({ id: 'critical', severity: 'critical', line: 4, title: 'critical finding' }),
    finding({ id: 'medium', severity: 'medium', line: 3, title: 'medium finding' }),
    finding({ id: 'context', line: 2 }),
    finding({ id: 'low', severity: 'low' }),
    finding({ id: 'judged', class: 'judged' }),
    finding({ id: 'firm', confidence: 'firm' }),
    finding({ id: 'other-file', file: 'src/missing.ts' }),
  ]
  const files = [{ filename: 'src/a.ts', patch: '@@ -2,1 +2,3 @@\n context\n+first\n+second' }]

  assert.deepEqual(selectInlineComments(findings, files).map((comment) => comment.line), [4, 3])
  assert.deepEqual(selectInlineComments(findings, files, 1).map((comment) => comment.line), [4])
  assert.deepEqual(selectInlineComments(findings, files, 0), [])

  const many = Array.from({ length: 12 }, (_, index) => finding({ line: index + 3, title: `finding ${index}` }))
  const manyPatch = '@@ -2,0 +3,12 @@\n' + many.map((_, index) => `+line ${index}`).join('\n')
  assert.equal(selectInlineComments(many, [{ filename: 'src/a.ts', patch: manyPatch }], 100).length, 10)
})

check('inline comment markdown renders finding prose literally and carries a stable marker', () => {
  const finding: Finding = {
    id: 'F1', class: 'verified', check: 'check`id', severity: 'high', confidence: 'proven',
    file: 'src/a.ts', line: 3, title: '@team <img src=x> [click](https://example.invalid)',
    evidence: { oracle: 'manifest', detail: 'line one\n> forged quote' },
  }
  const [comment] = selectInlineComments(
    [finding],
    [{ filename: finding.file, patch: '@@ -2,0 +3,1 @@\n+line' }],
  )
  assert.ok(comment)
  assert.equal(comment.body.includes('@team'), false)
  assert.equal(comment.body.includes('<img'), false)
  assert.equal(comment.body.includes('[click]('), false)
  assert.equal(comment.body.endsWith(inlineMarker(finding)), true)
  assert.equal(comment.body.match(/<!-- powershot:inline:/g)?.length, 1)
})

check('inline publishing rejects a malformed machine report instead of silently dropping it', () => {
  assert.deepEqual(parseReviewFindings(JSON.stringify({ findings: [sample[0]] })), [sample[0]])
  assert.throws(
    () => parseReviewFindings(JSON.stringify({ findings: [{ ...sample[0], line: 0 }] })),
    /invalid contract/,
  )
  assert.throws(() => parseReviewFindings('{}'), /findings array/)
})

check('inline reruns keep exact bot comments, batch only missing ones, and retire stale bot copies', () => {
  const findings: Finding[] = [
    { id: 'F1', class: 'verified', check: 'a', severity: 'critical', confidence: 'proven', file: 'a.ts', line: 1, title: 'one' },
    { id: 'F2', class: 'verified', check: 'b', severity: 'high', confidence: 'proven', file: 'b.ts', line: 2, title: 'two' },
  ]
  const desired = selectInlineComments(findings, [
    { filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+one' },
    { filename: 'b.ts', patch: '@@ -1,0 +2,1 @@\n+two' },
  ])
  const existing: ExistingReviewComment[] = [
    { id: 1, path: desired[0]!.path, line: desired[0]!.line, body: desired[0]!.body, user: { login: 'github-actions[bot]' } },
    { id: 2, path: desired[0]!.path, line: desired[0]!.line, body: desired[0]!.body, user: { login: 'github-actions[bot]' } },
    { id: 3, path: desired[0]!.path, line: desired[0]!.line, body: 'old\n' + inlineMarker(findings[0]!), user: { login: 'github-actions[bot]' } },
    { id: 4, path: desired[1]!.path, line: desired[1]!.line, body: desired[1]!.body, user: { login: 'human' } },
    { id: 5, path: desired[0]!.path, line: desired[0]!.line, body: 'discussion', user: { login: 'human' }, inReplyToId: 2 },
    { id: 6, path: desired[0]!.path, line: desired[0]!.line, body: 'discussed old\n' + inlineMarker(findings[0]!), user: { login: 'github-actions[bot]' } },
    { id: 7, path: desired[0]!.path, line: desired[0]!.line, body: 'still investigating', user: { login: 'human' }, inReplyToId: 6 },
  ]

  const plan = reconcileInlineComments(desired, existing)
  assert.equal(plan.kept, 1)
  assert.deepEqual(plan.create, [desired[1]])
  assert.deepEqual(plan.staleIds, [1, 3])

  const settled = reconcileInlineComments(desired, desired.map((comment, index) => ({
    id: index + 10, path: comment.path, line: comment.line, body: comment.body,
    user: { login: 'github-actions[bot]' },
  })))
  assert.deepEqual(settled, { create: [], staleIds: [], kept: 2 })
})

check('the batched GitHub review carries the required comment body and current commit', () => {
  const comment = { path: 'a.ts', line: 1, side: 'RIGHT' as const, body: 'finding' }
  const payload = createReviewPayload('a'.repeat(40), [comment])
  assert.equal(payload.commit_id, 'a'.repeat(40))
  assert.equal(payload.event, 'COMMENT')
  assert.match(payload.body, /1 proven verified finding/)
  assert.deepEqual(payload.comments, [comment])
})

await checkAsync('the GitHub client paginates files, submits the review contract, and treats delete 404 as settled', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string; body?: string }[] = []
  const json = (value: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(value), { status: 200, ...init })

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, body })
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token')

    if (url.endsWith('/pulls/7')) return json({ head: { sha: 'a'.repeat(40) } })
    if (url.includes('/pulls/7/files') && !url.includes('page=2')) {
      return json([{ filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+one' }], {
        headers: { link: '<https://api.github.test/repos/acme/repo/pulls/7/files?per_page=100&page=2>; rel="next"' },
      })
    }
    if (url.includes('/pulls/7/files') && url.includes('page=2')) {
      return json([{ filename: 'b.bin' }])
    }
    if (url.includes('/pulls/7/comments')) {
      return json([
        { id: 9, path: 'a.ts', line: 1, body: 'old', user: { login: 'github-actions[bot]' } },
        { id: 10, path: 'a.ts', line: 1, body: 'reply', in_reply_to_id: 9, user: { login: 'human' } },
      ])
    }
    if (method === 'POST' && url.endsWith('/pulls/7/reviews')) return json({ id: 1 })
    if (method === 'DELETE' && url.endsWith('/pulls/comments/9')) return json({ message: 'gone' }, { status: 404 })
    return json({ message: 'unexpected request' }, { status: 500 })
  }

  globalThis.fetch = fakeFetch
  try {
    const api = new GitHubPullRequestApi('https://api.github.test', 'token', 'acme', 'repo', 7)
    assert.equal(await api.headSha(), 'a'.repeat(40))
    assert.deepEqual(await api.listFiles(), [
      { filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+one' },
      { filename: 'b.bin', patch: undefined },
    ])
    const comments = await api.listReviewComments()
    assert.equal(comments[0]?.id, 9)
    assert.equal(comments[1]?.inReplyToId, 9)
    await api.createReview('a'.repeat(40), [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'finding' }])
    await api.deleteReviewComment(9)
  } finally {
    globalThis.fetch = originalFetch
  }

  const submitted = calls.find((call) => call.method === 'POST')
  assert.ok(submitted?.body)
  assert.deepEqual(JSON.parse(submitted.body), {
    commit_id: 'a'.repeat(40),
    body: 'PowerShot posted 1 proven verified finding(s) on changed lines.',
    event: 'COMMENT',
    comments: [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'finding' }],
  })
  assert.equal(calls.filter((call) => call.url.includes('/files')).length, 2)
})

await checkAsync('inline synchronization creates one review before removing stale comments', async () => {
  const finding: Finding = {
    id: 'F1', class: 'verified', check: 'a', severity: 'high', confidence: 'proven',
    file: 'a.ts', line: 1, title: 'one',
  }
  const events: string[] = []
  const api: PullRequestApi = {
    headSha: async () => 'a'.repeat(40),
    listFiles: async () => [{ filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+one' }],
    listReviewComments: async () => [{
      id: 7, path: 'old.ts', line: 1,
      body: 'old\n<!-- powershot:inline:v1:0123456789abcdef01234567 -->',
      user: { login: 'github-actions[bot]' },
    }],
    createReview: async (commitId, comments) => {
      events.push(`create:${commitId}:${comments.length}`)
    },
    deleteReviewComment: async (id) => {
      events.push(`delete:${id}`)
    },
  }

  const result = await syncInlineComments(api, [finding], 'a'.repeat(40))
  assert.deepEqual(events, [`create:${'a'.repeat(40)}:1`, 'delete:7'])
  assert.deepEqual(result, { outdated: false, desired: 1, created: 1, kept: 0, retired: 1 })
})

await checkAsync('inline synchronization makes no writes for an outdated pull request head', async () => {
  let reads = 0
  const api: PullRequestApi = {
    headSha: async () => 'b'.repeat(40),
    listFiles: async () => { reads++; return [] },
    listReviewComments: async () => { reads++; return [] },
    createReview: async () => { throw new Error('must not create') },
    deleteReviewComment: async () => { throw new Error('must not delete') },
  }

  const result = await syncInlineComments(api, [], 'a'.repeat(40))
  assert.equal(reads, 0)
  assert.deepEqual(result, { outdated: true, desired: 0, created: 0, kept: 0, retired: 0 })
})

await checkAsync('inline synchronization makes no writes when the pull request head changes during reads', async () => {
  let headReads = 0
  let writes = 0
  const api: PullRequestApi = {
    headSha: async () => ++headReads === 1 ? 'a'.repeat(40) : 'b'.repeat(40),
    listFiles: async () => [{ filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+one' }],
    listReviewComments: async () => [],
    createReview: async () => { writes++ },
    deleteReviewComment: async () => { writes++ },
  }

  const result = await syncInlineComments(api, [sample[0]!], 'a'.repeat(40))
  assert.equal(headReads, 2)
  assert.equal(writes, 0)
  assert.deepEqual(result, { outdated: true, desired: 0, created: 0, kept: 0, retired: 0 })
})

check('nested modules use the native package import map', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(manifest.imports?.['#app/*.js'], './dist/*.js')
  const pending = [join(process.cwd(), 'src')]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8')
        assert.doesNotMatch(source, /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]\.\.\//, path)
      }
    }
  }
})
check('runtime package metadata follows package.json', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(PACKAGE_NAME, manifest.name)
  assert.equal(PACKAGE_VERSION, manifest.version)
})
check('release smoke and publish consume the one packed artifact', () => {
  const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /tags: \['v\*\.\*\.\*'\]/)
  assert.equal(workflow.match(/npm pack --pack-destination/g)?.length, 1)
  assert.match(workflow, /npm run smoke -- "\$\{\{ steps\.artifact\.outputs\.tarball \}\}"/)
  assert.match(workflow, /npm publish "\.\/\$\{\{ steps\.artifact\.outputs\.tarball \}\}"/)
})
check('self-review publishes machine findings only for a complete verdict', () => {
  const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'review.yml'), 'utf8')
  assert.equal(workflow.match(/node "\$PSH" review/g)?.length, 1)
  assert.match(workflow, /name: Check out the untrusted review target[\s\S]+allow-unsafe-pr-checkout: true/)
  assert.match(workflow, /name: Install the target type environment[\s\S]+working-directory: target[\s\S]+npm ci --ignore-scripts/)
  assert.match(workflow, /steps\.review\.outputs\.status == '0' \|\| steps\.review\.outputs\.status == '1'/)
  assert.match(workflow, /sarif_file: powershot\.sarif\s+checkout_path: target\s+ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/head\s+sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
})
check('the public action persists judge answers and publishes only a verdict', () => {
  const action = readFileSync(join(process.cwd(), 'action.yml'), 'utf8')
  assert.match(action, /uses: actions\/cache@[a-f0-9]{40}/)
  assert.match(action, /POWERSHOT_CACHE_DIR: \$\{\{ runner\.temp \}\}\/powershot-cache/)
  assert.match(action, /restore-keys:/)
  assert.match(action, /upload-sarif:\s*\n\s+description: [^\n]+\n\s+default: 'true'/)
  assert.match(action, /Upload SARIF[\s\S]+inputs\.upload-sarif == 'true'[\s\S]+steps\.review\.outputs\.complete == 'true'/)
  assert.match(action, /inline-comments:\s*\n\s+description: [^\n]+\n\s+default: 'false'/)
  assert.match(action, /Post inline comments[\s\S]+inputs\.inline-comments == 'true'[\s\S]+steps\.review\.outputs\.complete == 'true'/)
  assert.match(action, /node "\$GITHUB_ACTION_PATH\/dist\/github\/inline-comments\.js"/)
})
check('published CI examples preserve one verdict and its exit status', () => {
  const action = readFileSync(join(process.cwd(), 'examples', 'github-actions', 'action.yml'), 'utf8')
  const github = readFileSync(join(process.cwd(), 'examples', 'github-actions', 'cli.yml'), 'utf8')
  const gitlab = readFileSync(join(process.cwd(), 'examples', 'gitlab', '.gitlab-ci.yml'), 'utf8')
  assert.match(action, /upload-sarif: 'true'/)
  assert.match(action, /inline-comments: 'true'/)
  assert.match(action, /runs-on: ubuntu-24\.04/)
  assert.match(action, /npm ci --ignore-scripts[\s\S]+uses: xcrft\/powershot@v1/)
  assert.match(github, /npm install --global --ignore-scripts @0xcraft\/powershot@1\.1\.0/)
  assert.equal(github.match(/psh review/g)?.length, 1)
  assert.match(github, /--report markdown=powershot\.md[\s\S]+--report sarif=powershot\.sarif/)
  assert.match(github, /\|\| STATUS=\$\?[\s\S]+case "\$STATUS"/)
  assert.match(gitlab, /npm install --global --ignore-scripts @0xcraft\/powershot@1\.1\.0/)
  assert.equal(gitlab.match(/psh review/g)?.length, 1)
  assert.match(gitlab, /--format codequality > gl-code-quality-report\.json \|\| STATUS=\$\?/)
  assert.match(gitlab, /test "\$STATUS" -le 1 \|\| exit "\$STATUS"/)
})
check('code quality fingerprints are stable across runs', () => {
  const a = JSON.parse(codeQuality(sample))
  const b = JSON.parse(codeQuality(sample))
  assert.equal(a[0].fingerprint, b[0].fingerprint) // else GitLab calls every finding new
  assert.equal(a[0].severity, 'major')
  assert.equal(a[1].severity, 'info')
  assert.equal(a[0].location.lines.begin, 3)
})
check('the viewer is one self-contained page', () => {
  const html = viewer(sample, {
    id: 'abc', target: 'workspace', started: '2026-01-01T10:00:00Z', state: 'complete', notLookedAt: [],
  })
  assert.match(html, /<!doctype html>/)
  assert.equal(/<(script|link|img)[^>]+(src|href)="http/.test(html), false) // no network needed
  assert.equal((html.match(/class="f /g) ?? []).length, 2)
})
check('the viewer escapes content rather than rendering it', () => {
  const nasty: Finding[] = [{ ...sample[0]!, title: '<img src=x onerror=alert(1)>' }]
  const html = viewer(nasty, {
    id: 'x', target: 't', started: '2026-01-01T10:00:00Z', state: 'complete', notLookedAt: [],
  })
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /&lt;img/)
})
check('delegated findings preserve the agent evidence and suggestion', () => {
  const got = absorbDelegated(JSON.stringify([
    { file: 'a.ts', line: 2, title: 'real', check: 'plausible-logic', severity: 'high', confidence: 'firm', why: 'w', suggestion: 'return value' },
  ]))
  assert.equal(got.length, 1)
  assert.equal(got[0]!.class, 'judged')
  assert.equal(got[0]!.check, 'plausible-logic')
  assert.equal(got[0]!.evidence?.oracle, 'delegated agent')
  assert.equal(got[0]!.suggestion, 'return value')
})
check('delegated output distinguishes an empty verdict from malformed data', () => {
  assert.deepEqual(absorbDelegated('[]'), [])
  assert.throws(() => absorbDelegated('not json'), /not valid JSON/)
  assert.throws(() => absorbDelegated('{"not":"an array"}'), /must be a JSON array/)
  assert.throws(
    () => absorbDelegated('[{"file":"a.ts","title":"lost line"}]'),
    /positive integer line/,
  )
})
check('delegate --checks selects only the requested judging brief', () => {
  const cfg = {
    provider: 'anthropic' as const, model: 'm', verifiers: ['*'], judges: ['*'],
    minSeverity: 'low' as const, ignore: [], promptCache: true,
  }
  const brief = delegateBrief(ground([{ path: 'a.ts', after: 'export const a = 1\n' }]), cfg, {
    checks: ['intent'], intent: 'add a',
  })
  assert.match(brief, /## Judge: intent/)
  assert.doesNotMatch(brief, /## Judge: plausible-logic/)
})

check('every agent target writes a distinct, non-empty file', () => {
  const paths = TARGETS.map((t) => t.path)
  assert.equal(new Set(paths).size, paths.length, 'two targets share a path')
  for (const t of TARGETS) {
    assert.ok(t.render().length > 400, t.name + ' produced no real content')
    assert.match(t.render(), /psh review --verify-only/, t.name + ' omits the command it exists to teach')
  }
})
check('the claude target is a skill, with the frontmatter that makes it invocable', () => {
  const skill = findTarget('claude')!.render()
  assert.match(skill, /^---\nname: powershot-review\n/)
  assert.match(skill, /^description: .{40,}/m)
})
check('the cursor target carries cursor rule frontmatter', () => {
  assert.match(findTarget('cursor')!.render(), /^---\ndescription: /)
})
check('every target points at where its tool actually looks', () => {
  assert.equal(findTarget('agents')!.path, 'AGENTS.md')
  assert.equal(findTarget('copilot')!.path, '.github/copilot-instructions.md')
  assert.equal(findTarget('cursor')!.path, '.cursor/rules/powershot.mdc')
  assert.match(findTarget('claude')!.path, /^\.claude\/skills\//)
})
check('an unknown agent name is rejected rather than guessed at', () => {
  assert.equal(findTarget('emacs'), undefined)
})

console.log('\njudge cache')
check('the key covers everything an answer depends on, and nothing else', () => {
  const base = {
    judge: 'plausible-logic', provider: 'anthropic', model: 'glm-4.6',
    prompt: 'find defects', tools: false, content: 'diff A',
  }
  const same = JudgeCache.key(base)
  assert.equal(JudgeCache.key({ ...base }), same) // same question, same key

  // every one of these makes it a different question, and a key that ignored any of
  // them would replay an answer that was given about something else
  assert.notEqual(JudgeCache.key({ ...base, judge: 'security' }), same)
  assert.notEqual(JudgeCache.key({ ...base, provider: 'openai' }), same)
  assert.notEqual(JudgeCache.key({ ...base, model: 'glm-5.3' }), same)
  assert.notEqual(JudgeCache.key({ ...base, prompt: 'find defects, carefully' }), same)
  assert.notEqual(JudgeCache.key({ ...base, tools: true }), same)
  assert.notEqual(JudgeCache.key({ ...base, content: 'diff B' }), same)
  assert.notEqual(JudgeCache.key({ ...base, intent: 'bump the tax rate' }), same)
})
check('an answer is reused only for the question it answered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-cache-'))
  const cache = JudgeCache.open(dir)
  const found: Finding[] = [
    { id: 'F1', class: 'judged', check: 'plausible-logic', severity: 'high', confidence: 'firm',
      file: 'a.ts', line: 2, title: 'inverted condition' },
  ]
  const ask = (content: string) =>
    JudgeCache.key({ judge: 'plausible-logic', provider: 'anthropic', model: 'm', prompt: 'p', tools: false, content })
  const key = ask('the diff')
  assert.equal(cache.get(key), undefined)
  cache.put(key, found, '2026-01-01T00:00:00Z')
  cache.save()

  const reopened = JudgeCache.open(dir)
  assert.equal(reopened.get(key)?.length, 1)
  assert.equal(reopened.get(ask('a different diff')), undefined)
  rmSync(dir, { recursive: true, force: true })
})
check('a corrupt cache is ignored rather than fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-cache-'))
  mkdirSync(join(dir, '.powershot'), { recursive: true })
  writeFileSync(join(dir, '.powershot', 'judge-cache.json'), 'not json at all')
  assert.equal(JudgeCache.open(dir).size, 0)
  writeFileSync(join(dir, '.powershot', 'judge-cache.json'), 'null')
  assert.equal(JudgeCache.open(dir).size, 0)
  rmSync(dir, { recursive: true, force: true })
})
check('a gated cache cannot be redirected into the reviewed tree', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-cache-boundary-')))
  const previous = process.env.POWERSHOT_CACHE_DIR
  process.env.POWERSHOT_CACHE_DIR = dir
  try {
    assert.throws(() => JudgeCache.open(dir, true), /must resolve outside/)
    assert.equal(existsSync(join(dir, 'powershot')), false)
  } finally {
    if (previous === undefined) delete process.env.POWERSHOT_CACHE_DIR
    else process.env.POWERSHOT_CACHE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
check('gated cache identity survives a second clone of the same remote', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'psh-cache-identity-')))
  const cacheRoot = join(parent, 'cache')
  const previous = process.env.POWERSHOT_CACHE_DIR
  process.env.POWERSHOT_CACHE_DIR = cacheRoot
  const init = (name: string, remote: string): string => {
    const dir = join(parent, name)
    mkdirSync(dir)
    execFileSync('git', ['init', '-q', '.'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
    return dir
  }
  try {
    const first = init('first', 'https://example.test/team/repo.git')
    const second = init('second', 'https://example.test/team/repo.git')
    const other = init('other', 'https://example.test/team/other.git')
    const found: Finding[] = [{
      id: 'F1', class: 'judged', check: 'intent', severity: 'high', confidence: 'firm',
      file: 'a.ts', line: 1, title: 'same answer',
    }]
    const one = JudgeCache.open(first, true)
    one.put('question', found, '2026-01-01T00:00:00Z')
    one.save()
    assert.equal(JudgeCache.open(second, true).get('question')?.[0]?.title, 'same answer')
    assert.equal(JudgeCache.open(other, true).get('question'), undefined)
  } finally {
    if (previous === undefined) delete process.env.POWERSHOT_CACHE_DIR
    else process.env.POWERSHOT_CACHE_DIR = previous
    rmSync(parent, { recursive: true, force: true })
  }
})

console.log('\nsession comparison')
check('a second review says what was fixed, what is new, and what stayed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-diff-'))
  const mk = (titles: string[]): Session => {
    const s = Session.create(dir, 'workspace')
    s.saveReport(titles.map((t, i) => ({
      id: 'F' + i, class: 'judged' as const, check: 'plausible-logic', severity: 'high' as const,
      confidence: 'firm' as const, file: 'a.ts', line: i + 1, title: t,
    })), { state: 'complete', notLookedAt: [] })
    return s
  }
  const before = mk(['inverted condition', 'off by one'])
  const after = mk(['off by one', 'missing await'])
  const { fixed, introduced, remaining } = Session.compare(before, after)
  assert.deepEqual(fixed.map((f) => f.title), ['inverted condition'])
  assert.deepEqual(introduced.map((f) => f.title), ['missing await'])
  assert.deepEqual(remaining.map((f) => f.title), ['off by one'])
  rmSync(dir, { recursive: true, force: true })
})
check('a finding is matched past a line that moved under it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-diff-'))
  const at = (line: number): Session => {
    const s = Session.create(dir, 'workspace')
    s.saveReport([{ id: 'F1', class: 'judged', check: 'plausible-logic', severity: 'high',
      confidence: 'firm', file: 'a.ts', line, title: 'off by one' }], { state: 'complete', notLookedAt: [] })
    return s
  }
  // code above it grew, so the same defect now sits ten lines lower — not a new one
  assert.equal(Session.compare(at(12), at(22)).introduced.length, 0)
  assert.equal(Session.compare(at(12), at(22)).remaining.length, 1)
  rmSync(dir, { recursive: true, force: true })
})
check('partial sessions cannot be compared or rendered as clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-partial-session-'))
  const partial = Session.create(dir, 'workspace')
  partial.saveReport([], { state: 'partial', notLookedAt: ['outside.ts (no types)'] })
  const complete = Session.create(dir, 'workspace')
  complete.saveReport([], { state: 'complete', notLookedAt: [] })
  assert.throws(() => Session.compare(partial, complete), /only complete/)
  const html = viewer([], {
    id: partial.id, target: partial.target, started: partial.started, state: 'partial',
    notLookedAt: partial.report!.notLookedAt ?? [],
  })
  assert.match(html, /partial — not a verdict/)
  assert.match(html, /outside\.ts \(no types\)/)
  assert.doesNotMatch(html, />No findings\.<\/p>/)
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nsessions and scan')
const tmp = mkdtempSync(join(tmpdir(), 'psh-'))

check('a session replays an answer only for the content it answered', () => {
  const s = Session.create(tmp, 'workspace')
  assert.equal(s.get('security', 'a.ts', 'diff v1'), undefined)
  s.record('security', 'a.ts', 'diff v1', [
    { id: 'F1', class: 'judged', check: 'security', severity: 'high', confidence: 'firm', file: 'a.ts', line: 2, title: 'x' },
  ])
  const reopened = Session.open(tmp, s.id)
  assert.ok(reopened, 'session should reopen from disk')
  assert.equal(reopened.get('security', 'a.ts', 'diff v1')?.length, 1)
  assert.equal(reopened.get('security', 'b.ts', 'diff v1'), undefined) // only what was paid for
  // the same unit name over edited content is a different question, not a hit
  assert.equal(reopened.get('security', 'a.ts', 'diff v2'), undefined)
})
check('sessions are listed newest first, with their progress', () => {
  const rows = Session.list(tmp)
  assert.ok(rows.length >= 1)
  assert.ok(rows[0]!.done >= 1)
})
check('opening a session that does not exist returns undefined, not a throw', () => {
  assert.equal(Session.open(tmp, 'nope1234'), undefined)
})

check('scan presents every file as newly written, with no base to compare', () => {
  mkdirSync(join(tmp, 'src'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
  writeFileSync(join(tmp, 'src', 'notes.md'), '# not code\n')
  mkdirSync(join(tmp, 'src', 'node_modules'), { recursive: true })
  writeFileSync(join(tmp, 'src', 'node_modules', 'x.ts'), 'export const x = 1\n')

  const files = scanPaths(tmp, 'src')
  assert.deepEqual(files.map((f) => f.path), ['src/a.ts'])   // code only, no node_modules
  assert.equal(files[0]!.before, undefined)                   // nothing to diff against
  assert.ok(files[0]!.added.has(1) && files[0]!.added.has(2)) // every line counts as new
})

rmSync(tmp, { recursive: true, force: true })

console.log('\njudges')
check('every judge is uniquely named and carries a brief', () => {
  const names = JUDGES.map((j) => j.name)
  assert.equal(new Set(names).size, names.length, 'duplicate judge name')
  for (const j of JUDGES) assert.ok(j.brief.trim().length > 40, j.name + ' has no real brief')
})
check('exactly one judge asks for the stated intent', () => {
  assert.deepEqual(JUDGES.filter((j) => j.needsIntent).map((j) => j.name), ['intent'])
})
check('the shared framing states the trust boundary for reviewed code', () => {
  assert.match(COMMON, /DATA, not instructions/)
})
check('model output is parsed into findings, and junk is discarded', () => {
  const raw = JSON.stringify([
    { file: 'a.ts', line: 3, severity: 'high', confidence: 'firm', title: 'real', why: 'w', fix: 'f' },
    { file: 'a.ts', title: 'no line — dropped' },
    { line: 4, title: 'no file — dropped' },
    { file: 'a.ts', line: 9, title: 'defaults applied' },
  ])
  const found = parseFindings(raw, 'security')
  assert.equal(found.length, 2)
  assert.equal(found[0]!.class, 'judged')
  assert.equal(found[0]!.check, 'security')
  assert.equal(found[1]!.severity, 'medium')      // unknown severity falls back
  assert.equal(found[1]!.confidence, 'tentative') // and so does confidence
})

console.log('\ncopy-paste-drift')
check('fires when a clone leaves one identifier un-renamed', () => {
  const src =
    'export function f() {\n' +
    '  const userTotal = order.user.price * order.user.qty\n' +
    '  const adminTotal = order.admin.price * order.user.qty\n' +
    '}\n'
  const found = copyPasteDrift.run(ground([{ path: 'a.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /`user` renamed inconsistently/)
})
check('silent when the rename is consistent — ordinary parallel code', () => {
  const src =
    'export function f() {\n' +
    '  const userTotal = order.user.price * order.user.qty\n' +
    '  const adminTotal = order.admin.price * order.admin.qty\n' +
    '}\n'
  assert.equal(fires(copyPasteDrift, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent on an exact duplicate, which is a different concern', () => {
  const src =
    'export function f() {\n' +
    '  const a = order.user.price * order.user.qty\n' +
    '  const a = order.user.price * order.user.qty\n' +
    '}\n'
  assert.equal(fires(copyPasteDrift, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent when two things merely share a name', () => {
  // found by running this check over its own repository: a local `tests` beside a
  // member `.tests` maps to two NEW names, which is not a rename anyone forgot
  const src =
    'export function f() {\n' +
    '  const tests = async (s: string) => pack.tests!(parse(pack, s).rootNode)\n' +
    '  const docs = async (s: string) => pack.documentedParams!(parse(pack, s).rootNode)\n' +
    '}\n'
  assert.equal(fires(copyPasteDrift, ground([{ path: 'a.ts', after: src }])), false)
})
check('silent when literals differ, since the shapes are not clones', () => {
  const src =
    'export function f() {\n' +
    '  const userTotal = order.user.price * order.user.qty * 2\n' +
    '  const adminTotal = order.admin.price * order.user.qty * 3\n' +
    '}\n'
  assert.equal(fires(copyPasteDrift, ground([{ path: 'a.ts', after: src }])), false)
})

console.log('\ndead-on-arrival')
check('fires on a module-private declaration nothing references', () => {
  const found = deadOnArrival.run(ground([{ path: 'a.ts', after: 'function orphan(n: number) { return n }\n' }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /orphan/)
})
check('silent when the declaration is exported — it may be public API', () => {
  assert.equal(
    fires(deadOnArrival, ground([{ path: 'a.ts', after: 'export function used(n: number) { return n }\n' }])),
    false,
  )
})
check('silent when something references it', () => {
  const src = 'function helper(n: number) { return n }\nexport const go = () => helper(1)\n'
  assert.equal(fires(deadOnArrival, ground([{ path: 'a.ts', after: src }])), false)
})
check('respects the _name convention for a deliberate non-reference', () => {
  assert.equal(fires(deadOnArrival, ground([{ path: 'a.ts', after: 'function _scratch(n: number) { return n }\n' }])), false)
})

console.log('\nlying-comment')
check('fires when @param names an argument the function does not take', () => {
  const src = '/**\n * @param currency which currency\n */\nexport function charge(id: string): number { return 1 }\n'
  const found = lyingComment.run(ground([{ path: 'a.ts', after: src }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /currency/)
})
check('fires when @returns promises a value from a void function', () => {
  const src = '/**\n * @returns a receipt id\n */\nexport function charge(id: string): void {}\n'
  const found = lyingComment.run(ground([{ path: 'a.ts', after: src }]))
  assert.ok(found.some((f) => /@returns/.test(f.title)))
})
check('silent when the documentation matches the signature', () => {
  const src = '/**\n * @param id who\n * @returns the total\n */\nexport function charge(id: string): number { return 1 }\n'
  assert.equal(fires(lyingComment, ground([{ path: 'a.ts', after: src }])), false)
})
check('allows @param documenting a property of a real parameter', () => {
  const src = '/**\n * @param opts.retries how many\n */\nexport function go(opts: { retries: number }): number { return 1 }\n'
  assert.equal(fires(lyingComment, ground([{ path: 'a.ts', after: src }])), false)
})

console.log('\ncontract-drift')
// the caller lives in a file the change does not touch, so it is passed as an
// unchanged extra file — exactly the blast radius phantom-api cannot see
const MAILER_BEFORE = 'export function sendMail(to: string): boolean {\n  return to.length > 0\n}\n'
const caller = { path: 'signup.ts', after: "import { sendMail } from './mailer.js'\nexport const go = () => sendMail('a')\n" }

function driftGround(after: string) {
  const g = ground([{ path: 'mailer.ts', after, before: MAILER_BEFORE }, caller])
  // the caller file is present for reference resolution but is NOT part of the change
  g.changed = g.changed.filter((c) => c.path !== 'signup.ts')
  g.files = g.files.filter((f) => f.changed.path !== 'signup.ts')
  return g
}

check('fires when a required parameter is added and callers are left behind', () => {
  const found = contractDrift.run(
    driftGround('export function sendMail(to: string, subject: string): boolean {\n  return true\n}\n'),
  )
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'proven')
  assert.match(found[0]!.title, /requires 2 argument/)
  assert.match(found[0]!.evidence!.detail, /signup\.ts/)
})
check('silent when the new parameter is optional — no caller breaks', () => {
  const found = contractDrift.run(
    driftGround('export function sendMail(to: string, subject?: string): boolean {\n  return true\n}\n'),
  )
  assert.equal(found.length, 0)
})
check('silent when a parameter has a default — no caller breaks', () => {
  const found = contractDrift.run(
    driftGround("export function sendMail(to: string, subject = 'hi'): boolean {\n  return true\n}\n"),
  )
  assert.equal(found.length, 0)
})
check('fires when a parameter is removed, since callers now pass too many', () => {
  const found = contractDrift.run(driftGround('export function sendMail(): boolean {\n  return true\n}\n'))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /takes 0 parameter/)
})
check('reports a changed parameter type as firm, not proven', () => {
  const found = contractDrift.run(
    driftGround('export function sendMail(to: number): boolean {\n  return true\n}\n'),
  )
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'firm')
})
check('silent when the signature did not change', () => {
  assert.equal(contractDrift.run(driftGround(MAILER_BEFORE)).length, 0)
})

console.log('\nscope-creep')
check('fires when a file is reformatted without changing the program', () => {
  const before = 'export function double(n: number): number { return n * 2 }\n'
  const after = 'export function double(n: number): number {\n  return n * 2\n}\n'
  const found = scopeCreep.run(ground([{ path: 'u.ts', after, before }]))
  assert.equal(found.length, 1)
  assert.equal(found[0]!.confidence, 'proven')
  assert.match(found[0]!.title, /only formatting/)
})
check('distinguishes a comment-only edit from pure reformatting', () => {
  const before = 'export const a = 1\n'
  const after = '// why a is 1\nexport const a = 1\n'
  const found = scopeCreep.run(ground([{ path: 'u.ts', after, before }]))
  assert.equal(found.length, 1)
  assert.match(found[0]!.title, /only comments/)
})
check('silent when the program actually changed', () => {
  const before = 'export const a = 1\n'
  const after = 'export const a = 2\n'
  assert.equal(fires(scopeCreep, ground([{ path: 'u.ts', after, before }])), false)
})
check('silent for a new file, which always adds something', () => {
  assert.equal(fires(scopeCreep, ground([{ path: 'u.ts', after: 'export const a = 1\n' }])), false)
})
check('silent when the file was not touched at all', () => {
  const same = 'export const a = 1\n'
  assert.equal(fires(scopeCreep, ground([{ path: 'u.ts', after: same, before: same }])), false)
})

console.log('\ncaret positioning')
check('verifiers pin the exact span, not just the line', () => {
  const g = ground([{ path: 'a.ts', after: "import ky from 'ky'\nexport const x = ky\n" }], ['zod'])
  const found = phantomDep.run(g)
  const span = found[0]!.span
  assert.ok(span, 'expected a span')
  // the caret must land on the specifier literal 'ky', not the whole import
  const line = "import ky from 'ky'"
  assert.equal(line.slice(span.column - 1, span.column - 1 + span.length), "'ky'")
})
check('the caret shifts with the dedent so it stays under its token', () => {
  //                     0123456789
  const rendered = 'return inv.total'   // was '    return inv.total', dedent 4
  const span = { column: 12, length: 3 }  // "inv" in the original line
  assert.deepEqual(caretFor(span, rendered, 4), { offset: 7, length: 3 })
  assert.equal(rendered.slice(7, 10), 'inv')
})
check('an unplaceable span yields no caret rather than a wrong one', () => {
  assert.equal(caretFor({ column: 99, length: 3 }, 'short', 0), undefined)   // past the end
  assert.equal(caretFor({ column: 2, length: 3 }, 'short', 8), undefined)    // before the start
  assert.equal(caretFor(undefined, 'short', 0), undefined)                   // no span at all
  assert.equal(caretFor({ column: 1, length: 3 }, undefined, 0), undefined)  // no line
})
check('a span running past the line end is clamped, not overflowed', () => {
  assert.deepEqual(caretFor({ column: 3, length: 999 }, 'abcde', 0), { offset: 2, length: 3 })
})

console.log('\nphantom-api')
check('refuses to run without a tsconfig rather than guessing', () => {
  // g.typed is false in these fixtures: without lib/type resolution every global
  // would look invented, so the verifier must stay silent instead of inventing findings.
  const g = ground([{ path: 'a.ts', after: 'export const x = totallyUnknownGlobal\n' }])
  assert.equal(phantomApi.run(g).length, 0)
})
await checkAsync('an unresolved type environment is partial, not a proven phantom API', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-phantom-api-types-')))
  try {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023'], strict: true,
      },
      include: ['src'],
    }))
    const source = "import { fileURLToPath } from 'node:url'\nexport const here = fileURLToPath(import.meta.url)\n"
    writeFileSync(join(dir, 'src', 'a.ts'), source)

    const result = await review({
      root: dir,
      range: {},
      changes: [{ path: 'src/a.ts', added: new Set([1, 2]) }],
      config: loadConfig(dir),
      verifyOnly: true,
      checks: ['phantom-api'],
    })

    assert.deepEqual(result.findings, [])
    assert.deepEqual(result.plan?.items()[0]?.missing, ['types'])
    assert.deepEqual(result.skippedChecks, [{ check: 'phantom-api', missing: 'types' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await checkAsync('phantom-api still proves a property error with a complete type environment', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-phantom-api-complete-')))
  try {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023'], strict: true,
      },
      include: ['src'],
    }))
    const source = "export const value = 'ok'.definitelyMissing()\n"
    writeFileSync(join(dir, 'src', 'a.ts'), source)

    const result = await review({
      root: dir,
      range: {},
      changes: [{ path: 'src/a.ts', added: new Set([1]) }],
      config: loadConfig(dir),
      verifyOnly: true,
      checks: ['phantom-api'],
    })

    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0]?.check, 'phantom-api')
    assert.equal(result.findings[0]?.confidence, 'proven')
    assert.deepEqual(result.skippedChecks, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\nhelpers')
check('extractJsonArray survives prose and code fences', () => {
  assert.deepEqual(extractJsonArray('Sure!\n```json\n[{"a":1}]\n```\n'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray('here you go: [1,2] done'), [1, 2])
  assert.deepEqual(extractJsonArray('no json at all'), [])
})
check('a proxy BASE_URL is treated as a base, not a full endpoint', () => {
  assert.equal(endpoint(undefined, 'https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages')
  assert.equal(endpoint('https://gw.internal', 'https://api.anthropic.com', '/v1/messages'), 'https://gw.internal/v1/messages')
  assert.equal(endpoint('https://gw.internal/', 'https://api.anthropic.com', '/v1/messages'), 'https://gw.internal/v1/messages')
})
check('a suggestion takes its indentation from the file, not the model', () => {
  // measured against a real judge: it got the fix exactly right and returned it at
  // four spaces where the file used two. Where a line sits is a fact about the file.
  assert.equal(validateSuggestion('    if (amount > balance) {', '  if (amount <= balance) {'),
    '  if (amount > balance) {')
  assert.equal(validateSuggestion('if (amount > balance) {', '  if (amount <= balance) {'),
    '  if (amount > balance) {')
  assert.equal(validateSuggestion('  return n', 'return m'), 'return n') // no indent to restore
})
check('a suggestion that changes nothing is dropped', () => {
  assert.equal(validateSuggestion('  return n', '  return n'), undefined)
  assert.equal(validateSuggestion('return n', '    return n'), undefined) // same code, different layout
  assert.equal(validateSuggestion('   ', '  return n'), undefined)
})
check('a suggestion is the whole line, ready to commit', () => {
  // GitHub and GitLab render a ```suggestion block as one-click apply, so it must
  // carry the complete replacement line rather than the fragment that changed
  const f: Finding = {
    id: 'F1', class: 'verified', check: 'phantom-api', severity: 'high', confidence: 'proven',
    file: 'a.ts', line: 5, title: "Did you mean 'toUpperCase'?",
    suggestion: '  return inv.customer.toUpperCase()',
  }
  const md = markdown([f])
  assert.match(md, /```suggestion\n  return inv\.customer\.toUpperCase\(\)\n```/)
})
check('a finding with only advice keeps a plain block, never a suggestion', () => {
  const f: Finding = {
    id: 'F1', class: 'verified', check: 'swallowed-error', severity: 'high', confidence: 'proven',
    file: 'a.ts', line: 5, title: 'empty catch', fix: 'Rethrow, or say why ignoring it is safe',
  }
  const md = markdown([f])
  assert.equal(md.includes('```suggestion'), false) // advice is not an applicable patch
  assert.match(md, /Rethrow/)
})
check('one defect reported twice in different words is one finding', () => {
  // two judges can land on the same place and word it differently
  assert.ok(titleOverlap('Inverted condition for insufficient funds',
                         'Condition for insufficient funds is inverted') >= 0.7)
  assert.ok(titleOverlap('Off-by-one in the loop bound',
                         'Missing await on the async call') < 0.7)
  assert.equal(titleOverlap('', 'anything'), 0)
})
check('sarif output has the shape GitHub code scanning ingests', () => {
  const doc = JSON.parse(
    sarif([
      { id: 'F1', class: 'verified', check: 'phantom-dep', severity: 'high', confidence: 'proven',
        file: 'src/a.ts', line: 3, title: 'missing dep' },
      { id: 'F2', class: 'judged', check: 'plausible-logic', severity: 'low', confidence: 'tentative',
        file: 'src/b.ts', line: 9, title: 'off by one' },
    ]),
  )
  assert.equal(doc.version, '2.1.0')
  assert.equal(doc.runs[0].tool.driver.rules.length, 2)   // one rule per distinct check
  assert.equal(doc.runs[0].results.length, 2)
  assert.equal(doc.runs[0].results[0].level, 'error')     // high -> error
  assert.equal(doc.runs[0].results[1].level, 'note')      // low  -> note
  assert.equal(doc.runs[0].results[0].locations[0].physicalLocation.region.startLine, 3)
  assert.equal(doc.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/a.ts')
})
check('titles wrap at word boundaries instead of cutting mid-word', () => {
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox'])
  assert.deepEqual(wrap('short', 40), ['short'])
  // a single word longer than the width still gets its own line rather than vanishing
  assert.deepEqual(wrap('supercalifragilistic', 5), ['supercalifragilistic'])
  assert.deepEqual(wrap('', 10), [''])
})
check('highlighting never loses or mangles the source text', () => {
  // colour is off in this process (piped), so highlight is identity — the contract
  // that matters is that the visible characters always survive intact
  const strip = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
  const samples = [
    'const x = `t ${a} b`',
    "if (a) { return /re?g/.test('s') } // note",
    'export default class A extends B {}',
    'const n = 0xFF + 1000n',
    '',
  ]
  for (const src of samples) {
    assert.equal(strip(highlight(src)), src, 'text changed for: ' + src)
  }
})
check('highlighting survives input the scanner cannot parse', () => {
  assert.equal(typeof highlight('const = = = "unterminated'), 'string') // must not throw
})
check('jsx files are detected for the right scanner variant', () => {
  assert.equal(isJsx('src/App.tsx'), true)
  assert.equal(isJsx('src/app.ts'), false)
})
check('ignore globs match the way the config claims', () => {
  assert.equal(matchesAny('src/a/node_modules/x.ts', ['**/node_modules/**']), true)
  assert.equal(matchesAny('src/x.generated.ts', ['**/*.generated.*']), true)
  assert.equal(matchesAny('src/x.ts', ['**/node_modules/**', '**/*.generated.*']), false)
  // a globstar before a slash matches zero directories too, so a tree at the root
  // is covered by the same pattern as one nested three deep
  assert.equal(matchesAny('vendor/dep.ts', ['**/vendor/**']), true)
  assert.equal(matchesAny('a/b/vendor/c.ts', ['**/vendor/**']), true)
  assert.equal(matchesAny('x.generated.ts', ['**/*.generated.*']), true)
  assert.equal(matchesAny('src/vendored.ts', ['**/vendor/**']), false)
})

console.log('\ndismissals')
const dis = (line: number, code: string, check = 'swallowed-error', file = 'src/sync.ts'): Finding => ({
  id: 'F1', class: 'verified', check, severity: 'high', confidence: 'proven', file, line, title: 't',
  frame: { firstLine: line, lines: [code] },
})
check('a dismissal survives the line moving down the file', () => {
  // a decision about a line should not expire because something unrelated grew above it
  assert.equal(Dismissals.fingerprint(dis(5, '  cache.refresh().catch(() => {})')),
               Dismissals.fingerprint(dis(91, '  cache.refresh().catch(() => {})')))
})
check('a dismissal lapses when the line it was about changes', () => {
  // nobody has looked at what the line says now, so the old decision does not cover it
  assert.notEqual(Dismissals.fingerprint(dis(5, 'cache.refresh().catch(() => {})')),
                  Dismissals.fingerprint(dis(5, 'cache.refresh().catch(log)')))
})
check('the same code in another file, or under another check, is a separate decision', () => {
  const base = Dismissals.fingerprint(dis(5, 'x()'))
  assert.notEqual(base, Dismissals.fingerprint(dis(5, 'x()', 'swallowed-error', 'src/other.ts')))
  assert.notEqual(base, Dismissals.fingerprint(dis(5, 'x()', 'dropped-guard')))
})
check('dismissing hides the finding, restoring brings it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-dis-'))
  const f = dis(5, 'cache.refresh().catch(() => {})')
  const d = Dismissals.open(dir)
  assert.equal(d.has(f), false)
  assert.equal(d.add(f, 'best-effort', '2026-01-01T00:00:00Z'), true)
  assert.equal(d.add(f, 'again', '2026-01-01T00:00:00Z'), false) // already decided
  assert.equal(Dismissals.open(dir).has(f), true) // and it is on disk, for the team
  assert.equal(Dismissals.open(dir).remove(Dismissals.fingerprint(f).slice(0, 8)), true)
  assert.equal(Dismissals.open(dir).has(f), false)
  rmSync(dir, { recursive: true, force: true })
})
check('an unreadable dismissal file hides nothing rather than everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-dis-'))
  mkdirSync(join(dir, '.powershot'), { recursive: true })
  writeFileSync(join(dir, '.powershot', 'dismissed.json'), 'not json at all')
  assert.equal(Dismissals.open(dir).list().length, 0)
  assert.equal(Dismissals.open(dir).has(dis(5, 'x()')), false)
  rmSync(dir, { recursive: true, force: true })
})
check('the last report is what makes a finding addressable by id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-dis-'))
  assert.deepEqual(lastReport(dir), []) // nothing reviewed yet
  rememberReport(dir, [dis(5, 'x()')])
  assert.equal(lastReport(dir)[0]?.file, 'src/sync.ts')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nfile policy')
check('repository paths stay relative and slash-separated across path styles', () => {
  const source = { getFilePath: () => 'C:/repo/src/a.ts' } as Parameters<typeof relPath>[0]
  assert.equal(relPath(source, 'C:\\repo'), 'src/a.ts')
  assert.equal(repoPath('C:\\repo', 'src\\a.ts'), 'src/a.ts')

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-root-form-')))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'export const a = 1\n')
  try {
    assert.equal(insideRepo(dir + sep + '.', file), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('the repository boundary blocks what a review never needs to read', () => {
  const root = process.cwd()
  for (const path of ['.git/config', '.git/HEAD', '.env', '.env.local', 'src/../.git/config',
                      'deploy.pem', 'sub/.ssh/id_rsa', '.npmrc', '../outside.ts']) {
    assert.equal(insideRepo(root, path), undefined, path + ' must be refused')
  }
  assert.ok(insideRepo(root, 'src/cli.ts'), 'ordinary source must be readable')
  assert.ok(insideRepo(root, '.env.example'), 'a documented template is reviewable source, not a credential file')
})
check('a symlink out of the repository is refused, not followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-link-'))
  const real = realpathSync(dir)
  writeFileSync(join(real, 'ok.ts'), 'export const a = 1\n')
  const away = realpathSync(mkdtempSync(join(tmpdir(), 'psh-away-')))
  writeFileSync(join(away, 'secret.ts'), 'export const TOKEN = "sk-secret"\n')
  symlinkSync(join(away, 'secret.ts'), join(real, 'leak.ts'))
  // `resolve` normalises `..` but follows nothing, so only the real path settles this
  assert.equal(insideRepo(real, 'leak.ts'), undefined)
  assert.ok(insideRepo(real, 'ok.ts'))
  rmSync(dir, { recursive: true, force: true })
  rmSync(away, { recursive: true, force: true })
})

console.log('\nconfig')
const KNOWN = { verifiers: ['swallowed-error', 'phantom-dep'], judges: ['plausible-logic', 'security'] }
check('a name that matches no check is an error, not a filter selecting nothing', () => {
  // the quietest way to a clean review: a typo that turns every check off and exits 0
  const bad = validateConfig({ verifiers: ['swallowed-errors'] }, KNOWN)
  assert.equal(bad.length, 1)
  assert.match(bad[0]!, /did you mean swallowed-error\?/)
  assert.deepEqual(validateConfig({ verifiers: ['swallowed-error', '*'] }, KNOWN), [])
})
check('an unknown setting, provider or severity is reported with what was meant', () => {
  assert.match(validateConfig({ minSeverty: 'high' }, KNOWN)[0]!, /did you mean minSeverity/)
  assert.match(validateConfig({ provider: 'antropic' }, KNOWN)[0]!, /not one of: anthropic/)
  assert.match(validateConfig({ minSeverity: 'huge' }, KNOWN)[0]!, /not one of: info/)
  assert.deepEqual(validateConfig({ provider: 'openai', minSeverity: 'high' }, KNOWN), [])
})
check('judges accept both the plain list and the { enable } form', () => {
  assert.deepEqual(validateConfig({ judges: { enable: ['security'] } }, KNOWN), [])
  assert.equal(validateConfig({ judges: { enable: ['securty'] } }, KNOWN).length, 1)
  assert.equal(validateConfig({ judges: 'security' }, KNOWN).length, 1) // not a list at all
})

console.log('\nsession safety')
check('a session will not be resumed by a different model than answered it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psh-ses-'))
  const s = Session.create(dir, 'workspace', { provider: 'anthropic', model: 'glm-4.6' })
  assert.equal(s.askedBy('anthropic', 'glm-4.6'), true)
  assert.equal(s.askedBy('anthropic', 'glm-5.3'), false)
  assert.equal(s.askedBy('openai', 'glm-4.6'), false)
  rmSync(dir, { recursive: true, force: true })
})

console.log('\ntarget snapshot')
await checkAsync('a past commit is reviewed as it was, not as the working tree is now', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-hist-')))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'package.json'), '{"name":"h"}')
  writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1\n')
  run('add', '-A'); run('commit', '-qm', 'seed')

  writeFileSync(join(dir, 'a.ts'), 'export function load() {\n  try { JSON.parse("{}") } catch {}\n}\n')
  run('add', '-A'); run('commit', '-qm', 'swallow it')
  const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()

  // gone from the working tree: reading the tree instead of the commit reports nothing
  writeFileSync(join(dir, 'a.ts'), 'export function load() {\n  try { JSON.parse("{}") } catch (e) { throw e }\n}\n')
  run('add', '-A'); run('commit', '-qm', 'handle it')

  const now = await review({ root: dir, range: {}, config: loadConfig(dir), verifyOnly: true })
  assert.equal(now.findings.length, 0, 'the working tree is clean')

  const then = await withTargetTree(dir, { commit: bad }, (tree) =>
    review({ root: tree, stateRoot: dir, range: { commit: bad }, config: loadConfig(dir), verifyOnly: true }))
  assert.equal(then.findings.length, 1, 'the commit that introduced it must still report it')
  assert.equal(then.findings[0]!.check, 'swallowed-error')
  assert.equal(then.findings[0]!.file, 'a.ts')

  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: dir }).toString().trim().split('\n').length, 1)
  rmSync(dir, { recursive: true, force: true })
})
await checkAsync('a change cannot dismiss its own findings', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-gate-')))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'package.json'), '{"name":"g"}')
  run('add', '-A'); run('commit', '-qm', 'seed')
  run('branch', '-M', 'main')
  run('checkout', '-q', '-b', 'feature')

  const code = 'export function load() {\n  try { JSON.parse("{}") } catch {}\n}\n'
  writeFileSync(join(dir, 'a.ts'), code)
  run('add', '-A'); run('commit', '-qm', 'add it')

  const range = { from: 'main', to: 'HEAD' }
  const found = await review({ root: dir, range, config: loadConfig(dir), verifyOnly: true })
  assert.equal(found.findings.length, 1)

  // the change now suppresses its own finding and commits the suppression
  mkdirSync(join(dir, '.powershot'), { recursive: true })
  writeFileSync(join(dir, '.powershot', 'dismissed.json'), JSON.stringify([{
    fingerprint: Dismissals.fingerprint(found.findings[0]!),
    check: 'swallowed-error', file: 'a.ts', code: 'x', title: 't', at: '2026-01-01T00:00:00Z',
  }]))
  run('add', '-A'); run('commit', '-qm', 'nothing to see here')

  const gated = await review({ root: dir, range, config: loadConfig(dir), verifyOnly: true })
  assert.equal(gated.findings.length, 1, 'a suppression the base has not seen must not apply')
  assert.equal(gated.stats.dismissed, 0)
  rmSync(dir, { recursive: true, force: true })
})

console.log('\ntrust boundary')
await checkAsync('every ingestion path refuses a link out of the repository', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-ingress-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'psh-outside-')))
  writeFileSync(join(outside, 'creds.ts'), 'export const TOKEN = "sk-secret"\n')
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'package.json'), '{"name":"i"}')
  writeFileSync(join(dir, 'ok.ts'), 'export const ok = 1\n')
  run('add', '-A'); run('commit', '-qm', 'seed')
  symlinkSync(join(outside, 'creds.ts'), join(dir, 'leak.ts'))

  const cfg = loadConfig(dir)
  const paths = (r: { findings: unknown[] }, files: string[]) => files
  // untracked diff, whole-directory scan, and single-file scan are three separate
  // entrances; proving one does not prove the others, which is how this got through
  const viaDiff = await review({ root: dir, range: {}, config: cfg, verifyOnly: true })
  assert.equal(viaDiff.stats.files, 0, 'an untracked symlink must not enter the diff')
  assert.deepEqual(scanPaths(dir, '.').map((f) => f.path), ['ok.ts'], 'walk must skip the link')
  assert.deepEqual(scanPaths(dir, 'leak.ts'), [], 'naming the link directly must not read it')

  // and once it is tracked, the compiler project must not pick it up either
  run('add', '-A'); run('commit', '-qm', 'track the link')
  const tracked = await review({ root: dir, range: { commit: 'HEAD' }, config: cfg, verifyOnly: true })
  assert.equal(tracked.stats.files, 0, 'a tracked symlink must not enter the project')

  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
await checkAsync('a ref that is really an option is refused, not passed to git', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-ref-')))
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  run('add', '-A'); run('commit', '-qm', 'seed')

  // `git diff --output=x A...B` writes a file: execFileSync stops the shell, not git
  const written = join(dir, 'proof')
  assert.throws(() => collectChanges(dir, { from: '--output=' + written, to: 'HEAD' }), /looks like an option/)
  assert.equal(existsSync(written), false, 'no file may have been written')
  // and a ref that does not resolve is an error, not an empty diff that reads clean
  assert.throws(() => collectChanges(dir, { from: 'no-such-ref', to: 'HEAD' }), /not a commit/)
  rmSync(dir, { recursive: true, force: true })
})
function markdownBlockEscape(out: string): string | undefined {
  let bar: string | undefined
  for (const line of out.split('\n')) {
    const open = /^(`{3,})/.exec(line)
    if (bar === undefined && open) {
      bar = open[1]
      continue
    }
    if (bar !== undefined) {
      if (new RegExp('^\\s{0,3}' + bar + '\\s*$').test(line)) bar = undefined
      continue
    }
    if (
      /^(?:#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s|(?:[-*_]\s*){3,})/.test(line) &&
      !/^## PowerShot$|^### `|^> _.*_: /.test(line)
    ) {
      return line
    }
  }
  return undefined
}
check('a finding cannot break out of the document that carries it', () => {
  // the markdown goes into a pull-request comment, and the title came from a diff
  const out = markdown([{
    id: 'F1', class: 'judged', check: 'x', severity: 'high', confidence: 'firm',
    file: 'a.ts', line: 1,
    title: '```\n## Injected heading\n[click](https://evil.example)',
    evidence: { oracle: 'agent', detail: '`ends the quote`' },
    frame: { firstLine: 1, lines: ['```', 'malicious'] },
    fix: '```\nescape',
  }])
  assert.equal(markdownBlockEscape(out), undefined, 'nothing may escape into the document')

  // CommonMark accepts a closing fence indented by three spaces, so containment must
  // come from a longer delimiter rather than indentation.
  const surfaces: Partial<Finding>[] = [
    { file: 'a.ts\n## Injected' },
    { file: 'a.ts)](https://evil.example)(' },
    { title: '## Injected' },
    { title: '> [!WARNING]' },
    { title: '- forged result' },
    { title: '1. forged result' },
    { title: '---' },
    { title: '```\n## Injected' },
    { frame: { firstLine: 1, lines: ['```', '## Injected'] } },
    { frame: { firstLine: 1, lines: ['   ```', '## Injected'] } },
    { fix: '```\n## Injected' },
    { suggestion: '``````\n## Injected' },
    { evidence: { oracle: 'a', detail: 'x\n## Injected' } },
  ]
  for (const extra of surfaces) {
    const rendered = markdown([{
      id: 'F1', class: 'judged', check: 'x', severity: 'high', confidence: 'firm',
      file: 'a.ts', line: 1, title: 'ordinary', ...extra,
    }])
    assert.equal(markdownBlockEscape(rendered), undefined, 'escaped through ' + Object.keys(extra)[0])
  }

  const destinations = markdown([{
    id: 'F1', class: 'judged', check: 'x', severity: 'high', confidence: 'firm',
    file: 'javascript:alert(1)#part?query.ts', line: 1, title: 'ordinary',
  }])
  assert.match(destinations, /\.\/javascript%3Aalert%281%29%23part%3Fquery\.ts#L1/)
  assert.doesNotMatch(destinations, /\]\(javascript:/)
  const traversal = markdown([{
    id: 'F1', class: 'judged', check: 'x', severity: 'high', confidence: 'firm',
    file: '../../issues/1', line: 1, title: 'ordinary',
  }])
  assert.doesNotMatch(traversal, /\]\(\.\/\.\.\//)
  assert.match(traversal, /%2E%2E\/%2E%2E\/issues\/1#L1/)
})
check('markdown frames use the reviewed file language', () => {
  const rendered = markdown([{
    id: 'F1', class: 'verified', check: 'x', severity: 'low', confidence: 'proven',
    file: 'worker.py', line: 1, title: 'ordinary',
    frame: { firstLine: 1, lines: ['def work():'] },
  }])
  assert.match(rendered, /```python\ndef work\(\):\n```/)
})
check('control characters from a reviewed file never reach a terminal', () => {
  const E = String.fromCharCode(27)
  assert.equal(stripControl('a' + E + '[2J' + E + '[Hb'), 'ab')
  assert.equal(stripControl('t' + E + ']0;pwned' + String.fromCharCode(7) + 'end'), 'tend')
  assert.equal(stripControl('keep\tthe\ttabs'), 'keep\tthe\ttabs') // layout is not a control
})

console.log('\ncontrol plane')
check('a budget stops the run and names what it stopped for', () => {
  const b = new Budget({ requests: 2, elapsedMs: 10_000 }, 1000)
  assert.equal(b.exhausted(1000), undefined)
  b.spend({ requests: 2 })
  assert.match(b.exhausted(1000)!, /requests budget reached \(2\/2\)/)
  // time counts even when nothing was spent
  const t = new Budget({ elapsedMs: 500 }, 1000)
  assert.equal(t.exhausted(1400), undefined)
  assert.match(t.exhausted(1600)!, /elapsedMs budget reached/)
})
check('a budget spec is validated rather than half-understood', () => {
  assert.deepEqual(parseLimits('requests=5,elapsedMs=60000'), { requests: 5, elapsedMs: 60000 })
  assert.match(parseLimits('requessts=5') as string, /unknown budget/)
  assert.match(parseLimits('requests=0') as string, /positive/)
  assert.deepEqual(parseLimits(''), {})
})
check('every touched file lands in exactly one disposition', () => {
  const cfg = { ...loadConfig(process.cwd()), ignore: ['**/vendor/**'] }
  const changed = [
    { path: 'src/a.ts', added: new Set([1]) },
    { path: 'vendor/dep.ts', added: new Set([1]) },
  ]
  const plan = SelectionPlan.build(process.cwd(), changed, cfg)
  assert.equal(plan.items().length, 2)
  assert.deepEqual(plan.of('waived').map((i) => i.reason), ['ignored by config'])
  plan.waive('src/a.ts', 'no parser for this language')
  assert.equal(plan.keep(changed).length, 0)
  // a waived file cannot quietly become selected again
  plan.waive('src/a.ts', 'something else')
  assert.equal(plan.items().find((i) => i.path === 'src/a.ts')?.reason, 'no parser for this language')
})
check('the manifest accounts for everything it selected', () => {
  const m = new RunManifest('abc12345')
  m.ran('swallowed-error')
  m.unit({ judge: 'plausible-logic', unit: 'a.ts', outcome: 'completed', findings: 1 })
  m.unit({ judge: 'plausible-logic', unit: 'b.ts', outcome: 'reused', reason: 'cached', findings: 0 })
  const base = {
    operation: 'review', target: { requested: {} },
    policy: { source: 'base' as const, hash: 'h' },
    engine: { version: '0', tools: false, verifyOnly: false },
    files: [{
      path: 'a.ts', disposition: 'selected' as const, bytes: 1, addedLines: 1,
      language: 'typescript', checks: ['swallowed-error'],
    }],
    skippedChecks: [], findings: { total: 1, verified: 0, judged: 1, dismissed: 0, droppedPosition: 0 },
    usage: { requests: 1, inputTokens: 2, outputTokens: 3, toolCalls: 0, elapsedMs: 4, units: 1 },
    failures: [],
  }
  const ok = m.build(base)
  assert.equal(ok.state, 'complete')
  assert.deepEqual(coverageProblems(ok), [])

  const sourceFailures: string[] = []
  const snapshot = new RunManifest('snapshot').build({ ...base, failures: sourceFailures })
  sourceFailures.push('added after the manifest was built')
  assert.deepEqual(snapshot.failures, [], 'a finished manifest must not alias mutable pipeline state')

  // a unit nobody judged must not be reported as a complete run
  const m2 = new RunManifest('def45678')
  m2.unit({ judge: 'plausible-logic', unit: 'a.ts', outcome: 'waived', reason: 'requests budget reached', findings: 0 })
  const partial = m2.build(base)
  assert.equal(partial.state, 'partial', 'an unjudged unit makes the run partial')

  // and a failure anywhere means the run is not a verdict
  assert.equal(m2.build({ ...base, failures: ['judge died'] }).state, 'failed')
})
check('a manifest that hides an unreached unit is caught as our bug', () => {
  const broken = {
    schema: SCHEMA, id: 'x', operation: 'review', started: '', ended: '',
    repository: {}, target: { requested: {} }, policy: { source: 'base' as const, hash: 'h' },
    engine: { version: '0', tools: false, verifyOnly: false },
    files: [{
      path: 'a.ts', disposition: 'failed' as const, bytes: 0, addedLines: 0,
      language: 'typescript', checks: [],
    }],
    units: [{ judge: 'j', unit: 'u', outcome: 'waived' as const, findings: 0 }],
    checks: { ran: [], skipped: [] },
    findings: { total: 0, verified: 0, judged: 0, dismissed: 0, droppedPosition: 0 },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 0, units: 0 },
    state: 'complete' as const, failures: [], notLookedAt: [],
  }
  const problems = coverageProblems(broken)
  assert.ok(problems.some((p) => /never judged/.test(p)))
  assert.ok(problems.some((p) => /waived without a reason/.test(p)))
  assert.ok(problems.some((p) => /failed selection/.test(p)))
})
check('a check cannot be both run and skipped under one identity', () => {
  const broken = {
    schema: SCHEMA, id: 'x', operation: 'review', started: '', ended: '',
    repository: {}, target: { requested: {} }, policy: { source: 'base' as const, hash: 'h' },
    engine: { version: '0', tools: false, verifyOnly: true }, files: [], units: [],
    checks: { ran: ['phantom-api'], skipped: [{ check: 'phantom-api', missing: 'types' }] },
    findings: { total: 0, verified: 0, judged: 0, dismissed: 0, droppedPosition: 0 },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 0, units: 0 },
    state: 'partial' as const, failures: [], notLookedAt: ['phantom-api had no oracle'],
  }
  assert.ok(coverageProblems(broken).some((p) => /both ran and skipped/.test(p)))
})
check('global and per-file check coverage must describe the same work', () => {
  const base = {
    schema: SCHEMA, id: 'x', operation: 'review', started: '', ended: '',
    repository: {}, target: { requested: {} }, policy: { source: 'base' as const, hash: 'h' },
    engine: { version: '0', tools: false, verifyOnly: true }, units: [],
    findings: { total: 0, verified: 0, judged: 0, dismissed: 0, droppedPosition: 0 },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, elapsedMs: 0, units: 0 },
    state: 'failed' as const, failures: ['broken coverage'], notLookedAt: ['broken coverage'],
  }
  const onlyGlobal = {
    ...base,
    files: [{
      path: 'a.ts', disposition: 'selected' as const, bytes: 1, addedLines: 1,
      language: 'typescript', checks: [],
    }],
    checks: { ran: ['phantom-api'], skipped: [] },
  }
  assert.ok(coverageProblems(onlyGlobal).some((p) => /received no selected file/.test(p)))

  const onlyFile = {
    ...base,
    files: [{
      path: 'a.ts', disposition: 'selected' as const, bytes: 1, addedLines: 1,
      language: 'typescript', checks: ['phantom-api', 'phantom-api'],
    }],
    checks: { ran: [], skipped: [] },
  }
  const problems = coverageProblems(onlyFile)
  assert.ok(problems.some((p) => /not recorded as ran/.test(p)))
  assert.ok(problems.some((p) => /received check twice/.test(p)))
})
check('bench refuses to score a result with per-file or oracle gaps', () => {
  const result = {
    findings: [], stats: { files: 1, verified: 0, judged: 0, dismissed: 0 }, failures: [],
    plan: { items: () => [{ path: 'outside.ts', disposition: 'selected', missing: ['types'] }] },
    skippedChecks: [{ check: 'foreign-phantom-api', missing: 'python-types' }],
  } as unknown as import('./review.js').ReviewResult
  assert.deepEqual(incompleteReasons(result), [
    '1 file(s) reviewed with fewer checks than the rest: outside.ts (no types)',
    '1 check(s) had no oracle to run against: foreign-phantom-api (no python-types)',
  ])
})
check('every check declares what it needs, and is skipped without it', () => {
  for (const v of VERIFIERS) {
    assert.ok(Array.isArray(v.needs) && v.needs.length > 0, v.name + ' must declare what it needs')
  }
  // a scan has no base version, so the before/after checks must not silently pass
  const noBase = capabilitiesOf({ typed: false, foreign: [], changed: [{ path: 'a.ts', added: new Set([1]) }] } as never)
  assert.equal(noBase.has('base'), false)
  assert.equal(noBase.has('references'), false)
  assert.equal(noBase.has('syntax'), true)
  const full = capabilitiesOf({ typed: true, foreign: [], changed: [{ path: 'a.ts', added: new Set([1]), before: 'x' }] } as never)
  assert.equal(full.has('references'), true)
  assert.equal(full.has('base'), true)
})
check('a check with no oracle behind it is skipped, not recorded as satisfied', () => {
  // a repository with a tsconfig and some Python in it must not satisfy the Python
  // check through the TypeScript checker — they are different oracles
  const py = [{ pack: { name: 'python' } }] as never
  const withTs = capabilitiesOf({ typed: true, foreign: py, changed: [], root: process.cwd() } as never)
  assert.equal(withTs.has('types'), true)
  assert.equal(withTs.has('python-types'), pyrightAvailable(process.cwd()))
  // and phantom-api for Python asks for exactly that one
  const check = VERIFIERS.find((v) => v.name === 'phantom-api' && v.needs.includes('python-types'))
  assert.ok(check, 'the python member check must declare python-types')
})
check('a provider failure says what kind it is, with no key in the message', () => {
  const e = new ProviderError('auth', 'Anthropic', 'bad key sk-abcdefghijklmnop in header')
  assert.equal(e.kind, 'auth')
  assert.equal(e.retryable, false)
  assert.ok(!e.message.includes('sk-abcdefghijklmnop'), 'a key must never reach a message')
  assert.equal(redact('authorization: Bearer abcdefghijklmnop'), 'authorization: Bearer <redacted>')
  assert.equal(redact('{"api_key":"AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01"}'), '{"api_key":"<redacted>"}')
})

console.log('\nthe repository must not steer its reviewer')
await checkAsync('a ref is validated before anything reads one', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-ref2-')))
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  run('add', '-A'); run('commit', '-qm', 'seed')

  // every ref reaches git through a different call — policy, snapshot, diff, intent —
  // so the check has to be at the entrance, not inside the one that happened to be
  // audited. Reading the policy resolved `--commit` to `<ref>^` and wrote a file.
  const written = join(dir, 'proof')
  for (const range of [
    { commit: '--output=' + written },
    { from: '--output=' + written, to: 'HEAD' },
    { from: 'HEAD', to: '--output=' + written },
  ]) {
    assert.throws(() => checkRange(dir, range), /looks like an option/)
  }
  assert.equal(readdirSync(dir).some((n) => n.startsWith('proof')), false, 'no file may have been written')
  rmSync(dir, { recursive: true, force: true })
})
check('a file the tsconfig does not own is read, not type-checked', () => {
  // asking the checker for diagnostics on a file it has no program for throws from
  // inside TypeScript, which took down the whole review — including our own
  const g = ground([{ path: 'a.ts', after: 'export const a = 1\n' }])
  g.files[0]!.typed = false
  assert.deepEqual(phantomApi.run({ ...g, typed: true }), [])
})
await checkAsync('per-file limits follow the checks the caller actually selected', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-capabilities-')))
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['inside.ts'] }))
    writeFileSync(join(dir, 'inside.ts'), 'export const inside = 1\n')
    writeFileSync(join(dir, 'outside.ts'), 'export const outside = 1\n')
    const changes = [{ path: 'outside.ts', added: new Set([1]) }]
    const common = { root: dir, range: {}, changes, config: loadConfig(dir), verifyOnly: true }
    const stateOf = (result: import('./review.js').ReviewResult): string => new RunManifest('cap-test').build({
      operation: 'scan', target: { requested: {} }, policy: { source: 'default', hash: 'h' },
      engine: { version: '0', tools: false, verifyOnly: true }, files: result.plan?.items() ?? [],
      skippedChecks: result.skippedChecks ?? [],
      findings: { total: result.findings.length, verified: result.stats.verified, judged: result.stats.judged,
        dismissed: result.stats.dismissed, droppedPosition: 0 },
      usage: result.usage!, failures: result.failures,
    }).state

    const syntaxOnly = await review({ ...common, checks: ['swallowed-error'] })
    assert.deepEqual(syntaxOnly.plan?.items()[0]?.missing, undefined)
    assert.deepEqual(syntaxOnly.skippedChecks, [])
    assert.equal(stateOf(syntaxOnly), 'complete')

    const typed = await review({ ...common, checks: ['phantom-api'] })
    assert.deepEqual(typed.plan?.items()[0]?.missing, ['types'])
    assert.deepEqual(typed.skippedChecks, [{ check: 'phantom-api', missing: 'types' }])
    assert.equal(stateOf(typed), 'partial')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await checkAsync('foreign checks advertise only files their language pack can inspect', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-pack-coverage-')))
  try {
    writeFileSync(join(dir, 'existing.rb'), 'def existing\n  true\nend\n')
    const changes = [{
      path: 'existing.rb',
      added: new Set([2]),
      before: 'def existing\n  false\nend\n',
    }]
    const manifest = new RunManifest('ruby-coverage')
    const result = await review({
      root: dir,
      range: {},
      changes,
      config: loadConfig(dir),
      verifyOnly: true,
      checks: ['foreign-phantom-dep', 'foreign-vacuous-test', 'foreign-lying-comment'],
      manifest,
    })
    const record = manifest.build({
      operation: 'scan', target: { requested: {} }, policy: { source: 'default', hash: 'h' },
      engine: { version: '0', tools: false, verifyOnly: true }, files: result.plan!.items(),
      skippedChecks: result.skippedChecks ?? [],
      findings: { total: result.findings.length, verified: result.stats.verified, judged: result.stats.judged,
        dismissed: result.stats.dismissed, droppedPosition: 0 },
      usage: result.usage!, failures: result.failures,
    })
    assert.deepEqual(record.checks.ran, ['foreign-phantom-dep'])
    assert.deepEqual(record.files[0]!.checks, ['foreign-phantom-dep'])
    assert.equal(record.state, 'complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await checkAsync('base applicability is scoped to the verifier language and file', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-pack-base-')))
  try {
    writeFileSync(join(dir, 'existing.rb'), 'def existing\n  true\nend\n')
    writeFileSync(join(dir, 'new.py'), 'def added(value: str) -> str:\n    return value\n')
    const changes = [
      { path: 'existing.rb', added: new Set([2]), before: 'def existing\n  false\nend\n' },
      { path: 'new.py', added: new Set([1, 2]) },
    ]
    const manifest = new RunManifest('mixed-base')
    const result = await review({
      root: dir, range: {}, changes, config: loadConfig(dir), verifyOnly: true,
      checks: ['foreign-contract-drift'], manifest,
    })
    const record = manifest.build({
      operation: 'scan', target: { requested: {} }, policy: { source: 'default', hash: 'h' },
      engine: { version: '0', tools: false, verifyOnly: true }, files: result.plan!.items(),
      skippedChecks: result.skippedChecks ?? [],
      findings: { total: result.findings.length, verified: result.stats.verified, judged: result.stats.judged,
        dismissed: result.stats.dismissed, droppedPosition: 0 },
      usage: result.usage!, failures: result.failures,
    })
    assert.deepEqual(record.checks, { ran: [], skipped: [] })
    assert.deepEqual(record.files.map((file) => file.checks), [[], []])
    assert.equal(record.files.some((file) => file.missing?.includes('python-types')), false)
    assert.equal(record.state, 'complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('CLI rejects selections that would otherwise run nothing and report clean', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'psh-cli-checks-')))
  const cli = join(process.cwd(), 'dist', 'cli.js')
  const status = (args: string[]): number => {
    try {
      execFileSync(process.execPath, [cli, ...args], {
        cwd: dir,
        env: { ...process.env, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return 0
    } catch (error) {
      return (error as { status?: number }).status ?? -1
    }
  }
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir })
    writeFileSync(join(dir, 'example.rb'), 'def example\n  true\nend\n')
    writeFileSync(join(dir, 'bad.json'), '{not json')
    writeFileSync(join(dir, 'empty.json'), '[]')
    assert.equal(status(['scan', 'example.rb', '--verify-only', '--checks', ',', '--format', 'manifest']), 2)
    assert.equal(status(['scan', 'example.rb', '--verify-only', '--checks', 'plausible-logic', '--format', 'manifest']), 2)
    assert.equal(status(['delegate', '--checks', 'phantom-api']), 2)
    assert.equal(status(['delegate']), 0)
    assert.equal(existsSync(join(dir, '.powershot', 'sessions')), false, 'delegate must not create an unused session')
    assert.equal(status(['scan', 'example.rb', '--format', 'unknown']), 2)
    assert.equal(status(['scan', 'example.rb', '--report', 'unknown=report.txt']), 2)
    assert.equal(status(['scan', 'example.rb', '--budget', 'requests=zero']), 2)
    assert.equal(existsSync(join(dir, '.powershot', 'sessions')), false, 'bad usage must fail before session creation')
    assert.equal(status(['scan', 'example.rb', '--absorb', 'bad.json', '--format', 'manifest']), 2)
    assert.equal(status(['scan', 'example.rb', '--absorb=', '--format', 'manifest']), 2)
    assert.equal(existsSync(join(dir, '.powershot', 'sessions')), false, 'invalid absorb must fail before session creation')
    assert.equal(status(['scan', 'example.rb', '--verify-only', '--absorb', 'empty.json', '--format', 'manifest']), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
check('a budget stop is partial and the manifest names what was not reviewed', () => {
  const b = new Budget({ requests: 1 }, 0)
  b.spend({ requests: 1 })
  assert.ok(b.exhausted(0), 'the budget is spent')
  const m = new RunManifest('bbb11111')
  m.unit({ judge: 'plausible-logic', unit: 'a.ts', outcome: 'waived', reason: 'requests budget reached (1/1)', findings: 0 })
  const built = m.build({
    operation: 'review', target: { requested: {} }, policy: { source: 'base' as const, hash: 'h' },
    engine: { version: '0', tools: false, verifyOnly: false }, files: [], skippedChecks: [],
    findings: { total: 0, verified: 0, judged: 0, dismissed: 0, droppedPosition: 0 },
    usage: b.used, failures: [],
    budgetStop: 'requests budget reached (1/1)',
  })
  assert.equal(built.state, 'partial', 'a planned limit is not an execution failure')
  assert.deepEqual(built.failures, [])
  assert.ok(built.notLookedAt.some((reason) => /stopped early: requests budget reached/.test(reason)))
})

console.log('')
if (failures > 0) {
  console.error(failures + ' check(s) failed')
  process.exit(1)
}
console.log('all checks passed')
