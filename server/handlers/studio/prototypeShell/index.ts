/**
 * prototypeShell — `ensurePrototypeShell(dir)`: the runnable preview app
 * Studio keeps in a workspace, so "Download the code" produces something that
 * starts.
 *
 * ## The problem this closes
 *
 * A Studio workspace holds `pages/`, `components/`, `i18n/` — the design — and
 * nothing that can run it. No `index.html`, no entry module, no board. And
 * everything the canvas knows (which boards exist, where each frame sits, what
 * direction and colour scheme it was being previewed in) lives in `.studio/`,
 * which `studioDownload.ts` deliberately excludes. So the download produced a
 * pile of components that could not start and had lost the design layer on the
 * way out.
 *
 * The shell is the fix, and it lives in the workspace rather than being
 * synthesized at download time for three reasons: the download button then
 * needs no special case at all (it zips what is there); the canvas works in a
 * local `npm run dev` too, not only after an export; and a generated file in
 * the repo is something you can read and diff, which a file that only exists
 * inside a zip is not. It is the same posture Studio already takes with
 * `i18n/translations.ts` and `CLAUDE.md`.
 *
 * ## Written once vs. kept in step
 *
 * | file | policy |
 * |---|---|
 * | `index.html`, `vite.config.js`, `prototype/App.jsx`, `ScreenFrame.jsx`, `CanvasPanel.*`, `shell.css`, `urlState.js` | updated while UNTOUCHED, frozen the moment you edit one |
 * | `prototype/registry.generated.jsx`, `prototype/providers.generated.jsx` | rewritten on every open, from `.studio/` |
 * | `package.json` | fields MERGED — an existing value always wins |
 *
 * ## How "untouched" is known
 *
 * `.studio/shell.json` records the SHA-256 of every static file at the moment
 * Studio wrote it. On the next open, a file whose hash still matches is one
 * nobody has edited, so a fixed version of it can safely replace it; a file
 * whose hash differs belongs to the user now and is never written again.
 *
 * The first cut of this shell had no manifest and simply never rewrote a static
 * file, which meant a bug in the scaffold was permanent in every workspace that
 * had already been opened — the shipped fix could not reach them. That is the
 * wrong trade: protecting a file nobody has edited buys nothing and costs the
 * ability to fix anything.
 *
 * ## Why `prototype/` is invisible to the rest of Studio
 *
 * `NON_PAGES_DIR_SEGMENTS` (`projectProbe.ts`) and the local-component catalog
 * both skip it. Without that, a re-probe could rank `prototype/` above the
 * user's real `pages/` — every file in it is a JSX-returning default export,
 * which is exactly what that heuristic scores on — and Studio would start
 * treating its own shell as the user's screens. It is still inside
 * `listWorkspaceFiles`, because the download has to include it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { discoverPageFiles, projectPagesDir } from '../../studioProjects'
import { assignPageIds } from '../../studioPageIds'
import { readStudioMeta } from '../studioMeta'
import { readPrototypeFile } from '../prototypeStore'
import { generatedShellFiles, hasLanguageContext, readBoardsForShell, type ShellScreen } from './registryFile'
import { playerShellFiles } from './playerTemplate'
import { staticShellFiles } from './shellFiles'
import type { ShellFile } from './shellPaths'

export { PROTOTYPE_SHELL_DIR } from './shellPaths'

/** Versions pinned rather than floated: a prototype that resolves a different React on Tuesday is not a prototype. */
const SHELL_DEPENDENCIES: Record<string, string> = {
  react: '^19.2.0',
  'react-dom': '^19.2.0',
}

const SHELL_DEV_DEPENDENCIES: Record<string, string> = {
  '@vitejs/plugin-react': '^5.0.0',
  vite: '^7.0.0',
}

const SHELL_SCRIPTS: Record<string, string> = {
  dev: 'vite',
  build: 'vite build',
  preview: 'vite preview',
}

const PackageJsonShape = Type.Object({}, { additionalProperties: true })

/** Where the hashes of Studio-written shell files live. Inside `.studio/`, so it never ships in a download. */
const SHELL_MANIFEST_REL = '.studio/shell.json'

const ShellManifestSchema = Type.Object({
  version: Type.Number(),
  /** Workspace-relative path -> the SHA-256 Studio last wrote there. */
  files: Type.Record(Type.String(), Type.String()),
})

type ShellManifest = Static<typeof ShellManifestSchema>

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

/** What `ensurePrototypeShell` actually did, so a caller (or a test) can tell scaffold from no-op. */
export interface EnsureShellResult {
  /** Files created because they were absent. */
  created: string[]
  /** Generated files whose contents changed. */
  regenerated: string[]
}

/** `pages/SignUp.tsx` -> `SignUp`. The title the board and the flow tab row show. */
function titleFromRelPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.(tsx|jsx|ts|js)$/, '')
}

/** Every page the shell can import, with the id Studio addresses it by. */
function collectScreens(dir: string): ShellScreen[] {
  let pagesDir: string
  try {
    pagesDir = projectPagesDir(dir)
  } catch {
    return [] // an escaping pagesDir override — nothing honest to import
  }
  if (!existsSync(pagesDir)) return []

  const pagesRel = pagesDir.slice(dir.length).replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const relPaths = discoverPageFiles(pagesDir)
  const ids = assignPageIds(relPaths)
  return relPaths.map((relPath) => ({
    pageId: ids.get(relPath) ?? relPath,
    title: titleFromRelPath(relPath),
    relFile: pagesRel ? `${pagesRel}/${relPath}` : relPath,
  }))
}

/**
 * The locale codes the project declares, or `['en']` when it has none.
 *
 * `keys`, not a separate list: WS-10 §4.1's probe records the dictionary's own
 * top-level keys, which ARE the locale codes — the same values the toolbar's
 * locale control offers.
 */
function collectLocales(dir: string): string[] {
  const keys = readStudioMeta(dir).profile?.locales?.keys ?? []
  return keys.length > 0 ? [...keys] : ['en']
}

/** Write a file, creating its directory. Returns whether anything changed on disk. */
function writeIfDifferent(absPath: string, contents: string): boolean {
  if (existsSync(absPath) && readFileSync(absPath, 'utf8') === contents) return false
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, contents, 'utf8')
  return true
}

/**
 * Merge the shell's needs into `package.json` without ever overwriting a value
 * the project already set.
 *
 * A workspace that pins its own React, or already has a `dev` script pointing
 * somewhere else, keeps both — the shell adds what is missing and nothing
 * more. Returns whether the file changed.
 */
function mergePackageJson(dir: string): boolean {
  const file = join(dir, 'package.json')
  const existing = existsSync(file)
    ? parseJsonWithFallback(readFileSync(file, 'utf8'), PackageJsonShape, {}) as Record<string, unknown>
    : {}

  const next: Record<string, unknown> = { ...existing }
  next.name = existing.name ?? 'studio-prototype'
  next.private = existing.private ?? true
  next.type = existing.type ?? 'module'

  const merge = (key: string, additions: Record<string, string>): void => {
    const current = (existing[key] as Record<string, string> | undefined) ?? {}
    const merged = { ...current }
    for (const [name, value] of Object.entries(additions)) {
      if (merged[name] === undefined) merged[name] = value
    }
    next[key] = merged
  }
  merge('scripts', SHELL_SCRIPTS)
  merge('dependencies', SHELL_DEPENDENCIES)
  merge('devDependencies', SHELL_DEV_DEPENDENCIES)

  return writeIfDifferent(file, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Scaffold the shell into `dir` if it is not there, and bring its generated
 * half up to date with `.studio/`.
 *
 * Idempotent and cheap on the common path: the static files are `existsSync`
 * checks, and the generated ones are only written when their content actually
 * differs — which matters because a rewrite would move `package.json`'s mtime
 * and invalidate caches keyed on it (`compareVerdictCache`).
 *
 * Never throws. A project this cannot scaffold (an unreadable directory, an
 * escaping `pagesDir`) must still open — the shell is an addition to a
 * workspace, never a precondition for reading one.
 */
export function ensurePrototypeShell(dir: string): EnsureShellResult {
  const result: EnsureShellResult = { created: [], regenerated: [] }
  if (!existsSync(dir)) return result

  try {
    const manifestPath = join(dir, ...SHELL_MANIFEST_REL.split('/'))
    const hadManifest = existsSync(manifestPath)
    const manifest: ShellManifest = hadManifest
      ? parseJsonWithFallback(readFileSync(manifestPath, 'utf8'), ShellManifestSchema, { version: 1, files: {} })
      : { version: 1, files: {} }
    const nextHashes: Record<string, string> = { ...manifest.files }
    let hashesChanged = false

    for (const file of [...staticShellFiles(), ...playerShellFiles()]) {
      const abs = join(dir, ...file.relPath.split('/'))
      const present = existsSync(abs)
      const current = present ? readFileSync(abs, 'utf8') : null

      if (current === file.contents) {
        // Already right. Record the hash if this workspace predates the
        // manifest, so the file is tracked from here on.
        if (nextHashes[file.relPath] !== sha256(current)) {
          nextHashes[file.relPath] = sha256(current)
          hashesChanged = true
        }
        continue
      }

      // A file Studio did not write last time is the user's. The one exception
      // is a workspace scaffolded before the manifest existed: there is no
      // record to compare against, and the only files in it are ones Studio
      // itself wrote, so it is adopted once and protected from then on.
      const studioWroteIt = present && manifest.files[file.relPath] === sha256(current ?? '')
      if (present && !studioWroteIt && hadManifest) continue

      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.contents, 'utf8')
      nextHashes[file.relPath] = sha256(file.contents)
      hashesChanged = true
      if (present) result.regenerated.push(file.relPath)
      else result.created.push(file.relPath)
    }

    if (hashesChanged || !hadManifest) {
      writeIfDifferent(manifestPath, `${JSON.stringify({ version: 1, files: nextHashes }, null, 2)}\n`)
    }

    if (mergePackageJson(dir)) result.created.push('package.json')

    const meta = readStudioMeta(dir)
    const generated: ShellFile[] = generatedShellFiles({
      // The workspace folder, not package.json's `name` — the scaffold writes
      // a generic `studio-project` there, so it identifies every project
      // identically and would make every shell's wordmark the same.
      projectName: basename(dir),
      screens: collectScreens(dir),
      boards: readBoardsForShell(dir),
      frameDefaults: {
        width: meta.frameDefaults?.width ?? 393,
        height: meta.frameDefaults?.height ?? 852,
      },
      previewAxes: {
        direction: meta.previewAxes?.direction ?? 'ltr',
        colorScheme: meta.previewAxes?.colorScheme ?? 'light',
        ...(meta.previewAxes?.locale ? { locale: meta.previewAxes.locale } : {}),
      },
      colorScheme: meta.profile?.colorScheme ?? null,
      hasLanguageProvider: hasLanguageContext(dir),
      locales: collectLocales(dir),
      hasDesignSystem: hasDesignSystemDependency(dir),
      links: readPrototypeFile(dir).links,
    })

    for (const file of generated) {
      const abs = join(dir, ...file.relPath.split('/'))
      if (writeIfDifferent(abs, file.contents)) result.regenerated.push(file.relPath)
    }
  } catch (err) {
    // The shell is an addition, never a precondition — a project that cannot
    // be scaffolded still has to open.
    console.error('[studio:prototypeShell]', err)
  }

  return result
}

/** True when the workspace declares `@alm-design/design-system` — the provider stack differs if it does. */
function hasDesignSystemDependency(dir: string): boolean {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return false
  const pkg = parseJsonWithFallback(readFileSync(file, 'utf8'), PackageJsonShape, {}) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return Boolean(pkg.dependencies?.['@alm-design/design-system'] ?? pkg.devDependencies?.['@alm-design/design-system'])
}
