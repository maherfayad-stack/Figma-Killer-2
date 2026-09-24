/**
 * Architecture gate — the architecture gates share ONE walk of the tree.
 *
 * ## The rule
 *
 * A gate in this folder must not build its own recursive directory walk. It
 * takes its file list from `helpers/sourceTree.ts`, which lists and reads the
 * repository once per process.
 *
 * ## Why this is a structural rule and not a style preference
 *
 * Sixty gates each carried a private copy of the same
 * `readdirSync` + `statSync` recursion followed by a serial `readFileSync`
 * loop. Measured on this tree (4,505 files / 41 MB, Windows):
 *
 * | | cost |
 * |---|---|
 * | serial `readFileSync` of the tree | 14.6 s cold, ~19 s under load |
 * | the same bytes through `Bun.file`, in parallel | 154 ms |
 * | `ai-driver-isolation` (read the tree once per RULE, six rules) | **29.7 s alone**, against its own 20 s budget |
 *
 * A gate that times out is a gate nobody reads. `standing-01` already carries
 * "whole-tree scans blow their budget under load and pass alone" as a standing
 * category of not-really-a-failure — which is exactly how a real failure gets
 * waved through. The cure is one walk, not a bigger budget.
 *
 * ## The exceptions, and why they are not the rule
 *
 * Three kinds, each named in `OWN_READDIR_ALLOWLIST` below with its reason:
 * gates that read BUILD OUTPUT (`dist/`, which the cache deliberately never
 * walks); `no-case-only-filename-collisions`, which needs every filename in a
 * directory regardless of extension (a `Foo.svg`/`foo.svg` pair is a
 * collision, and the cache holds source extensions only); and gates whose
 * `readdirSync` is ONE non-recursive listing of ONE directory, where there is
 * no tree walk to share. A new entry needs a new reason.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  CACHED_EXTENSIONS,
  REPO_ROOT,
  SKIPPED_DIRS,
  allCachedFiles,
  readSource,
  readSourceBytes,
  toRepoRelativePosix,
  walkSourceTree,
} from './helpers/sourceTree'

const GATES_DIR = join(REPO_ROOT, 'src/__tests__/architecture')

/**
 * Gates allowed to keep their own `readdirSync`, each with the reason it
 * cannot come from the shared source cache. A new entry needs a new reason —
 * "it was easier" is not one.
 */
const OWN_READDIR_ALLOWLIST: Record<string, string> = {
  'bundle-size-budgets.test.ts':
    'reads dist/assets/, which is build output — the shared cache never walks dist/',
  'vendor-icons-fresh.test.ts':
    'lists vendor/pixel-art-icons/dist/icons/, build output for the same reason',
  'no-case-only-filename-collisions.test.ts':
    'needs every filename in a directory regardless of extension — a Foo.svg/foo.svg pair is a collision, and the cache holds source extensions only',
  'ai-credentials-never-leak.test.ts':
    'one non-recursive readdirSync of a single handlers directory — no tree walk to share',
  'ai-handlers-capability-gated.test.ts': 'same: one non-recursive readdirSync of one directory',
  'studio-tool-project-dir.test.ts': 'same: one non-recursive readdirSync of one directory',
  'studio-tool-refusals-are-coded.test.ts': 'same: one non-recursive readdirSync of one directory',
  'workspace-volume-persistence.test.ts':
    'one non-recursive readdirSync of the repo root for compose*.yml, an extension the cache does not hold',
  'bun-version-pinned.test.ts':
    'one non-recursive readdirSync of .github/workflows/ for *.yml, an extension the cache does not hold',
  'shared-source-tree-walk.test.ts': 'this gate — it walks independently in order to check the cache',
}

const READS_DIRECTORY = /readdirSync\(/

/**
 * The gate files themselves — `helpers/sourceTree.ts` (which IS the shared
 * walk) and `pathHelpers.ts` are not gates and are excluded by the
 * `.test.ts` suffix rather than by an allowlist entry.
 */
const gateFiles = (): string[] =>
  walkSourceTree(GATES_DIR, ['.ts']).filter((file) => file.endsWith('.test.ts'))

/** The naive walker every gate used to carry, re-implemented here as the oracle. */
function naiveWalk(dir: string, extensions: readonly string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) naiveWalk(full, extensions, out)
    else if (extensions.includes(extname(entry.name))) out.push(full)
  }
  return out
}

describe('the architecture gates share one walk of the tree', () => {
  it('no gate builds its own recursive directory walk', () => {
    const offenders: string[] = []
    for (const file of gateFiles()) {
      const name = toRepoRelativePosix(file).split('/').pop() ?? ''
      if (name in OWN_READDIR_ALLOWLIST) continue
      if (READS_DIRECTORY.test(readSource(file))) offenders.push(name)
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'These gates call readdirSync directly instead of taking their file list from the shared, ' +
          'cached walk. Replace the private walker with ' +
          "`walkSourceTree(dir, ['.ts', '.tsx'])` from './helpers/sourceTree', and read files with " +
          '`readSource(file)` (identical to readFileSync(file, "utf8"), served from the cache). ' +
          'If the gate genuinely needs build output or non-source extensions, add it to ' +
          'OWN_READDIR_ALLOWLIST in this file WITH the reason:\n  ' +
          offenders.join('\n  '),
    ).toEqual([])
  })

  it('every allowlist entry still names a gate that still walks by hand', () => {
    // An allowlist entry that outlives its exception silently widens the rule.
    const stale: string[] = []
    for (const name of Object.keys(OWN_READDIR_ALLOWLIST)) {
      const abs = join(GATES_DIR, name)
      if (!gateFiles().includes(abs)) {
        stale.push(`${name} — no such gate any more; delete the entry`)
        continue
      }
      if (!READS_DIRECTORY.test(readSource(abs))) {
        stale.push(`${name} — no longer calls readdirSync; delete the entry`)
      }
    }
    expect(stale).toEqual([])
  })
})

describe('the shared cache answers exactly what a private walker did', () => {
  it('reaches the source tree', () => {
    // A cache that listed nothing would make every gate that consumes it pass
    // forever. Pin the order of magnitude and one file by name.
    const files = allCachedFiles()
    expect(files.length).toBeGreaterThan(3000)
    expect(files.map(toRepoRelativePosix)).toContain('server/handlers/studio/trustTier.ts')
  })

  it.each([
    ['src/admin', ['.tsx']],
    ['src/core', ['.ts', '.tsx']],
    ['server', ['.ts']],
    ['src/ui', ['.css']],
    ['src/modules', ['.ts', '.tsx', '.css']],
  ] as const)('walkSourceTree(%s) equals an independent walk', (rel, extensions) => {
    const dir = join(REPO_ROOT, rel)
    expect(walkSourceTree(dir, extensions)).toEqual(naiveWalk(dir, extensions))
  })

  it('readSource is byte-identical to readFileSync(file, "utf8")', async () => {
    // Not a sample: every `.ts`/`.tsx` the cache holds under src/core, compared
    // against a fresh read. A decoder difference (a stripped BOM, a replaced
    // invalid sequence) would move a line number or blind a scan silently.
    const files = walkSourceTree(join(REPO_ROOT, 'src/core'), ['.ts', '.tsx'])
    expect(files.length).toBeGreaterThan(100)
    const mismatches: string[] = []
    await Promise.all(
      files.map(async (file) => {
        const fresh = await Bun.file(file).text()
        if (readSource(file) !== fresh) mismatches.push(toRepoRelativePosix(file))
      }),
    )
    expect(mismatches).toEqual([])
  })

  it('readSourceBytes is byte-identical to the file on disk', async () => {
    const files = walkSourceTree(join(REPO_ROOT, 'src/ui'), ['.ts', '.tsx', '.css'])
    expect(files.length).toBeGreaterThan(20)
    const mismatches: string[] = []
    await Promise.all(
      files.map(async (file) => {
        const fresh = await Bun.file(file).bytes()
        const cached = readSourceBytes(file)
        if (cached.length !== fresh.length || cached.some((b, i) => b !== fresh[i])) {
          mismatches.push(toRepoRelativePosix(file))
        }
      }),
    )
    expect(mismatches).toEqual([])
  })
})

describe('the cache refuses to answer about files it never looked at', () => {
  it('throws for a directory under a skipped root instead of returning nothing', () => {
    // Silently returning [] here is the whole failure mode this guard exists
    // for: the gate goes green having inspected zero files.
    expect(() => walkSourceTree(join(REPO_ROOT, 'node_modules'), ['.ts'])).toThrow(
      /never walks/,
    )
    expect(() => walkSourceTree(join(REPO_ROOT, 'studio-workspace'), ['.ts'])).toThrow(
      /never walks/,
    )
  })

  it('throws for an extension it does not hold', () => {
    expect(() => walkSourceTree(join(REPO_ROOT, 'src'), ['.svg'])).toThrow(/not cached/)
  })

  it('throws for a path outside the repository', () => {
    expect(() => walkSourceTree(join(REPO_ROOT, '..', '..'), ['.ts'])).toThrow(
      /outside the repository root/,
    )
  })

  it('throws when asked to read a file the walk never reached', () => {
    expect(() => readSource(join(REPO_ROOT, 'bun.lock'))).toThrow(/not in the shared tree cache/)
  })

  it('returns [] for a directory that simply does not exist', () => {
    // The private walkers all opened with `if (!existsSync(dir)) return []`,
    // and a few gates scan optional directories.
    expect(walkSourceTree(join(REPO_ROOT, 'src/does-not-exist'), ['.ts'])).toEqual([])
  })

  it('caches every extension any gate asks for', () => {
    // If a gate asks for an extension outside this set it throws — which is
    // safe, but the list has to actually cover the gates, or a conversion
    // fails at runtime instead of at review.
    expect(CACHED_EXTENSIONS).toContain('.ts')
    expect(CACHED_EXTENSIONS).toContain('.tsx')
    expect(CACHED_EXTENSIONS).toContain('.css')
    expect(CACHED_EXTENSIONS).toContain('.md')
    expect(CACHED_EXTENSIONS).toContain('.json')
  })
})
