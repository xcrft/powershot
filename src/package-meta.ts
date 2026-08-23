import { createRequire } from 'node:module'

type PackageMetadata = {
  name?: string
  version?: string
  homepage?: string
}

const metadata: PackageMetadata = (() => {
  try {
    return createRequire(import.meta.url)('../package.json') as PackageMetadata
  } catch {
    return {}
  }
})()

export const PACKAGE_NAME = metadata.name ?? '@0xcraft/powershot'
export const PACKAGE_VERSION = metadata.version ?? 'unknown'
export const PACKAGE_HOMEPAGE = metadata.homepage ?? 'https://github.com/xcrft/powershot'
