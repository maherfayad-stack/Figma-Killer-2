/**
 * canvasLayerModule — the text of a free-canvas layer module (P5-G, FC-2):
 * `.studio/canvas/<id>.tsx`, one default-exported component that returns
 * exactly one root element.
 *
 * The ONLY producer of that text. Three writes need it — a layer created from
 * an element spec (an image dropped on the empty board), an element LIFTED out
 * of a page onto the board, and nothing else yet — and all three must agree on
 * the shape the loader and the place-into-frame codemod read back:
 *
 * ```tsx
 * /* eslint-disable *\/
 * // Studio free-canvas layer. Not part of your app: nothing imports this file.
 * import { Card } from '../../components/Card'
 *
 * export default function CanvasLayer() {
 *   return (
 *     <Card title="Hello" />
 *   )
 * }
 * ```
 *
 * The header is not decoration: ESLint's flat config lints dot-directories, and
 * a scratch file must never fail the user's `eslint .` (design §6.3).
 *
 * Imports are rendered by `resolveImportEdits` — the same function every other
 * structural write spells its import lines with — against an empty module, so
 * a carried default or namespace import keeps its own shape and named imports
 * from one specifier share one line.
 */
import { Project } from 'ts-morph'
import { CANVAS_LAYER_MODULE_HEADER } from '@core/studio-board'
import {
  collectSubtreeImports,
  indentBlock,
  renderJsxNode,
  validateSubtree,
  type InsertJsxNode,
  type InsertJsxRefusal,
} from './jsxSubtree'
import { resolveImportEdits, type ImportRequirement } from './jsxImportEdits'
import type { CreatedJsxLocation } from './createdJsxLocation'

/** The component name a layer module exports, unless a carried import already uses it. */
const LAYER_COMPONENT_NAME = 'CanvasLayer'

export interface CanvasLayerModule {
  text: string
  /** The root element's tag-name `line:col` in `text` — the layer root's node id, before any parse. */
  root: CreatedJsxLocation
}

/**
 * Build a layer module around `rootJsx` (the root element's source, written
 * at column 0 with its own relative indentation) and the bindings it needs.
 */
export function buildCanvasLayerModule(
  rootJsx: string,
  imports: ReadonlyMap<string, ImportRequirement>,
): CanvasLayerModule {
  const importText = renderImports(imports)
  const componentName = freeComponentName(imports)
  const head = `${CANVAS_LAYER_MODULE_HEADER}\n${importText}\nexport default function ${componentName}() {\n  return (\n    `
  const text = `${head}${indentBlock(rootJsx, '    ')}\n  )\n}\n`
  // The root's `<` sits right after `head`; the tag name one column later.
  const line = head.split('\n').length
  const lastLineStart = head.lastIndexOf('\n') + 1
  return { text, root: { line, col: head.length - lastLineStart + 2 } }
}

/**
 * A layer module whose root is a NEW element — the write behind an image
 * dropped on the empty board. The spec is `insertJsxElement`'s own
 * (`InsertJsxNode`), validated by the same rules (safe tag names, no children
 * on a void element) and rendered by the same renderer, so an element placed
 * on the canvas is written exactly as the same element inserted into a page.
 */
export function canvasLayerModuleFromSpec(
  root: InsertJsxNode,
): { ok: true; module: CanvasLayerModule } | { ok: false; refusal: InsertJsxRefusal } {
  const invalid = validateSubtree(root)
  if (invalid) return invalid
  return { ok: true, module: buildCanvasLayerModule(renderJsxNode(root, '  '), collectSubtreeImports(root)) }
}

function renderImports(imports: ReadonlyMap<string, ImportRequirement>): string {
  if (imports.size === 0) return ''
  const empty = new Project({ useInMemoryFileSystem: true }).createSourceFile('/layer.tsx', '')
  return resolveImportEdits(empty, '', imports).map((edit) => edit.text).join('')
}

/** `CanvasLayer`, or `CanvasLayer2`… when a carried binding already has that name. */
function freeComponentName(imports: ReadonlyMap<string, ImportRequirement>): string {
  if (!imports.has(LAYER_COMPONENT_NAME)) return LAYER_COMPONENT_NAME
  for (let n = 2; ; n++) {
    const candidate = `${LAYER_COMPONENT_NAME}${n}`
    if (!imports.has(candidate)) return candidate
  }
}
