/**
 * hostConfigImports — the local modules a project's host-executed config files
 * load, so the agent write gate can refuse them like the configs themselves
 * (security re-review of #233, R1).
 *
 * ## Why a file NAME is not enough
 *
 * `hostExecutedWorkspaceFile` refuses `vite.config.ts` by name. But the config
 * runs whatever it imports: Studio's own scaffolded `vite.config.js` imports
 * `./prototype/studioRuntime.generated.js`, and a user's `vite.config.ts`
 * routinely imports `./vite/plugins.ts`. Vite watches those dependencies and
 * restarts — re-running them in Node — when one changes. Refusing the config
 * and allowing its imports leaves the zero-click path exactly as open.
 *
 * ## What it reads, and what it does not
 *
 * The project root's config files (`isHostConfigFileName`), and — to depth
 * {@link MAX_DEPTH} — the local files they import, found by a bounded textual
 * scan for `import … from './x'`, `import './x'`, `import('./x')` and
 * `require('./x')`. Nothing is executed or parsed as a program. Only relative
 * specifiers count: a bare specifier resolves into `node_modules`, which no
 * agent writes anyway. A specifier is protected under every name it could
 * resolve to (as written, with each JS/TS extension, as a directory index, and
 * `.js` written for a `.ts` source), whether or not the file exists yet —
 * creating a module a config already imports runs it too.
 *
 * Not covered, and said so: a config in a nested workspace
 * (`packages/app/vite.config.ts` itself is refused by name, its imports are
 * not scanned), a custom `--config` path in a dev script, and computed
 * specifiers. This narrows the zero-click path; it is not a sandbox.
 *
 * ## Cost
 *
 * One `readdir` of the root plus a handful of small reads. The result is
 * cached per project and revalidated by `stat`ing the root and every file it
 * scanned, so the HTTP tools pay the scan once per change; the CLI hook runs
 * in a fresh process per write and pays it every time, which is milliseconds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { comparableWorkspaceRel, isHostConfigFileName } from '@core/page-parser'

/** Config → its imports → their imports. Deep enough for a plugins folder; a deeper chain is a project-specific residual. */
const MAX_DEPTH = 2
/** A config or plugin module bigger than this is not read: nothing legitimate is. */
const MAX_SCANNED_BYTES = 200_000
/** Bounded on every quantifier, so the scan is linear in the file size. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s{0,20}|\bimport\s{0,20}\(?\s{0,20}|\brequire\s{0,20}\(\s{0,20})(['"])(\.{1,2}\/[^'"\r\n]{1,400})\1/g
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

interface ClosureEntry {
  /** Comparable project-relative path → the root config that (transitively) imports it. */
  readonly importedBy: ReadonlyMap<string, string>
  /** Every file read, with the mtime it was read at, plus the root itself. */
  readonly stamps: ReadonlyArray<readonly [string, number]>
}

const cache = new Map<string, ClosureEntry>()

function mtimeOf(abs: string): number {
  try {
    return statSync(abs).mtimeMs
  } catch {
    return -1
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/** Every relative specifier a source text names. */
function relativeSpecifiers(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) out.push(match[2]!)
  return out
}

/** Every absolute path `spec` could resolve to from `fromDir`. */
function candidatePaths(fromDir: string, spec: string): string[] {
  const base = resolve(fromDir, spec)
  const out = [base]
  for (const ext of CODE_EXTENSIONS) {
    out.push(`${base}${ext}`, join(base, `index${ext}`))
  }
  // TypeScript's convention: `./x.js` in source names `./x.ts`.
  const jsLike = /\.(?:[cm]?js|jsx)$/.exec(base)
  if (jsLike) {
    const stem = base.slice(0, base.length - jsLike[0].length)
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(`${stem}${ext}`)
  }
  return out
}

function scan(root: string): ClosureEntry {
  const importedBy = new Map<string, string>()
  const stamps: Array<readonly [string, number]> = [[root, mtimeOf(root)]]
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return { importedBy, stamps }
  }

  const toRel = (abs: string): string | null => {
    const rel = relative(root, abs)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return comparableWorkspaceRel(rel)
  }

  for (const name of names.filter(isHostConfigFileName)) {
    const config = join(root, name)
    let frontier = [config]
    const seen = new Set<string>(frontier)
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const file of frontier) {
        if (!isFile(file)) continue
        stamps.push([file, mtimeOf(file)])
        let source: string
        try {
          if (statSync(file).size > MAX_SCANNED_BYTES) continue
          source = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const spec of relativeSpecifiers(source)) {
          for (const candidate of candidatePaths(dirname(file), spec)) {
            const rel = toRel(candidate)
            if (rel === null) continue
            if (!importedBy.has(rel)) importedBy.set(rel, name)
            if (!seen.has(candidate) && isFile(candidate)) {
              seen.add(candidate)
              next.push(candidate)
            }
          }
        }
      }
      frontier = next
    }
  }
  return { importedBy, stamps }
}

/**
 * The root config file that loads `rel` in Node, or `null`. `root` and `rel`
 * must be the same kind of path (both real, or both textual) — the gate asks
 * once per pair.
 */
export function hostConfigImportedBy(root: string, rel: string): string | null {
  const key = resolve(root)
  let entry = cache.get(key)
  if (!entry || entry.stamps.some(([abs, mtime]) => mtimeOf(abs) !== mtime)) {
    entry = scan(key)
    cache.set(key, entry)
  }
  return entry.importedBy.get(comparableWorkspaceRel(rel)) ?? null
}
