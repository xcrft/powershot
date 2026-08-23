import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decode } from '#app/text.js'

/**
 * Python's top-level standard library. A name that is here needs no dependency, and a
 * name that is missing from here would be reported — so an incomplete list produces
 * false positives, which is why this is the full 3.12 set rather than a sample.
 */
const STDLIB = new Set(
  ('abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 ' +
    'calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser ' +
    'contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis ' +
    'distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ' +
    'ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib ' +
    'imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma ' +
    'mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib ' +
    'ntpath numbers operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib ' +
    'poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline ' +
    'reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib ' +
    'sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string ' +
    'stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios ' +
    'test textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle ' +
    'types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref ' +
    'xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__ _thread').split(' '),
)

/**
 * Import names that differ from the distribution that provides them. Without this a
 * project depending on PyYAML looks like it forgot `yaml`, which is the kind of
 * confident wrong answer this tool exists to avoid.
 */
const DISTRIBUTION: Record<string, string> = {
  yaml: 'pyyaml', cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4', dateutil: 'python-dateutil', jwt: 'pyjwt', dotenv: 'python-dotenv',
  serial: 'pyserial', attr: 'attrs', google: 'protobuf', OpenSSL: 'pyopenssl',
  pkg_resources: 'setuptools', setuptools: 'setuptools', magic: 'python-magic',
  psycopg2: 'psycopg2-binary', redis: 'redis', mysql: 'mysql-connector-python',
  docx: 'python-docx', pptx: 'python-pptx', fitz: 'pymupdf', win32api: 'pywin32',
}

/**
 * The distribution named by one requirement.
 *
 * A PEP 508 requirement carries its version and extras inside the quotes —
 * `sqlalchemy[asyncio]>=2.0.48` — so the name is the leading run of name characters,
 * not the whole string. Requiring the whole quoted string to be a bare name is what
 * made 91 declared dependencies look missing on one real repository.
 */
function requirementName(entry: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(entry)
  return m?.[1]
}

/**
 * Dependency names from a manifest, read section by section rather than by scanning
 * every quoted string — a pyproject.toml is full of quoted words that are not
 * packages, and treating them all as declared would hide real findings.
 */
function dependencyNames(text: string, file: string): string[] {
  const out: string[] = []

  if (file.endsWith('.txt')) {
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue
      const name = requirementName(line)
      if (name) out.push(normalize(name))
    }
    return out
  }

  // PEP 621 and setuptools: `dependencies = [...]`, plus optional-dependency groups.
  // The array ends at a bracket that starts a line: an extras marker such as
  // `uvicorn[standard]>=0.42` carries a `]` of its own, and a lazy match to any
  // bracket stops there, silently dropping every requirement after it.
  for (const block of text.matchAll(/dependencies\s*=\s*\[([\s\S]*?)^\s*\]/gm)) {
    for (const entry of (block[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
      const name = requirementName(entry[1] ?? '')
      if (name) out.push(normalize(name))
    }
  }

  for (const section of text.split(/^\[/m)) {
    // Poetry and Pipfile list one package per line: `name = "^1.0"`
    if (/^(tool\.poetry[a-z.]*dependencies|packages|dev-packages)\]/.test(section)) {
      for (const line of section.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["'{]/.exec(line)
        if (m?.[1]) out.push(normalize(m[1]))
      }
    }
    // Optional-dependency and PEP 735 groups nest arrays under a group name, so the
    // key is `dev` rather than `dependencies` and the packages are inside the array
    if (/^(project\.optional-dependencies|dependency-groups|tool\.uv)\]/.test(section)) {
      for (const entry of section.matchAll(/["']([^"']+)["']/g)) {
        const name = requirementName(entry[1] ?? '')
        if (name) out.push(normalize(name))
      }
    }
  }
  return out
}

/** PyPI treats `-`, `_` and `.` alike, and is case-insensitive. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const MANIFESTS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'requirements-dev.txt']

/**
 * Declared dependencies visible to one file.
 *
 * A Python monorepo declares pydantic in backend/classifications/pyproject.toml and
 * nowhere else, so reading only the repository root calls every real dependency
 * phantom — measured at 270 findings on one real repository. Every manifest from the
 * file's own directory up to the root counts.
 */
export function pythonManifest(root: string, from = root): { names: Set<string>; file: string } | undefined {
  const found: string[] = []
  const names = new Set<string>()
  const dirs: string[] = []
  for (let dir = from; ; dir = dirname(dir)) {
    dirs.push(dir)
    if (dir === root || dirname(dir) === dir) break
  }

  for (const dir of dirs) {
  for (const file of MANIFESTS) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    if (!found.includes(file)) found.push(file)
    const text = decode(readFileSync(path))

    for (const name of dependencyNames(text, file)) names.add(name)
  }
  }
  return found.length > 0 ? { names, file: found.join(', ') } : undefined
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build',
  '.mypy_cache', '.pytest_cache', '.tox', 'site-packages', 'target', '.next',
])

export function localModules(root: string): Set<string> {
  const local = new Set<string>()

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || local.size > 4000) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const isPackage = entries.some((e) => e.isFile() && e.name === '__init__.py')
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      if (entry.isDirectory()) {
        // a package directory is importable by name; so is a plain source folder
        local.add(entry.name)
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.name.endsWith('.py') && (isPackage || depth <= 2)) {
        local.add(entry.name.slice(0, -3))
      }
    }
  }
  walk(root, 0)
  return local
}

export function isPhantom(
  importName: string,
  manifest: { names: Set<string> },
  local: Set<string>,
): boolean {
  const top = importName.split('.')[0] ?? importName
  if (STDLIB.has(top) || local.has(top)) return false
  const candidates = [normalize(top), normalize(DISTRIBUTION[top] ?? top)]
  return !candidates.some((c) => manifest.names.has(c))
}
