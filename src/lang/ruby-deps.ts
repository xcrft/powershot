import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '#app/text.js'

/** Ruby's standard library and default gems, by the name you require. */
const STDLIB = new Set(
  ('abbrev base64 benchmark bigdecimal cgi coverage csv date delegate digest drb english erb etc expect fcntl ' +
    'fiddle fileutils find forwardable getoptlong io ipaddr irb json logger matrix minitest monitor mutex_m net ' +
    'nkf objspace observer open-uri open3 openssl optparse ostruct pathname pp prettyprint prime pstore psych ' +
    'racc rake rdoc readline reline resolv rexml rinda ripper rss rubygems securerandom set shellwords singleton ' +
    'socket stringio strscan syslog tempfile test time timeout tmpdir tsort un uri weakref yaml zlib ' +
    'English Set').split(' '),
)

/**
 * Requires whose name differs from the gem that provides them. Rails is the reason
 * this table exists: a Gemfile says `rails`, and the code requires `active_record`.
 */
const GEM_FOR: Record<string, string> = {
  active_record: 'rails', active_support: 'rails', action_pack: 'rails', action_view: 'rails',
  action_mailer: 'rails', active_job: 'rails', active_storage: 'rails', action_cable: 'rails',
  rails_helper: 'rails', sinatra: 'sinatra', sequel: 'sequel', nokogiri: 'nokogiri',
  httparty: 'httparty', rspec: 'rspec', sidekiq: 'sidekiq', pry: 'pry', puma: 'puma',
  jwt: 'jwt', redis: 'redis', pg: 'pg', mysql2: 'mysql2', dotenv: 'dotenv',
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_]+/g, '-')
}

/** Gems declared in the Gemfile or a gemspec. */
export function rubyManifest(root: string): { names: Set<string>; file: string } | undefined {
  const names = new Set<string>()
  const found: string[] = []

  const files = ['Gemfile', ...(existsSync(root) ? readdirSync(root).filter((f) => f.endsWith('.gemspec')) : [])]
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    found.push(file)
    const text = decode(readFileSync(path))
    // `gem "name"` in a Gemfile, `add_dependency "name"` in a gemspec
    for (const m of text.matchAll(/(?:^\s*gem|add(?:_runtime|_development)?_dependency)\s*[( ]\s*["']([^"']+)["']/gm)) {
      if (m[1]) names.add(normalize(m[1]))
    }
  }
  return found.length > 0 ? { names, file: found.join(', ') } : undefined
}

/** Files this repository provides, so a require of its own code is not a dependency. */
export function rubyLocal(root: string): Set<string> {
  const local = new Set<string>()
  for (const dir of ['lib', 'app', '.', 'config']) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) local.add(entry.name)
        else if (entry.name.endsWith('.rb')) local.add(entry.name.slice(0, -3))
      }
    } catch {
      // unreadable directory contributes nothing
    }
  }
  return local
}

/**
 * `require "foo/bar"` is provided by the gem `foo`, which holds for nearly every gem.
 * Reported as `firm`: the require-to-gem relationship is a convention, not a rule, and
 * a gem can also arrive through a path or git source this cannot see.
 */
export function isPhantomGem(
  required: string,
  manifest: { names: Set<string> },
  local: Set<string>,
): boolean {
  const top = required.split('/')[0] ?? required
  if (STDLIB.has(top) || local.has(top) || local.has(required)) return false
  const candidates = [normalize(top), normalize(GEM_FOR[top] ?? top), normalize(top.replace(/_/g, ''))]
  return !candidates.some((c) => manifest.names.has(c))
}
