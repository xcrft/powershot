/**
 * Language pack checks, one process per language.
 *
 * They cannot share a process: V8 tiers up each wasm grammar in the background, and
 * eleven of them together drove RSS past 690MB and killed the run. A child per
 * language costs a second and keeps every pack genuinely covered rather than
 * shrinking the suite to fit a limit.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { PACKS, parse } from './lang/packs.js'
import { tokensFor } from './verifiers/foreign.js'

/** each fixture: a handler that discards, one that genuinely handles, one explained */
const FIXTURES: Record<string, string> = {
  python:
    'def f():\n    try:\n        a()\n    except Exception:\n        pass\n    try:\n        b()\n    except Exception as e:\n        raise RuntimeError("x") from e\n    try:\n        c()\n    except Exception:\n        pass  # deliberate\n',
  go: 'package m\nfunc F() error {\n\tif err := a(); err != nil {\n\t}\n\tif err := b(); err != nil {\n\t\treturn err\n\t}\n\tif err := c(); err != nil {\n\t\t// deliberate\n\t}\n\treturn nil\n}\n',
  java: 'class A {\n  void f() {\n    try { a(); } catch (Exception e) { }\n    try { b(); } catch (Exception e) { throw new RuntimeException(e); }\n    try { c(); } catch (Exception e) { /* deliberate */ }\n  }\n}\n',
  // `let _ = a()` is Rust's own "on purpose" marker and must NOT be reported; the
  // empty Err arm is the one with no such marker
  rust: 'fn f() {\n    let _ = a();\n    match x() { Err(_) => {}, Ok(v) => v };\n    match b() { Err(e) => return Err(e), Ok(v) => v };\n}\n',
  cpp: 'void f() {\n  try { a(); } catch (...) { }\n  try { b(); } catch (const std::exception& e) { throw; }\n  try { c(); } catch (...) { /* deliberate */ }\n}\n',
  c: 'int f(int n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n',
  'c#': 'class A {\n  void F() {\n    try { A(); } catch (Exception e) { }\n    try { B(); } catch (Exception e) { throw; }\n    try { C(); } catch (Exception e) { /* deliberate */ }\n  }\n}\n',
  php: '<?php\nfunction f() {\n  try { a(); } catch (Exception $e) { }\n  try { b(); } catch (Exception $e) { throw $e; }\n  try { c(); } catch (Exception $e) { /* deliberate */ }\n}\n',
  kotlin: 'fun f() {\n  try { a() } catch (e: Exception) {}\n  try { b() } catch (e: Exception) { throw e }\n  try { c() } catch (e: Exception) { /* deliberate */ }\n}\n',
  solidity: 'contract A {\n  function f() public {\n    try a() { } catch { }\n    try b() { } catch { revert("x"); }\n    try c() { } catch { /* deliberate */ }\n  }\n}\n',
  ruby: 'def f\n  begin\n    a\n  rescue => e\n  end\n  begin\n    b\n  rescue => e\n    raise\n  end\n  begin\n    c\n  rescue => e\n    # deliberate\n  end\nend\n',
}

/** the handler in each fixture that genuinely handles, and must never be reported */
const HANDLED: Record<string, string> = {
  python: 'raise RuntimeError', go: 'return err', java: 'throw new RuntimeException',
  rust: 'return Err(e)', cpp: 'throw;', 'c#': 'throw;', php: 'throw $e',
  kotlin: 'throw e', ruby: 'raise', solidity: 'revert("x")',
}

async function one(name: string): Promise<number> {
  const pack = PACKS.find((p) => p.name === name)
  if (!pack) {
    console.error('no pack named ' + name)
    return 1
  }
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   ' + name + ': ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL ' + name + ': ' + label + '\n       ' + (e as Error).message)
    }
  }

  const source = FIXTURES[name]
  const tree = source === undefined ? undefined : await parse(pack, source)

  check('has a fixture, so it is never asserted against another language', () => {
    assert.ok(source !== undefined, 'no fixture written')
  })
  check('the grammar loads and parses', () => {
    assert.ok(tree, 'failed to parse — grammar missing or ABI mismatch')
  })
  check('declares the node names the generic checks need', () => {
    for (const key of ['identifier', 'comment', 'ifStatement', 'bail', 'declaration', 'block'] as const) {
      assert.ok((pack.nodes[key] as string[]).length > 0, 'no ' + key)
    }
  })

  const hits = tree ? pack.swallowedError?.(tree.rootNode) ?? [] : []
  if (name === 'c') {
    check('does not advertise an exception oracle the language cannot supply', () => {
      assert.equal(pack.swallowedError, undefined)
    })
  } else {
    check('finds the idiom that discards a failure', () => {
      assert.ok(hits.length >= 1, 'found none')
    })
    check('stays silent where a comment states the intent', () => {
      assert.equal(hits.some((h) => /deliberate/.test(h.node.text)), false, 'reported an explained handler')
    })
    check('leaves a properly handled error alone', () => {
      assert.equal(hits.some((h) => h.node.text.includes(HANDLED[name]!)), false, 'reported a real handler')
    })
  }
  return failed
}

/** Signature comparison is Python-only for now, and is what decides a contract break. */
async function pythonSignatures(): Promise<number> {
  const pack = PACKS.find((p) => p.name === 'python')!
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   python signatures: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL python signatures: ' + label + '\n       ' + (e as Error).message)
    }
  }

  const of = async (src: string) => {
    const tree = await parse(pack, src)
    return pack.signatures!(tree!.rootNode)
  }

  const one = await of('def send(to: str) -> bool:\n    return True\n')
  const two = await of('def send(to: str, subject: str) -> bool:\n    return True\n')
  const defaulted = await of('def send(to: str, subject: str = "hi") -> bool:\n    return True\n')
  const splat = await of('def send(to: str, *args, **kwargs) -> bool:\n    return True\n')
  const method = await of('class A:\n    def send(self, to: str) -> bool:\n        return True\n')

  check('counts what a caller must supply', () => {
    assert.equal(one.get('send')!.required, 1)
    assert.equal(two.get('send')!.required, 2)
  })
  check('a default does not demand anything of a caller', () => {
    assert.equal(defaulted.get('send')!.required, 1)
  })
  check('*args and **kwargs demand nothing', () => {
    assert.equal(splat.get('send')!.required, 1)
  })
  check('self is bound, not passed', () => {
    assert.equal(method.get('send')!.required, 1)
  })
  return failed
}

/** Test and docstring conventions are per-language data; these are Python's. */
async function pythonConventions(): Promise<number> {
  const pack = PACKS.find((p) => p.name === 'python')!
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   python conventions: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL python conventions: ' + label + '\n       ' + (e as Error).message)
    }
  }
  const tests = async (src: string) => pack.tests!((await parse(pack, src))!.rootNode)
  const docs = async (src: string) => pack.documentedParams!((await parse(pack, src))!.rootNode)
  const Q = '"' + '"' + '"'

  const bare = await tests('def test_a():\n    do_work()\n')
  const asserted = await tests('def test_a():\n    assert do_work() == 1\n')
  const unittest = await tests('class T:\n    def test_a(self):\n        self.assertEqual(do_work(), 1)\n')
  const raises = await tests('def test_a():\n    with pytest.raises(ValueError):\n        do_work()\n')
  const placeholder = await tests('def test_a():\n    pass\n')

  check('a test that runs code and proves nothing is caught', () => {
    assert.equal(bare[0]!.provesNothing, true)
  })
  check('a plain assert counts as proof', () => {
    assert.equal(asserted[0]!.provesNothing, false)
  })
  check('unittest assertion methods count as proof', () => {
    assert.equal(unittest[0]!.provesNothing, false)
  })
  check('a raises block counts as proof', () => {
    assert.equal(raises[0]!.provesNothing, false)
  })
  check('a placeholder body is not a claim that came out empty', () => {
    assert.equal(placeholder[0]!.provesNothing, false)
  })
  check('an assertion exposes what it asserts about, for drift', () => {
    assert.equal(asserted[0]!.assertions[0]!.subject, 'do_work()')
    assert.equal(asserted[0]!.assertions[0]!.expected, '1')
    assert.equal(unittest[0]!.assertions[0]!.expected, '1')
  })

  const google = await docs('def f(a, b):\n    ' + Q + 'Do it.\n\n    Args:\n        a: first\n        c: nope\n    ' + Q + '\n    return a\n')
  const rest = await docs('def f(a):\n    ' + Q + 'Do it.\n\n    :param a: first\n    :param z: nope\n    ' + Q + '\n    return a\n')
  const undocumented = await docs('def f(a):\n    return a\n')

  check('a Google-style Args block is read', () => {
    assert.deepEqual(google[0]!.documented.map((d) => d.name), ['a', 'c'])
    assert.deepEqual(google[0]!.declared, ['a', 'b'])
  })
  check('a reST :param: block is read', () => {
    assert.deepEqual(rest[0]!.documented.map((d) => d.name), ['a', 'z'])
  })
  check('a function with no docstring makes no claim to contradict', () => {
    assert.equal(undocumented.length, 0)
  })
  return failed
}

/** A change inside a string literal must never read as "formatting only". */
async function literalsAreVisible(): Promise<number> {
  let failed = 0
  const check = (label: string, fn: () => void): void => {
    try {
      fn()
      console.log('  ok   literals: ' + label)
    } catch (e) {
      failed++
      console.log('  FAIL literals: ' + label + '\n       ' + (e as Error).message)
    }
  }

  const sample: Record<string, (v: string) => string> = {
    rust: (v) => 'fn f() { let x = "' + v + '"; }',
    go: (v) => 'package m\nvar x = "' + v + '"\n',
    java: (v) => 'class A { String x = "' + v + '"; }',
    cpp: (v) => 'auto x = "' + v + '";',
    python: (v) => 'x = "' + v + '"\n',
    ruby: (v) => 'x = "' + v + '"\n',
  }

  for (const [name, build] of Object.entries(sample)) {
    const pack = PACKS.find((p) => p.name === name)
    if (!pack) continue
    const a = await parse(pack, build('alpha_e_gguf'))
    const b = await parse(pack, build('alpha_d_gguf'))
    check(name + ': a changed string literal is part of the token stream', () => {
      assert.ok(a && b)
      assert.notEqual(
        JSON.stringify(tokensFor(a.rootNode, pack)),
        JSON.stringify(tokensFor(b.rootNode, pack)),
        name + ' tokenizes two different strings identically',
      )
    })
  }
  return failed
}

async function main(): Promise<number> {
  const target = process.argv[2]
  if (target) return one(target)

  console.log('\nlanguage packs (one process each)')
  let failed = (await pythonSignatures()) + (await pythonConventions()) + (await literalsAreVisible())
  for (const pack of PACKS) {
    try {
      process.stdout.write(execFileSync(process.execPath, [process.argv[1]!, pack.name], { encoding: 'utf8' }))
    } catch (e) {
      const err = e as { stdout?: string; status?: number | null; signal?: string | null }
      process.stdout.write(err.stdout ?? '')
      // a child killed by the runtime rather than by a failed assertion
      if (err.status === null || err.signal) {
        console.log('  FAIL ' + pack.name + ': the process died (' + (err.signal ?? 'no exit code') + ')')
      }
      failed++
    }
  }
  return failed
}

main().then((failed) => {
  // only the parent summarises; a child reports just its own language
  if (!process.argv[2]) {
    if (failed > 0) console.error('\n' + failed + ' language pack(s) failed')
    else console.log('\nall ' + PACKS.length + ' language packs pass')
  }
  // Deliberately not process.exit(): V8 is still compiling the wasm grammar in the
  // background, and tearing the process down underneath that work crashes it. Setting
  // the code and letting the loop drain costs nothing and ends cleanly.
  process.exitCode = failed > 0 ? 1 : 0
})
