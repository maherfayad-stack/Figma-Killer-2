/**
 * studioEditTargets — the client-supplied PATHS a studio edit points AT, and
 * nothing else.
 *
 * Split out of `studioWriteback.ts` (`module-size-budgets`'s 700-line ceiling)
 * along a real seam: that module decodes a `nodeId` into the file it WRITES,
 * while two edit kinds also carry a second, independent path naming a file
 * they merely REFER to —
 *
 *   - `asset` — the image an `import` should point at, and
 *   - `class` (`style-02`) — the `*.module.css` a CSS-Modules class lives in,
 *     which has to become an import specifier before the codemod can spell the
 *     class as `styles.<local>`.
 *
 * Both arrive from the browser, both end up written verbatim into the user's
 * tracked source, and both therefore need the full adversarial guard set
 * BEFORE they are trusted — one implementation, so the two cannot drift.
 *
 * ## The guard
 *
 * Same posture as `studioAsset.ts`'s read-path guard and
 * `studioCssWriteback.ts`'s write-path resolvers: reject absolute / UNC /
 * drive-letter forms, `..`/`.`/empty segments on EITHER separator, and any
 * `EXCLUDED_WORKSPACE_DIR_NAMES` segment; then require CONTAINMENT ON THE REAL
 * PATH after resolving symlinks — a workspace can arrive from GitHub, and git
 * stores symlinks, so a textual check alone is bypassable. `null` on any
 * violation, or when the target does not exist: a specifier pointing nowhere
 * is worse than a refused edit.
 */
import { isAbsolute, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import type { ClassNameToken } from '@core/ast-codemods'
import type { StudioClassNameToken } from './studioEditSchemas'

/**
 * Validates a client-supplied, workspace-relative path a studio edit REFERS
 * to, and returns it POSIX-normalized once confirmed. See this module's doc
 * for the guard set and why every check is there.
 */
export function resolveContainedRefPath(dir: string, pathRel: string): string | null {
  if (pathRel.length === 0) return null
  if (isAbsolute(pathRel)) return null
  if (/^[a-zA-Z]:/.test(pathRel)) return null // Windows drive path
  if (pathRel.startsWith('\\\\') || pathRel.startsWith('//')) return null // UNC path

  const segments = pathRel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = resolve(dir)
  const resolved = resolve(join(dir, ...segments))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null

  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return null // missing file / broken symlink — nowhere honest to point at
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null

  return segments.join('/')
}

/**
 * A relative module specifier from the file at `fromFileRel` to the file at
 * `toFileRel`, both workspace-relative POSIX paths — the exact inverse of
 * what `resolveImageAssetImport` (`src/core/page-parser/assetImports.ts`)
 * resolves when READING an import, so a round trip (edit, reload, re-resolve)
 * lands back on the same file. Always relative (`./…` / `../…`), matching
 * every specifier shape this pipeline already reads.
 */
export function relativeImportSpecifier(fromFileRel: string, toFileRel: string): string {
  const fromDir = fromFileRel.split('/').slice(0, -1).join('/')
  const fromSegments = fromDir.length > 0 ? fromDir.split('/') : []
  const toSegments = toFileRel.split('/')

  let common = 0
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1
  }

  const ups = fromSegments.length - common
  const downSegments = toSegments.slice(common)
  const relPath = [...Array(ups).fill('..'), ...downSegments].join('/')
  return relPath.startsWith('.') ? relPath : `./${relPath}`
}

/**
 * `style-02` — turns the wire's `StudioClassNameToken[]` into the codemod's
 * own, with every `module` token's workspace-relative `*.module.css` path put
 * through the guard above and then converted to the specifier the IMPORTING
 * file would spell.
 *
 * `null` for the whole list when any module path fails: a client only ever
 * echoes back a stylesheet this project's own load response named, so an
 * out-of-workspace or missing one has no honest sentence to show a user —
 * only an attack (or a stale document) to decline. Whole-list rather than
 * per-token because a half-applied class change is a worse outcome than a
 * retried one.
 *
 * The extension check is the point: only a `*.module.css` can produce a
 * member-expression token, and nothing else may become an import specifier
 * from here.
 */
export function resolveClassNameTokens(
  dir: string,
  fromFileRel: string,
  tokens: readonly StudioClassNameToken[],
): ClassNameToken[] | null {
  const resolved: ClassNameToken[] = []
  for (const token of tokens) {
    if (token.kind === 'literal') {
      resolved.push(token)
      continue
    }
    if (!/\.module\.css$/i.test(token.file)) return null
    const cssRel = resolveContainedRefPath(dir, token.file)
    if (cssRel === null) return null
    resolved.push({ kind: 'module', specifier: relativeImportSpecifier(fromFileRel, cssRel), local: token.local })
  }
  return resolved
}
