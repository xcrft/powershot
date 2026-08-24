// Install one tarball into an empty project and exercise the public binary. When a
// path is supplied, this script never packs again: release can test and publish the
// exact bytes whose checksum it recorded.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'powershot-smoke-'))
const supplied = process.argv[2]
const packageName = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name: string }).name
const run = (command: string, args: string[], cwd = dir): string =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

type CommandFailure = Error & { status?: number; stderr?: string | Buffer; stdout?: string | Buffer }

let failed = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failed++
    const failure = error as CommandFailure
    console.log('  FAIL ' + name + '\n       ' + String(failure.stderr ?? failure.message))
  }
}

try {
  let tarball: string
  if (supplied) {
    tarball = resolve(repo, supplied)
    if (!existsSync(tarball)) throw new Error('tarball does not exist: ' + tarball)
    console.log('using ' + tarball)
  } else {
    console.log('packing')
    run('npm', ['pack', '--pack-destination', dir], repo)
    const packed = readdirSync(dir).find((file) => file.endsWith('.tgz'))
    if (!packed) throw new Error('npm pack produced no tarball')
    tarball = join(dir, packed)
  }

  console.log('installing into a clean tree')
  writeFileSync(join(dir, 'package.json'), '{"name":"smoke","private":true}')
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', tarball])
  run('git', ['init', '-q', '.'])
  run('git', ['config', 'user.email', 'smoke@test'])
  run('git', ['config', 'user.name', 'smoke'])
  writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}')
  writeFileSync(join(dir, 'a.ts'), 'export function f() {\n  try { JSON.parse("{}") } catch {}\n}\n')
  run('git', ['add', '-A'])
  run('git', ['commit', '-qm', 'seed'])

  const bin = (name: string): string =>
    join(dir, 'node_modules', '.bin', process.platform === 'win32' ? name + '.cmd' : name)
  const psh = bin('psh')
  const powershot = bin('powershot')

  console.log('\nsmoke')
  check('both public commands are linked and print help', () => {
    if (!run(psh, ['--help']).includes('psh review')) throw new Error('unexpected help output')
    if (!run(powershot, ['--help']).includes('psh review')) throw new Error('unexpected long-command help output')
  })
  check('the package ships architecture and CI examples', () => {
    const installed = join(dir, 'node_modules', ...packageName.split('/'))
    if (!existsSync(join(installed, 'docs', 'architecture.md'))) throw new Error('architecture guide is missing')
    if (!existsSync(join(installed, 'docs', 'ci.md'))) throw new Error('CI guide is missing')
    if (!existsSync(join(installed, 'dist', 'github', 'inline-comments.js'))) throw new Error('inline review runtime is missing')
    if (!existsSync(join(installed, 'dist', 'github', 'summary-comment.js'))) throw new Error('summary comment runtime is missing')
    if (!existsSync(join(installed, 'examples', 'github-actions', 'cli.yml'))) throw new Error('CI example is missing')
    if (!existsSync(join(installed, 'examples', 'gitlab', '.gitlab-ci.yml'))) throw new Error('GitLab example is missing')
  })
  check('a scan from the installed package finds a real defect', () => {
    try {
      run(psh, ['scan', 'a.ts', '--verify-only', '--format', 'compact'])
      throw new Error('expected exit 1 for a finding')
    } catch (error) {
      const failure = error as CommandFailure
      if (failure.status !== 1) throw error
      if (!String(failure.stdout).includes('swallowed-error')) throw new Error('no finding: ' + String(failure.stdout))
    }
  })
  check('a clean tree exits 0', () => {
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    run(psh, ['scan', 'b.ts', '--verify-only'])
  })
  check('a bundled foreign-language pack loads', () => {
    writeFileSync(join(dir, 'c.py'), 'def f():\n    try:\n        g()\n    except Exception:\n        pass\n')
    try {
      run(psh, ['scan', 'c.py', '--verify-only', '--checks', 'foreign-swallowed-error', '--format', 'compact'])
      throw new Error('expected a finding from the python pack')
    } catch (error) {
      if ((error as CommandFailure).status !== 1) throw error
    }
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failed > 0) {
  console.error(failed + ' smoke check(s) failed')
  process.exit(1)
}
console.log('the package artifact works')
