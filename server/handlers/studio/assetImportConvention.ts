/**
 * assetImportConvention — does the file an image is being dropped into IMPORT
 * its images, or reference them from `public/` by URL? (P5-B3, IMG-10,
 * owner decision OD-12.)
 *
 * `asset-drop`'s original answer was always `public/` plus a literal
 * `src="/hero.png"`: the one location every recognised framework serves
 * verbatim, needing no import. That stays the DEFAULT. But a Vite/CRA
 * codebase whose pages write `import hero from '../assets/hero.png'` and
 * `<img src={hero}>` gets a dropped image that looks nothing like its
 * neighbours, in a folder nobody else uses. So the drop now follows what the
 * file already does — detected, never toggled:
 *
 *   - **Static.** The file's own text is parsed (never executed) and two
 *     things are counted: default imports of an image file, and `src`
 *     attributes holding a site-root string literal (`"/x.png"`).
 *   - **Strict majority, else `public`.** Import mode only when imports
 *     outnumber literals; a tie, or a file with no images at all, stays
 *     `public` — the audit's mitigation for misdetection.
 *   - **Next.js is always `public`.** There, `import x from './a.png'` is a
 *     `StaticImageData` object and `<img src={x}>` renders `[object Object]`.
 *   - **Where.** The directory most of the file's RELATIVE image imports
 *     point at (first-seen wins a tie), resolved against the file's own
 *     directory. An import that climbs out of the project, or a file whose
 *     imports are all aliases (`@/assets/…`), falls back to
 *     `DEFAULT_ASSET_TARGET_DIR`. The directory is SERVER-derived from the
 *     project's own source and still goes through `landAssetBytes`'s
 *     `resolveAssetWriteDir` containment check — the browser never names it.
 *
 * Pure apart from reading the one file, whose path is contained by
 * `resolveWorkspaceReadPath` and whose size is capped.
 */
import { readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { ts } from 'ts-morph'
import { IMAGE_SPECIFIER_RE, resolveWorkspaceReadPath } from '@core/page-parser'
import { DEFAULT_ASSET_TARGET_DIR } from './assetLanding'
import type { ProjectFramework } from './projectProfileSchema'

export type ImageConvention = { mode: 'public' } | { mode: 'import'; targetDir: string }

/** A page larger than this is not read for a vote; the drop stays `public`. */
const MAX_CONVENTION_SOURCE_BYTES = 2 * 1024 * 1024

const PUBLIC: ImageConvention = { mode: 'public' }

/** A site-root URL literal (`/hero.png`), not a protocol-relative `//cdn/x`. */
function isSiteRootLiteral(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

/**
 * The convention `sourceText` (the file at workspace-relative `fileRel`)
 * follows. Exported for its own test: "which mode, and which folder" is the
 * whole decision, and it is not observable through the HTTP shell.
 */
export function detectImageConvention(sourceText: string, fileRel: string, framework: ProjectFramework): ImageConvention {
  if (framework === 'next-app' || framework === 'next-pages') return PUBLIC

  const file = ts.createSourceFile(fileRel, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  let imports = 0
  let literals = 0
  const dirVotes = new Map<string, number>()
  const fileDir = posix.dirname(fileRel)

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (node.importClause?.name && IMAGE_SPECIFIER_RE.test(specifier)) {
        imports += 1
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          const target = posix.normalize(posix.join(fileDir, posix.dirname(specifier)))
          if (target !== '..' && !target.startsWith('../') && target !== '.') {
            dirVotes.set(target, (dirVotes.get(target) ?? 0) + 1)
          }
        }
      }
      return
    }
    if (ts.isJsxAttribute(node) && node.name.getText(file) === 'src' && node.initializer) {
      const init = node.initializer
      const literal = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
          ? init.expression.text
          : null
      if (literal !== null && isSiteRootLiteral(literal)) literals += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  if (imports <= literals) return PUBLIC
  let targetDir = DEFAULT_ASSET_TARGET_DIR
  let best = 0
  for (const [dir, votes] of dirVotes) {
    if (votes > best) {
      best = votes
      targetDir = dir
    }
  }
  return { mode: 'import', targetDir }
}

/**
 * {@link detectImageConvention} for the file at `pageRelRaw` in `dir` — a
 * client-supplied path, so it is contained first. A path that does not
 * resolve to a readable project file (missing, excluded, escaping, too
 * large) answers `public`: the default is always a safe place to land.
 */
export function readImageConvention(dir: string, pageRelRaw: string, framework: ProjectFramework): ImageConvention {
  const resolved = resolveWorkspaceReadPath(dir, pageRelRaw)
  if (!resolved) return PUBLIC
  try {
    if (statSync(resolved.real).size > MAX_CONVENTION_SOURCE_BYTES) return PUBLIC
    return detectImageConvention(readFileSync(resolved.real, 'utf8'), resolved.rel, framework)
  } catch (err) {
    console.error('[studio:asset-drop] could not read the page for its image convention', err)
    return PUBLIC
  }
}
