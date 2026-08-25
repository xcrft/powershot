import type { Ground } from '#app/types.js'
import { packFor } from '#app/lang/packs.js'
import { implementationFingerprint, typescriptSourceFingerprint } from '#app/reinvention.js'
import { sourceTokensFor } from './foreign-tokens.js'

/** A direct statement in one lexical block. */
export type GuardBlockEntry = {
  /** Adapter-local identity used to omit this exact statement from the residual. */
  id: string
  /** Layout- and comment-insensitive identity supplied by the language adapter. */
  fingerprint: string
  /** Present only when this statement is an unconditional early-exit guard. */
  guard?: { key: string; label: string }
}

export type GuardBlock = {
  /** Structural path from the matched callable to this block. */
  path: string
  entries: GuardBlockEntry[]
}

export type GuardCallable = {
  /** Owner-qualified, bodyless callable fingerprint. */
  identity: string
  blocks: GuardBlock[]
  /** Whole-callable token fingerprint after omitting the selected statements. */
  residualFingerprint(omitted: ReadonlySet<string>): string | undefined
}

const NATIVE_SOURCE = /\.[cm]?[jt]sx?$/i
const EXECUTABLE_CHANGES = new WeakMap<Ground, ReadonlySet<string>>()

function executableChanges(g: Ground): ReadonlySet<string> {
  const known = EXECUTABLE_CHANGES.get(g)
  if (known) return known

  const changed = new Set<string>()
  const represented = new Set<string>()
  for (const file of g.files) {
    represented.add(file.changed.path)
    const after = typescriptSourceFingerprint(file.sf.getFullText())
    const before = typescriptSourceFingerprint(file.before?.getFullText() ?? '')
    if (!after || !before || after !== before || file.changed.beforePath !== undefined) {
      changed.add(file.changed.path)
    }
  }
  for (const file of g.foreign) {
    represented.add(file.path)
    const after = implementationFingerprint(sourceTokensFor(file.tree.rootNode, file.pack))
    const before = implementationFingerprint(
      file.beforeTree ? sourceTokensFor(file.beforeTree.rootNode, file.pack) : [],
    )
    if (after !== before || file.changed.beforePath !== undefined) changed.add(file.path)
  }
  const supported = (path: string | undefined): boolean =>
    path !== undefined && (NATIVE_SOURCE.test(path) || packFor(path) !== undefined)
  for (const file of g.inventory ?? g.changed) {
    if (represented.has(file.path)) continue
    if (supported(file.path) || supported(file.beforePath)) changed.add(file.path)
  }
  EXECUTABLE_CHANGES.set(g, changed)
  return changed
}

/**
 * A guard transfer into another changed file is outside a local syntax proof. Keep a
 * HIGH/proven result only when every other supported source file is token-stable.
 */
export function hasOtherExecutableChange(g: Ground, currentPath: string): boolean {
  const changed = executableChanges(g)
  return changed.size > (changed.has(currentPath) ? 1 : 0)
}

/**
 * Return the guards removed by an otherwise token-identical block rewrite.
 *
 * This is deliberately a narrow proof. A helper extraction, inserted validation call,
 * changed continuation, or moved statement makes the block ambiguous and produces no
 * deterministic finding. Those changes need semantic judgement; a pre/post syntax
 * oracle cannot honestly call them lost guards.
 */
function guardOnlyDeletion(
  before: GuardBlock,
  after: GuardBlock,
): { id: string; key: string; label: string }[] | undefined {
  const removed: { id: string; key: string; label: string }[] = []
  let left = 0
  let right = 0

  while (left < before.entries.length && right < after.entries.length) {
    const old = before.entries[left]!
    const current = after.entries[right]!
    if (old.fingerprint === current.fingerprint) {
      left++
      right++
      continue
    }
    if (old.guard !== undefined) {
      // A guard only protects a continuation in its own block. If it is the last
      // meaningful statement, deleting it is not the failure this check promises.
      if (before.entries.slice(left + 1).some((entry) => entry.guard === undefined)) {
        removed.push({ id: old.id, ...old.guard })
      }
      left++
      continue
    }
    return undefined
  }

  if (right !== after.entries.length) return undefined
  while (left < before.entries.length) {
    const old = before.entries[left]!
    if (old.guard === undefined) return undefined
    if (before.entries.slice(left + 1).some((entry) => entry.guard === undefined)) {
      removed.push({ id: old.id, ...old.guard })
    }
    left++
  }
  return removed.length > 0 ? removed : undefined
}

/**
 * Guards whose removal is the only executable change in a uniquely matched block.
 * Ambiguous duplicate blocks are skipped rather than paired by traversal order.
 */
export function provenGuardRemovals(before: GuardCallable, after: GuardCallable): string[] {
  // A name is not a callable contract. Changing a parameter, receiver, owner, or
  // return type can make a formerly necessary guard obsolete.
  if (before.identity !== after.identity) return []

  const uniqueByPath = (blocks: GuardBlock[]): Map<string, GuardBlock | undefined> => {
    const out = new Map<string, GuardBlock | undefined>()
    for (const block of blocks) {
      if (out.has(block.path)) out.set(block.path, undefined)
      else out.set(block.path, block)
    }
    return out
  }

  const current = uniqueByPath(after.blocks)
  const remainingGuards = new Set(
    after.blocks.flatMap((block) => block.entries.flatMap((entry) => entry.guard === undefined ? [] : [entry.guard.key])),
  )
  const structurallyRemoved: { id: string; key: string; label: string }[] = []
  for (const [path, previous] of uniqueByPath(before.blocks)) {
    const now = current.get(path)
    if (!previous || !now) continue
    structurallyRemoved.push(...(guardOnlyDeletion(previous, now) ?? []))
  }
  if (structurallyRemoved.length === 0) return []

  // A block-local diff is not enough: another branch or sibling statement may have
  // changed the guarantee that made the guard obsolete. Remove the candidate guard
  // nodes from the old callable and require every remaining compiler-visible token
  // to equal the new callable. This is the fact behind the `proven` confidence.
  const omitted = new Set(structurallyRemoved.map((guard) => guard.id))
  const previousResidual = before.residualFingerprint(omitted)
  const currentResidual = after.residualFingerprint(new Set())
  if (!previousResidual || previousResidual !== currentResidual) return []

  const reportable = new Map<string, string>()
  for (const guard of structurallyRemoved) {
    // A syntactically identical guard elsewhere in the callable may dominate the
    // continuation. Without a control-flow graph, abstaining is the only proof-safe
    // answer; false negatives are preferable to a false HIGH/proven defect.
    if (!remainingGuards.has(guard.key)) reportable.set(guard.key, guard.label)
  }
  return [...reportable.values()]
}
