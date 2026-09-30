/**
 * studioInsertAssetImports — the server half of an image IMPORT written by an
 * insert (P5-B3, IMG-10, OD-12): `src={ __assetImport: 'src/assets/hero.png' }`
 * on the wire becomes `src={ __assetImport: '../assets/hero.png' }` for the
 * codemod, which writes `import heroPng from '../assets/hero.png'` and
 * `src={heroPng}` in one splice (`jsxAssetImports.ts`).
 *
 * ## Why the browser names a FILE and the server spells the PATH
 *
 * The same split `kind: 'asset'` and `designSystemImport` already make: the
 * specifier is relative to the file being written, which only the server has
 * decoded (`studioEditLocation` → `target.rel`), and the path is a
 * client-supplied string that ends up verbatim in the user's tracked source.
 * So it goes through `resolveContainedRefPath` — the shared adversarial guard
 * (no absolute/UNC/drive forms, no `..`, no excluded directory, containment on
 * the REAL path, and the file must exist) — before a specifier is computed
 * from it with `relativeImportSpecifier`, the exact inverse of how the parser
 * reads an image import back.
 *
 * ## Next.js refuses
 *
 * In a Next project `import x from './a.png'` is a `StaticImageData` object
 * and `<img src={x}>` renders `[object Object]`. The drop never chooses import
 * mode there (`assetImportConvention.ts`), and this refuses any insert that
 * asks for one anyway — an Assets-panel image outside `public/`, or a
 * hand-built request — with the remedy.
 */
import { isAssetImportRef, type InsertJsxNode } from '@core/ast-codemods'
import { resolveProjectProfile } from './studio/projectProbe'
import { relativeImportSpecifier, resolveContainedRefPath } from './studioEditTargets'

interface PropsCarrier {
  props?: Record<string, unknown>
  children?: string | readonly InsertJsxNode[]
  siblings?: readonly InsertJsxNode[]
}

export type AssetImportResolution<T> = { ok: true; value: T } | { ok: false; reason: string; message: string }

function hasAssetImport(node: { props?: Record<string, unknown>; children?: string | readonly InsertJsxNode[] }): boolean {
  if (Object.values(node.props ?? {}).some(isAssetImportRef)) return true
  return Array.isArray(node.children) && node.children.some(hasAssetImport)
}

/**
 * `edit` with every direct-prop image import (in its own props, its
 * `children` subtree and its `siblings`) re-spelled from a workspace path to
 * the specifier `targetRel` imports it by — or the refusal that stops the
 * whole write. An edit with no image import comes back unchanged, as is.
 */
export function resolveInsertAssetImports<T extends PropsCarrier>(
  dir: string,
  targetRel: string,
  edit: T,
): AssetImportResolution<T> {
  const nodes: { props?: Record<string, unknown>; children?: string | readonly InsertJsxNode[] }[] = [
    edit,
    ...(edit.siblings ?? []),
  ]
  if (!nodes.some(hasAssetImport)) return { ok: true, value: edit }

  const framework = resolveProjectProfile(dir).framework
  if (framework === 'next-app' || framework === 'next-pages') {
    return {
      ok: false,
      reason: 'asset-import',
      message:
        'In a Next.js project an imported image is an object, not a URL, so <img src={…}> would render "[object Object]". Move the image into public/ and add it from there.',
    }
  }

  let refusal: { reason: string; message: string } | null = null
  const resolveProps = (props: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!props) return props
    let next: Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(props)) {
      if (!isAssetImportRef(value)) continue
      const rel = typeof value.__assetImport === 'string' ? resolveContainedRefPath(dir, value.__assetImport) : null
      if (rel === null) {
        refusal ??= {
          reason: 'asset-unavailable',
          message: 'That image is not a file in this project any more, so there is nothing to import. Reload the project and try again.',
        }
        continue
      }
      next ??= { ...props }
      next[key] = { __assetImport: relativeImportSpecifier(targetRel, rel) }
    }
    return next ?? props
  }
  const resolveNode = (node: InsertJsxNode): InsertJsxNode => ({
    ...node,
    ...(node.props ? { props: resolveProps(node.props) as InsertJsxNode['props'] } : {}),
    ...(Array.isArray(node.children) ? { children: node.children.map(resolveNode) } : {}),
  })

  const value: T = {
    ...edit,
    ...(edit.props ? { props: resolveProps(edit.props) } : {}),
    ...(Array.isArray(edit.children) ? { children: edit.children.map(resolveNode) } : {}),
    ...(edit.siblings ? { siblings: edit.siblings.map(resolveNode) } : {}),
  }
  return refusal ? { ok: false, ...(refusal as { reason: string; message: string }) } : { ok: true, value }
}
