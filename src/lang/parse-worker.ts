import { parentPort, workerData } from 'node:worker_threads'
import { PACKS, parse, serializeTree, type SerializedTree } from './packs.js'

type Input = { language: string; sources: string[] }

async function run(input: Input): Promise<(SerializedTree | undefined)[]> {
  const pack = PACKS.find((candidate) => candidate.name === input.language)
  if (!pack || !Array.isArray(input.sources)) return []

  const trees: (SerializedTree | undefined)[] = []
  for (const source of input.sources) {
    const tree = await parse(pack, source)
    trees.push(tree ? serializeTree(tree) : undefined)
  }
  return trees
}

void run(workerData as Input).then(
  (trees) => parentPort?.postMessage(trees),
  () => parentPort?.postMessage([]),
)
