/**
 * droppedFolderWalk — the policy half, which is the half that can lose data.
 *
 * A drop is the product's easiest entry path and the one with no confirmation
 * step, so what it silently skips and what it refuses outright are the two
 * behaviours worth pinning down. The walk itself is exercised through a stub
 * `FileSystemDirectoryEntry` — the browser's paging contract (an empty batch
 * means "done") is the classic bug, and it is testable without a browser.
 */
import { describe, expect, it } from 'bun:test'
import {
  DropTooLargeError,
  MAX_DROP_FILES,
  MAX_DROP_FILE_BYTES,
  MAX_DROP_TOTAL_BYTES,
  createDropDecider,
  isExcludedDropPath,
  walkDroppedDirectory,
} from '../droppedFolderWalk'

describe('isExcludedDropPath', () => {
  it('excludes the shared workspace directory names at any depth', () => {
    expect(isExcludedDropPath('node_modules/react/index.js')).toBe(true)
    expect(isExcludedDropPath('packages/ui/node_modules/react/index.js')).toBe(true)
    expect(isExcludedDropPath('.git/HEAD')).toBe(true)
    expect(isExcludedDropPath('dist/bundle.js')).toBe(true)
    expect(isExcludedDropPath('.next/server/page.js')).toBe(true)
    expect(isExcludedDropPath('.turbo/log')).toBe(true)
  })

  it('keeps ordinary source files, including ones whose names merely resemble an excluded dir', () => {
    expect(isExcludedDropPath('pages/Home.tsx')).toBe(false)
    expect(isExcludedDropPath('src/node_modules_shim.ts')).toBe(false)
    expect(isExcludedDropPath('src/distance.ts')).toBe(false)
  })
})

describe('createDropDecider', () => {
  it('accepts ordinary source files and counts them', () => {
    const decider = createDropDecider()

    expect(decider.decide('pages/Home.tsx', 400).kind).toBe('accept')
    expect(decider.decide('pages/About.tsx', 400).kind).toBe('accept')

    expect(decider.acceptedCount).toBe(2)
    expect(decider.skippedCount).toBe(0)
  })

  it('skips an excluded directory without counting it as a loss', () => {
    const decider = createDropDecider()

    expect(decider.decide('node_modules/react/index.js', 400).kind).toBe('skip')

    // Nobody expects `node_modules` to be imported, so reporting it as
    // "3,000 files skipped" would be alarming and meaningless.
    expect(decider.skippedCount).toBe(0)
    expect(decider.acceptedCount).toBe(0)
  })

  it('skips one oversized file and reports it, rather than refusing the drop', () => {
    const decider = createDropDecider()

    expect(decider.decide('assets/video.mp4', MAX_DROP_FILE_BYTES + 1).kind).toBe('skip')
    expect(decider.decide('pages/Home.tsx', 400).kind).toBe('accept')

    // The project still opens without the asset, and the summary says how many
    // were left behind.
    expect(decider.skippedCount).toBe(1)
    expect(decider.acceptedCount).toBe(1)
  })

  it('refuses the whole drop past the file-count cap, naming what to do instead', () => {
    const decider = createDropDecider()
    for (let n = 0; n < MAX_DROP_FILES; n += 1) {
      expect(decider.decide(`src/file${n}.ts`, 1).kind).toBe('accept')
    }

    const decision = decider.decide('src/one-too-many.ts', 1)

    expect(decision.kind).toBe('over-budget')
    if (decision.kind === 'over-budget') {
      expect(decision.reason).toContain('zip it')
    }
  })

  it('refuses the whole drop past the total-size cap', () => {
    const decider = createDropDecider()
    const chunk = MAX_DROP_FILE_BYTES
    for (let sent = 0; sent + chunk <= MAX_DROP_TOTAL_BYTES; sent += chunk) {
      expect(decider.decide(`assets/blob${sent}.bin`, chunk).kind).toBe('accept')
    }

    expect(decider.decide('assets/last.bin', chunk).kind).toBe('over-budget')
  })

  it('does not charge a skipped file against the total-size budget', () => {
    const decider = createDropDecider()

    // Two files that would together blow the budget, but each is over the
    // per-file cap and therefore never read at all.
    decider.decide('a.bin', MAX_DROP_TOTAL_BYTES)
    decider.decide('b.bin', MAX_DROP_TOTAL_BYTES)

    expect(decider.decide('pages/Home.tsx', 400).kind).toBe('accept')
  })
})

// ---------------------------------------------------------------------------
// The walk, against a stub entry tree
// ---------------------------------------------------------------------------

interface StubTree {
  [name: string]: StubTree | { size: number }
}

function isFileNode(node: StubTree | { size: number }): node is { size: number } {
  return typeof (node as { size: number }).size === 'number'
}

/**
 * A `FileSystemDirectoryEntry` stand-in that pages its children 2 at a time —
 * the browser's real reader caps a batch at 100 and signals exhaustion with an
 * empty one, and a walk that stops after the first batch is the bug this
 * stub exists to catch.
 */
function stubEntry(name: string, tree: StubTree) {
  const names = Object.keys(tree)
  let cursor = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      return {
        readEntries(onSuccess: (entries: unknown[]) => void) {
          const batch = names.slice(cursor, cursor + 2)
          cursor += batch.length
          onSuccess(
            batch.map((childName) => {
              const node = tree[childName]
              if (isFileNode(node)) {
                return {
                  isFile: true,
                  isDirectory: false,
                  name: childName,
                  file(onFile: (file: File) => void) {
                    onFile(new File([new Uint8Array(node.size)], childName))
                  },
                }
              }
              return stubEntry(childName, node)
            }),
          )
        },
      }
    },
  }
}

describe('walkDroppedDirectory', () => {
  it('flattens the tree into paths relative to the dropped folder, reading every batch', async () => {
    const entry = stubEntry('my-app', {
      'package.json': { size: 100 },
      'README.md': { size: 100 },
      'tsconfig.json': { size: 100 },
      pages: {
        'Home.tsx': { size: 200 },
        'About.tsx': { size: 200 },
        marketing: { 'Landing.tsx': { size: 200 } },
      },
    })

    const walked = await walkDroppedDirectory(entry)

    expect(walked.rootName).toBe('my-app')
    // Five files across three read batches at the top level plus nested reads
    // — a walk that stopped at the first batch would report two.
    expect(walked.files.map((file) => file.name).sort()).toEqual([
      'README.md',
      'package.json',
      'pages/About.tsx',
      'pages/Home.tsx',
      'pages/marketing/Landing.tsx',
      'tsconfig.json',
    ].sort())
  })

  it('never descends into an excluded directory', async () => {
    const entry = stubEntry('my-app', {
      'package.json': { size: 100 },
      node_modules: { react: { 'index.js': { size: 100 } } },
      '.git': { HEAD: { size: 10 } },
      dist: { 'bundle.js': { size: 100 } },
    })

    const walked = await walkDroppedDirectory(entry)

    expect(walked.files.map((file) => file.name)).toEqual(['package.json'])
    expect(walked.skipped).toBe(0)
  })

  it('reports files skipped by the per-file cap', async () => {
    const entry = stubEntry('my-app', {
      'Home.tsx': { size: 200 },
      'huge.psd': { size: MAX_DROP_FILE_BYTES + 1 },
    })

    const walked = await walkDroppedDirectory(entry)

    expect(walked.files.map((file) => file.name)).toEqual(['Home.tsx'])
    expect(walked.skipped).toBe(1)
  })

  it('throws DropTooLargeError rather than importing a truncated project', async () => {
    const tree: StubTree = {}
    for (let n = 0; n <= MAX_DROP_FILES; n += 1) tree[`file${n}.ts`] = { size: 1 }

    await expect(walkDroppedDirectory(stubEntry('my-app', tree))).rejects.toBeInstanceOf(DropTooLargeError)
  })
})
