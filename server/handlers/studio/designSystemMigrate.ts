/**
 * designSystemMigrate — `GET/POST /admin/api/studio/design-system/migrate`:
 * moving a project that still imports the retired `@alm-design/design-system`
 * npm onto the Studio-written `<project>/design-system/` folder.
 *
 * ## Why a user has to press a button
 *
 * The package is gone, so a project importing it no longer builds — and the
 * fix is a REWRITE OF THE USER'S SOURCE. Studio's rule for that is the same
 * one trust promotion follows: an edit to a repository is something a person
 * asks for, never something that happens because a page loaded. So the load
 * path does nothing at all here; it only answers the GET, and the board shows
 * a banner (`DesignSystemMigrateBanner.tsx`) offering the change.
 *
 *   GET  ?dir=<abs>
 *     -> `{ importsRetiredPackage, declaresDependency, hasInstalledCopy,
 *           designSystemBacked }` — everything the banner needs to decide
 *        whether to show itself, and nothing else. Two cheap reads: the
 *        manifest, and one `existsSync`. Deliberately NOT a scan of every
 *        source file, because this is asked on every board open.
 *   POST { dir? }
 *     -> `{ filesRewritten, importsRewritten, removedDependency }`
 *
 * ## What the POST does, in order
 *
 *   1. Records `designSystem: 'alm'` in `.studio/meta.json` — the write-side
 *      authority that lets `ensureDesignSystemFiles` maintain the folder from
 *      here on.
 *   2. Writes `<project>/design-system/` (`./designSystemFiles.ts`).
 *   3. Rewrites every import of the retired package in the project's own
 *      source, to the relative path from each importing FILE
 *      (`rewriteImportSpecifier`, formatting-preserving). `design-system/`
 *      itself is excluded — it is Studio's copy, not the user's source.
 *   4. Removes the dependency from `package.json`, preserving the file's
 *      formatting and every other key.
 *   5. Deletes `<project>/node_modules/@alm-design/design-system` (and the
 *      `@alm-design` scope directory, if it is then empty).
 *
 * Steps 1–4 are the migration; step 5 is housekeeping and its failure is not
 * the migration's failure.
 *
 * ## Step 5 is the only deletion in this workstream — here is its guard
 *
 * The path is DERIVED, never supplied: it is `node_modules/@alm-design/
 * design-system` under a `dir` that `resolveProjectDir` has already confined
 * to `studio-workspace/`. Before the `rm`, it must pass
 * `isRealpathContained(target, dir)` — containment on the REAL path, after
 * resolving every symlink in the chain, so a `node_modules` symlinked to a
 * shared store (pnpm, a hand-made link) cannot carry the delete outside the
 * project. A target that is ITSELF a symlink is refused outright rather than
 * followed. Nothing else is ever deleted: no `node_modules` sweep, no
 * "cleanup", no recursion above that one directory.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { designSystemImportSpecifier, listWorkspaceFiles } from '@core/page-parser'
import { createProject, rewriteImportSpecifier } from '@core/ast-codemods'
import { Type } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback, safeParseJson } from '@core/utils/jsonValidate'
import { badRequest, jsonResponse, readValidatedBody, internalServerError } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { PROJECT_DESIGN_SYSTEM_DIR, isDesignSystemBacked } from './builtinDesignSystem'
import { ensureDesignSystemFiles } from './designSystemFiles'
import { PackageJsonSchema, hasDependency } from './packageJsonRead'
import { mergeStudioMeta } from './studioMeta'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/design-system/migrate'

/**
 * The npm this migration exists to remove.
 *
 * The LAST place in the repository that spells it as CODE, deliberately, and
 * the one entry in `no-alm-npm-specifier.test.ts`'s allowlist. Module-private:
 * nothing else has a reason to name a package that no longer exists, and an
 * exported constant is an invitation to.
 */
const RETIRED_DESIGN_SYSTEM_PACKAGE = '@alm-design/design-system'

/** Source files worth rewriting. Anything else in the project has no module graph to fix. */
const CODE_FILE_RE = /\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/

const MigrateBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

export interface DesignSystemMigrateStatus {
  /** `package.json` names the retired package. */
  declaresDependency: boolean
  /** A copy of it is sitting in the project's own `node_modules`. */
  hasInstalledCopy: boolean
  /** Either of the above — the one question the banner asks. */
  importsRetiredPackage: boolean
  /** The project already carries a `design-system/` folder. A half-migrated project has both true. */
  designSystemBacked: boolean
}

/**
 * Cheap, because the board asks on every open: one manifest read and one
 * `existsSync`. A project that declares the dependency, or still has it
 * installed, is one whose source imports it — and a full walk of every source
 * file to prove that would cost thousands of reads to answer a question the
 * manifest already answers for both real cases.
 */
export function readDesignSystemMigrateStatus(dir: string): DesignSystemMigrateStatus {
  const pkg = parseJsonWithFallback(readFileOrEmpty(join(dir, 'package.json')), PackageJsonSchema, {})
  const declaresDependency = hasDependency(pkg, RETIRED_DESIGN_SYSTEM_PACKAGE)
  const hasInstalledCopy = existsSync(installedCopyDir(dir))
  return {
    declaresDependency,
    hasInstalledCopy,
    importsRetiredPackage: declaresDependency || hasInstalledCopy,
    designSystemBacked: isDesignSystemBacked(dir),
  }
}

export interface DesignSystemMigrateResult {
  /** Source files whose imports changed. */
  filesRewritten: number
  /** Import declarations rewritten or removed across those files. */
  importsRewritten: number
  /** The dependency was named in `package.json` and is not any more. */
  removedDependency: boolean
}

function readFileOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function installedCopyDir(dir: string): string {
  return join(dir, 'node_modules', ...RETIRED_DESIGN_SYSTEM_PACKAGE.split('/'))
}

/**
 * Rewrites every import of the retired package in the project's own source.
 *
 * `listWorkspaceFiles` supplies the file set, so the exclusions are the one
 * shared list (`.studio`, `.git`, `node_modules`, `dist`, `.next`, `.turbo`)
 * and symlinked entries are never followed. `design-system/` is excluded on
 * top of that: it is Studio's copy of the design system, not source with a
 * dependency to fix.
 *
 * One ts-morph `Project` for the whole run, saved per file — the rewrite is
 * formatting-preserving, so an untouched file is byte-identical and is never
 * written at all.
 */
function rewriteProjectImports(dir: string): { filesRewritten: number; importsRewritten: number } {
  const project = createProject()
  let filesRewritten = 0
  let importsRewritten = 0

  for (const relPath of listWorkspaceFiles(dir)) {
    if (!CODE_FILE_RE.test(relPath)) continue
    if (relPath === PROJECT_DESIGN_SYSTEM_DIR || relPath.startsWith(`${PROJECT_DESIGN_SYSTEM_DIR}/`)) continue

    const abs = join(dir, ...relPath.split('/'))
    // `listWorkspaceFiles` already refuses to follow a symlink, but the write
    // side states its own rule rather than inheriting one from a walk three
    // modules away.
    if (!isRealpathContained(abs, dir)) continue

    try {
      const sourceFile = project.addSourceFileAtPath(abs)
      const changed = rewriteImportSpecifier(sourceFile, {
        from: RETIRED_DESIGN_SYSTEM_PACKAGE,
        to: designSystemImportSpecifier(relPath),
      })
      const total = changed.rewritten + changed.removed
      if (total === 0) {
        project.removeSourceFile(sourceFile)
        continue
      }
      sourceFile.saveSync()
      filesRewritten += 1
      importsRewritten += total
    } catch (err) {
      // One unparsable file must not abandon the rest of the migration
      // half-done; it is reported as un-rewritten by simply not being counted.
      console.error('[studio/designSystemMigrate] could not rewrite a source file:', err)
    }
  }

  return { filesRewritten, importsRewritten }
}

/**
 * Drops the dependency line from `package.json` without reformatting anything
 * else.
 *
 * A textual removal first — the file keeps its own indentation, key order,
 * trailing newline and any comment-free quirk it had — verified by re-parsing
 * the result and checking the key is gone and the JSON is still valid. If that
 * verification fails (an unusual layout the pattern did not match cleanly),
 * it falls back to a parse/serialize round trip, which is a formatting change
 * but never a broken manifest. Returns whether the dependency was there.
 */
function removeDependency(dir: string): boolean {
  const file = join(dir, 'package.json')
  const raw = readFileOrEmpty(file)
  if (raw.length === 0) return false
  const pkg = parseJsonWithFallback(raw, PackageJsonSchema, {})
  if (!hasDependency(pkg, RETIRED_DESIGN_SYSTEM_PACKAGE)) return false

  const escaped = RETIRED_DESIGN_SYSTEM_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The whole line, plus its own trailing comma — or, when it is the LAST
  // entry in its block, the comma that ended the line before it.
  const lineRe = new RegExp(
    `(,)?[^\\S\\n]*\\n?[^\\S\\n]*"${escaped}"[^\\S\\n]*:[^\\S\\n]*"[^"]*"[^\\S\\n]*(,)?`,
    'g',
  )
  const textual = raw.replace(lineRe, (_match, leadingComma: string | undefined, trailingComma: string | undefined) =>
    leadingComma && trailingComma ? ',' : '',
  )

  writeFileSync(file, verifiedRemoval(textual, raw), 'utf8')
  return true
}

/** `textual` when it is valid JSON that no longer names the package, else a reserialized `raw`. */
function verifiedRemoval(textual: string, raw: string): string {
  if (!textual.includes(RETIRED_DESIGN_SYSTEM_PACKAGE) && safeParseJson(textual, PackageJsonSchema).ok) {
    return textual
  }
  // `PackageJsonSchema` does not constrain additional properties, and TypeBox
  // decoding does not strip them, so every other key the manifest carries
  // survives this round trip — only its formatting does not.
  const manifest = parseJsonWithFallback(raw, PackageJsonSchema, {})
  delete manifest.dependencies?.[RETIRED_DESIGN_SYSTEM_PACKAGE]
  delete manifest.devDependencies?.[RETIRED_DESIGN_SYSTEM_PACKAGE]
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Deletes the installed copy, and the now-empty `@alm-design` scope directory.
 * See the module doc for why this is the one deletion and how it is guarded.
 */
function removeInstalledCopy(dir: string): void {
  const target = installedCopyDir(dir)
  if (!existsSync(target)) return
  // Refused, not followed: a symlink here is somebody else's directory.
  if (lstatSync(target).isSymbolicLink()) return
  if (!isRealpathContained(target, dir)) return

  rmSync(target, { recursive: true, force: true })

  const scope = dirname(target)
  try {
    if (isRealpathContained(scope, dir) && readdirSync(scope).length === 0) rmdirSync(scope)
  } catch (err) {
    // An un-removable empty directory is cosmetic; the migration is done.
    console.error('[studio/designSystemMigrate] could not remove the empty scope directory:', err)
  }
}

/** The whole migration, in the order the module doc states. Throws only on a genuinely unwritable project. */
export function migrateProjectToBuiltinDesignSystem(dir: string): DesignSystemMigrateResult {
  mergeStudioMeta(dir, { designSystem: 'alm' })
  ensureDesignSystemFiles(dir)
  const { filesRewritten, importsRewritten } = rewriteProjectImports(dir)
  // Written a SECOND time, deliberately. `ensureDesignSystemFiles` copies only
  // the icon SVGs something actually imports, and the project's own demand is
  // spelled `'../design-system/icons/…'` — which is exactly what the rewrite
  // above has just created. Before it, a page still named the retired package
  // and its icons were invisible to the scan, so the folder shipped without
  // them and `vite build` in the migrated project failed on a missing file.
  // (The first call stays: if the rewrite throws, a project with a folder and
  // unrewritten imports is a better place to be than the reverse.)
  ensureDesignSystemFiles(dir)
  const removedDependency = removeDependency(dir)
  removeInstalledCopy(dir)
  return { filesRewritten, importsRewritten, removedDependency }
}

/** `GET/POST /admin/api/studio/design-system/migrate` — see module doc for the full contract. */
export async function tryServeStudioDesignSystemMigrate(
  req: Request,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      return jsonResponse(readDesignSystemMigrateStatus(dir))
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio/designSystemMigrate]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, MigrateBodySchema)
      if (!body) return badRequest('invalid design-system migrate body')
      const dir = resolveProjectDir(body.dir)
      if (!existsSync(dir)) return jsonResponse({ error: 'Project not found.' }, { status: 404 })
      return jsonResponse(migrateProjectToBuiltinDesignSystem(dir))
    } catch (err) {
      rethrowProjectDirRefusal(err)
      return internalServerError('[studio/designSystemMigrate]', err)
    }
  }

  return null
}
