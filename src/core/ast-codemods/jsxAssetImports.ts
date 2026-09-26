/**
 * jsxAssetImports — an image IMPORT in prop position (P5-B3, IMG-10, OD-12):
 * `<img src={heroPng} />` together with `import heroPng from './hero.png'`,
 * written by `insertJsxElement` in ONE splice.
 *
 * `asset-drop` lands a dropped image beside the ones a page already imports
 * when that page imports its images. The element that references it then
 * needs an import and an identifier — two places in one file, which is one
 * honest target for the same reason a component insert is: an element and
 * the binding it reads are one indivisible statement (`insertJsxElement`'s
 * "TWO WRITES, ONE TARGET").
 *
 * ## Two forms, and why the second is a class
 *
 *   - {@link AssetImportRef} `{ __assetImport: specifier }` is what arrives:
 *     a RELATIVE module specifier the server computed from a contained
 *     workspace path (`studioInsertAssetImports.ts`) — the browser only ever
 *     names a workspace file; the server alone spells the path from the file
 *     being written.
 *   - {@link BoundAssetImport} is what renders: the local name the import was
 *     bound to, after `planImportBindings` chose one that shadows nothing
 *     (`heroPng`, else `heroPng2`, or an existing default import of the same
 *     file, reused). It is a CLASS on purpose. The renderer prints its
 *     `local` as a bare identifier, which would be an expression-injection
 *     sink if a JSON body could produce one; no JSON value is ever an
 *     instance, so only this module's own binding step can.
 *
 * An unbound ref anywhere a render can reach — nested in an array, or sent to
 * a codemod that never binds (a slot fill, a loose layer) — is refused by
 * `validateSubtree`, never rendered as the object literal it looks like.
 */
import type { ImportRequirement } from './jsxImportEdits'

/** An image import the insert should write — the relative specifier from the file being written. */
export interface AssetImportRef {
  __assetImport: string
}

/** An image import already bound to a local name. Produced only by {@link bindAssetImports}. */
export class BoundAssetImport {
  readonly local: string
  constructor(local: string) {
    this.local = local
  }
}

/**
 * The tagged wire form: any plain object carrying the `__assetImport` key.
 * Deliberately broad — an object that merely LOOKS like a ref must never slip
 * past as ordinary data and be written as a literal `{ __assetImport: … }`.
 */
export function isAssetImportRef(value: unknown): value is AssetImportRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof BoundAssetImport) return false
  return '__assetImport' in value
}

/**
 * A specifier this module will write: relative, to an image, spelled from a
 * conservative character set. The server computes it, and it is checked again
 * here because this is the line that lands in the user's file — a quote or a
 * newline in it would end the string literal.
 */
const SAFE_SPECIFIER = /^\.{1,2}\/[A-Za-z0-9_\-./@]+\.(?:png|jpe?g|gif|webp|avif|svg)$/i

export function isSafeAssetSpecifier(specifier: string): boolean {
  return SAFE_SPECIFIER.test(specifier) && !specifier.includes('//')
}

/**
 * The binding a hand-written import of this file would most likely use:
 * the base name in camelCase plus its extension — `hero.png` → `heroPng`,
 * `team-photo@2x.jpg` → `teamPhoto2xJpg`. A name that would start with a
 * digit gets an `img` prefix; the extension suffix keeps it off every reserved
 * word.
 */
export function assetImportBindingName(specifier: string): string {
  const file = specifier.slice(specifier.lastIndexOf('/') + 1)
  const dot = file.lastIndexOf('.')
  const words = [...file.slice(0, dot).split(/[^A-Za-z0-9]+/), file.slice(dot + 1)].filter((word) => word.length > 0)
  const camel = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('')
  return /^[A-Za-z_$]/.test(camel) ? camel : `img${camel}`
}

interface NodeWithProps {
  props?: Record<string, unknown>
  children?: string | readonly NodeWithProps[]
}

function* walkNodes<T extends NodeWithProps>(node: T): Generator<T> {
  yield node
  if (Array.isArray(node.children)) for (const child of node.children as T[]) yield* walkNodes(child)
}

export type CollectedAssetImports =
  | { ok: true; required: Map<string, ImportRequirement>; nameFor: (specifier: string) => string }
  | { ok: false; specifier: string }

/**
 * Every image import the run's DIRECT prop values ask for, keyed by the
 * binding name each wants — two different files that both want `heroPng`
 * get `heroPng` and `heroPng2` before the file's own names are consulted.
 * `ok: false` names the first specifier {@link isSafeAssetSpecifier} refuses.
 */
export function collectAssetImports(run: readonly NodeWithProps[]): CollectedAssetImports {
  const required = new Map<string, ImportRequirement>()
  const bySpecifier = new Map<string, string>()
  for (const root of run) {
    for (const node of walkNodes(root)) {
      for (const value of Object.values(node.props ?? {})) {
        if (!isAssetImportRef(value)) continue
        const specifier = value.__assetImport
        if (typeof specifier !== 'string' || !isSafeAssetSpecifier(specifier)) return { ok: false, specifier: String(specifier) }
        if (bySpecifier.has(specifier)) continue
        const base = assetImportBindingName(specifier)
        let name = base
        for (let n = 2; required.has(name); n += 1) name = `${base}${n}`
        required.set(name, { specifier, style: 'default' })
        bySpecifier.set(specifier, name)
      }
    }
  }
  return { ok: true, required, nameFor: (specifier) => bySpecifier.get(specifier)! }
}

/**
 * `node` with every direct-prop {@link AssetImportRef} replaced by the
 * {@link BoundAssetImport} its specifier was bound to. `localName` maps the
 * collected name to the one `planImportBindings` settled on.
 */
export function bindAssetImports<T extends NodeWithProps>(
  node: T,
  nameFor: (specifier: string) => string,
  localName: (name: string) => string,
): T {
  const props = node.props
  let nextProps: Record<string, unknown> | undefined
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (!isAssetImportRef(value)) continue
      nextProps ??= { ...props }
      nextProps[key] = new BoundAssetImport(localName(nameFor(value.__assetImport)))
    }
  }
  const children = Array.isArray(node.children)
    ? (node.children as T[]).map((child) => bindAssetImports(child, nameFor, localName))
    : node.children
  return { ...node, ...(nextProps ? { props: nextProps } : {}), ...(Array.isArray(node.children) ? { children } : {}) }
}
