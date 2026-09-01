/**
 * tokenExtractPackageCss — the design tokens an INSTALLED component package
 * ships, found without the project having to import its stylesheet.
 *
 * ## Why this exists
 *
 * `styleCompile.ts`'s `collectVendorCss` reads exactly the package
 * stylesheets the project's own source imports, which is correct: it models
 * what this project's CSS actually IS, and the canvas must not be styled by a
 * sheet the real app never loads.
 *
 * Token EXTRACTION is a different question. It asks "what design language does
 * this project have available", and the Framework panel already names its
 * answer "an installed design-system package" (`SOURCE_LABEL['vendor-css']`).
 * A freshly scaffolded project depends on a design system, has it installed,
 * and imports no stylesheet from it yet — so the import-driven path found
 * nothing and the panel reported "No design tokens were found in this
 * project's CSS custom properties, Tailwind theme, vendor package CSS, …"
 * while 297 custom properties sat in `node_modules/@alm-design/design-system/
 * dist/index.css`. The message named vendor package CSS as something it had
 * checked, and it had not.
 *
 * This is a LAST-RESORT source in `tokenExtract.ts`, tried only after the
 * project's own compiled CSS, Tailwind, imported vendor CSS, Sass variables
 * and a JS theme all came back empty. That ordering matters: anything the
 * project actually imports is a stronger statement of intent than something
 * merely sitting in `node_modules`.
 *
 * ## Resolution
 *
 * Only packages `projectProbe` already classified as COMPONENT packages are
 * consulted — never every installed dependency, which would let an unrelated
 * package's stylesheet define the project's design language.
 *
 * Per package, the first candidate that exists wins: the `style` field, then
 * any `.css` value in `exports`, then the conventional bundle names. Every
 * resolved path is containment-checked against the package's own directory,
 * so a crafted `style: "../../../etc/passwd"` resolves to nothing — the same
 * posture `styleCompile.ts`'s `resolvePackageCssPath` holds.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { readCappedFile } from './styleCompileFileRead'

/** The two package.json fields that can name a stylesheet. `exports` is deliberately loose — its value shape is a union of string, array and nested condition objects, and this only ever harvests the `.css` strings out of it. */
const PackageStyleFieldsSchema = Type.Object({
  style: Type.Optional(Type.String()),
  exports: Type.Optional(Type.Unknown()),
})

/** Conventional bundle names, tried when the manifest names no stylesheet. Ordered most- to least- common. */
const CONVENTIONAL_CSS = [
  'dist/index.css',
  'dist/style.css',
  'dist/styles.css',
  'index.css',
  'style.css',
  'styles.css',
] as const

/** Every `.css` string anywhere in an `exports` value, at any nesting depth. */
function cssPathsInExports(node: unknown, out: string[], depth = 0): void {
  if (depth > 6) return
  if (typeof node === 'string') {
    if (node.endsWith('.css')) out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) cssPathsInExports(item, out, depth + 1)
    return
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) cssPathsInExports(value, out, depth + 1)
  }
}

/** `absPath` is inside `pkgRoot` — rejects a `style`/`exports` entry that climbs out of the package. */
function containedInPackage(pkgRoot: string, absPath: string): boolean {
  const rel = relative(pkgRoot, absPath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The stylesheet text of every installed package in `packages`, concatenated.
 * `''` when none of them is installed or none ships a resolvable stylesheet —
 * the caller treats that exactly like every other source coming back empty.
 *
 * `appRootAbs` is the project's APP ROOT (`approot-01`), since a nested app
 * installs its own `node_modules` there.
 */
export function readInstalledPackageCss(appRootAbs: string, packages: readonly string[]): string {
  const chunks: string[] = []
  for (const pkgName of [...packages].sort()) {
    const pkgRoot = join(appRootAbs, 'node_modules', ...pkgName.split('/'))
    if (!existsSync(pkgRoot)) continue

    const manifest = readCappedFile(join(pkgRoot, 'package.json'))
    const fields = manifest ? safeParseJson(manifest, PackageStyleFieldsSchema) : undefined
    const exported: string[] = []
    if (fields?.ok) cssPathsInExports(fields.value.exports, exported)

    const candidates = [
      ...(fields?.ok && fields.value.style ? [fields.value.style] : []),
      ...exported,
      ...CONVENTIONAL_CSS,
    ]

    for (const rel of candidates) {
      const absPath = join(pkgRoot, ...rel.replace(/^\.\//, '').split('/'))
      if (!containedInPackage(pkgRoot, absPath) || !existsSync(absPath)) continue
      const text = readCappedFile(absPath)
      if (text === undefined) continue
      chunks.push(`/* studio: installed ${pkgName} ${rel} */\n${text}`)
      break // one stylesheet per package — the first that resolves is its entry
    }
  }
  return chunks.join('\n\n')
}
