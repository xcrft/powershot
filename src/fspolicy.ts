import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const DENIED_SEGMENT = /^(\.env(\..+)?|\.git|\.ssh|id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc)$/i
const DENIED_FILE = /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i
const ENV_TEMPLATE = /^\.env\.(example|sample|template|defaults|dist)$/i

export function deniedPath(path: string): boolean {
  const segments = path.split(/[\\/]/)
  return segments.some((s) => !ENV_TEMPLATE.test(s) && DENIED_SEGMENT.test(s)) ||
    DENIED_FILE.test(segments[segments.length - 1] ?? '')
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Stable repository path for manifests, findings, filters, and machine output. */
export function repoPath(root: string, path: string): string {
  const slash = (value: string): string => value.replace(/\\/g, '/')
  const base = slash(root).replace(/\/+$/, '') || '/'
  const file = slash(path)
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

  if (fold(file) === fold(base)) return ''
  if (fold(file).startsWith(fold(base) + '/')) return file.slice(base.length + 1)
  if (!isAbsolute(path) && !/^[A-Za-z]:\//.test(file)) return file.replace(/^\.\/+/, '')
  return slash(relative(root, path))
}

/** The absolute path to read, or undefined when reading it would leave the repository. */
export function insideRepo(root: string, path: string): string | undefined {
  const base = resolve(root)
  const abs = resolve(base, path)
  if (!contained(base, abs)) return undefined
  if (deniedPath(abs)) return undefined

  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return abs // does not exist yet; nothing to follow, and the read will fail plainly
  }
  const realRoot = (() => {
    try {
      return realpathSync(base)
    } catch {
      return base
    }
  })()
  if (!contained(realRoot, real)) return undefined
  if (deniedPath(real)) return undefined
  return abs
}

/** True for a link, whether or not it points anywhere legitimate. */
export function isSymlink(abs: string): boolean {
  return lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}
