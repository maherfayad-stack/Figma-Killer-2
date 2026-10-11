/**
 * moduleSourceElement — how a registry module is SPELLED as one JSX element in
 * a user's source, or `null` when it has no honest spelling at all.
 *
 * Two places write a brand-new element for a module and must agree exactly on
 * that spelling: an insert into a page (`studioSourceWrites.ts`'s
 * `writeInsertToSource`) and a component dropped on the empty board, which
 * becomes a loose layer module (`canvasLayerGestures.ts`'s `createCanvasLayer`,
 * P5-G G1). They used to be one inline branch in the first; a second copy for
 * the free canvas is how a Button would come out as `<Button label="Label"/>`
 * in a page and something else on the board.
 *
 * The spelling comes from the MODULE REGISTRY, never a hardcoded design system:
 *
 *   - `sourceImport` — a component: its import name, and either the package
 *     specifier or `designSystemImport` (the built-in design system names only
 *     itself; the SERVER computes the relative path for the file it writes,
 *     because the editor does not know where that file sits). Its props are
 *     the defaults that have an unambiguous JSX spelling (`insertableJsxProps`).
 *   - `sourceIntrinsic` — an intrinsic element (`base.container` is a `<div>`,
 *     `base.text` a `<p>` around its text). Only the caller's inline styles are
 *     written as props: the module defaults are canvas values, and the tag and
 *     text are what `sourceIntrinsic` derived from them.
 */
import { registry } from '@core/module-engine'
import type { InsertPropValue } from '@site/studio/studioSaveRequests'
import { insertableJsxProps } from './insertablePropValues'

export interface ModuleSourceElement {
  name: string
  importSpecifier?: string
  designSystemImport?: true
  props: Record<string, InsertPropValue>
  children?: string
  /**
   * True when `name` is an intrinsic tag, written verbatim — so a same-tick
   * placeholder may honestly use it. False for a component, whose real root
   * tag is unknowable without executing it.
   */
  intrinsic: boolean
}

/** The module's merged props (defaults under the caller's overrides) — what the canvas preview renders with. */
export function moduleInsertProps(moduleId: string, defaults: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...(registry.get(moduleId)?.defaults ?? {}), ...(defaults ?? {}) }
}

export function moduleSourceElement(
  moduleId: string,
  defaults: Record<string, unknown> | undefined,
  inlineStyles?: Record<string, string>,
): ModuleSourceElement | null {
  const mod = registry.get(moduleId)
  if (!mod) return null
  const props = moduleInsertProps(moduleId, defaults)

  const sourceImport = mod.sourceImport
  if (sourceImport) {
    return {
      name: sourceImport.name,
      ...(sourceImport.kind === 'package'
        ? { importSpecifier: sourceImport.specifier }
        : { designSystemImport: true as const }),
      props: insertableJsxProps(props),
      intrinsic: false,
    }
  }

  const intrinsic = mod.sourceIntrinsic?.(props)
  if (!intrinsic) return null
  return {
    name: intrinsic.tag,
    // `K4` — a caller-supplied inline-style bag is written as part of THIS
    // element, not as a follow-up edit: the node does not exist until the
    // codemod runs. Keys are React-style camelCase (`borderRadius`), the
    // spelling `renderJsxNode` emits into `style={{ … }}` and the parser reads.
    props: inlineStyles && Object.keys(inlineStyles).length > 0 ? { style: { ...inlineStyles } } : {},
    ...(intrinsic.text === undefined ? {} : { children: intrinsic.text }),
    intrinsic: true,
  }
}
