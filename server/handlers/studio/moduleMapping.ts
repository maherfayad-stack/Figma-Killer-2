/**
 * moduleMapping — "which Studio module does this parsed node become, and which
 * of its props is the inline-text-edit target?"
 *
 * Extracted from `studioPageLoad.ts`, which owns the load PIPELINE (discover →
 * parse → inline → resolve styles → convert). This pair is a different reason
 * to change: it encodes the base-module catalogue's own rules — which HTML tags
 * are containers, when an element is a genuine leaf, which module id a package
 * component gets — and it changes when the MODULES change, not when the
 * pipeline does. `parsedPageToSitePage` calls both through the two callbacks
 * `loadStudioPages` binds.
 *
 * Server-side on purpose, and deliberately NOT reading the browser module
 * registry (`@core/module-engine`'s `registry`): the page-parser and
 * ast-codemods run here in Node, decoupled from the browser module bundle.
 * `resolveTextProp` therefore MIRRORS the base modules' own
 * `inlineTextEdit.prop` — see its doc.
 */
import type { ComponentSource, ParsedPropValue } from '@core/page-parser'
import { TEXT_HTML_TAG_SET } from '@modules/base/utils/htmlTag'
import { packageModuleId } from '@core/module-engine'
import { ALM_DESIGN_PACKAGE_SPECIFIER } from './designSystemDetect'

const CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside',
])

/**
 * Map a parsed node to an Studio moduleId (design-system → alm.* / pkg.*, host
 * tags → base.*).
 *
 * WS-3.3 — a `kind: 'component'` node whose `componentSources` classification
 * (computed earlier in `loadStudioPages`, from the PRE-inline tree — see that
 * function's doc) says it's a `package` import gets the generic
 * `pkg.<sanitized-package>.<ComponentName>` id (`packageModuleId`), so
 * `registerProjectModules.ts` can register — and the canvas can find — a
 * module for whatever npm design system the project actually imports, not
 * just the one hardcoded `@alm-design/design-system` case (kept on `alm.*`
 * — see `ALM_DESIGN_PACKAGE_SPECIFIER`'s doc). A `kind: 'component'` node with
 * no package classification at all (a LOCAL component `inlineLocalComponents`
 * declined to expand — recursion, missing declaration, cap reached) keeps the
 * old `alm.<Name>` id: there is no package to bundle for it, so it renders
 * "Unknown module" exactly as it did before this change, which is the honest
 * outcome for content this pipeline cannot materialize.
 *
 * `base.text` and `base.button` are the two modules that need care, because
 * they share two properties: both are leaves (`canHaveChildren: false`) and
 * both render a hardcoded placeholder — the literal words "Text" and "Button" —
 * when their content prop is empty. That placeholder is the right affordance
 * for a hand-authored page (an empty text block stays visible and clickable),
 * but on an imported page it is pure noise: real repos are full of elements
 * that carry no text at all, like `<span className="hp-avatar" />` used purely
 * as a CSS-styled icon slot.
 *
 * So those two modules apply only to an element that BOTH has captured text and
 * has no element children. Everything else that isn't a genuine HTML leaf
 * becomes `base.container`, which preserves the real host tag through its
 * `tag`/`customTag` props (see `parsedPageToSitePage`) and renders children —
 * so an `<h1>` stays an `<h1>`, and an icon-only `<button>` still emits
 * `<button>`, just without a phantom label.
 *
 * Measured on the eSIM corpus before this rule: 154 nodes rendered the literal
 * word "Text", 21 rendered "Button", and 10 buttons silently dropped their
 * children.
 */
export function resolveModuleId(
  node: {
    id: string
    kind: 'element' | 'component'
    name: string
    children: string[]
    text?: string
    props?: Record<string, ParsedPropValue>
    /** WS-4.2 — present when `inlineLocalComponents` successfully expanded this call site into an instance. */
    instanceOf?: { componentName: string; source: 'local' | 'package'; sourceFile: string | null }
    /** E2.3 — present when `captureSlotProps`'s fragment branch minted this node as a fragment-valued slot's container. */
    fragmentSlot?: true
  },
  componentSources: Record<string, ComponentSource>,
): string {
  // E2.3 — checked before the `kind`-based dispatch below, same as
  // `instanceOf` is: a fragment-captured slot container has no tag name to
  // route on (`node.name` is the placeholder `'Fragment'`), so this must be
  // the first thing asked, not a fallback.
  if (node.fragmentSlot) return 'studio.slot'
  if (node.kind === 'component') {
    // WS-4.2 — a call site `inlineLocalComponents` actually expanded renders
    // as the zero-DOM instance fragment, whatever `componentSources` says
    // about it (it will say `local`, since only local expansion produces
    // this field — checked FIRST, not merged into the branch below, so a
    // future package-instance producer of this same field doesn't have to
    // fight the `alm.`/`pkg.` fallback order). A `kind: 'component'` node
    // with NO `instanceOf` is either a package reference (never inlined) or
    // a local call site inlining DECLINED to expand — both keep the
    // pre-WS-4 fallback below unchanged.
    if (node.instanceOf) return 'studio.instance'
    const source = componentSources[node.id]
    if (source?.kind === 'package' && source.specifier !== ALM_DESIGN_PACKAGE_SPECIFIER) {
      return packageModuleId(source.specifier, node.name)
    }
    return `alm.${node.name}`
  }
  // An element carrying resolved raw SVG markup renders as `base.svg`
  // whatever its tag — the `<span dangerouslySetInnerHTML={{__html: icon}} />`
  // shape is how real repos inline an icon, and the markup is the content.
  if (typeof node.props?.svg === 'string' && node.props.svg.length > 0) return 'base.svg'
  const tag = node.name.toLowerCase()
  if (CONTAINER_TAGS.has(tag)) return 'base.container'
  // Genuine HTML leaves, plus `base.link` which does accept children.
  if (tag === 'img') return 'base.image'
  if (tag === 'svg') return 'base.svg'
  if (tag === 'a') return 'base.link'
  // No element children AND non-empty text. `''` counts as no content — an
  // element whose text is empty or whitespace-only would render the
  // placeholder just the same.
  if (node.children.length > 0 || !node.text) return 'base.container'
  if (tag === 'button') return 'base.button'
  // `base.text` has no custom-tag escape hatch, so a tag it cannot render
  // (`<label>`, `<figcaption>`, …) would silently come out as its default
  // `<p>`. Those go to `base.container`, which can represent any tag.
  return TEXT_HTML_TAG_SET.has(tag) ? 'base.text' : 'base.container'
}

/**
 * Map a resolved moduleId to the single prop key its module's
 * `inlineTextEdit` declares. MUST stay in sync with the base modules'
 * `inlineTextEdit.prop` (`src/modules/base/{text,button,link}/index.ts`) —
 * the browser-side `fsCodemodAdapter` reads the same contract off the actual
 * module registry (`@core/module-engine`), which this server-side handler
 * intentionally does not import (page-parser/ast-codemods run here in Node,
 * decoupled from the browser module bundle). `alm.*` design-system
 * components declare no `inlineTextEdit` — out of scope for source
 * writeback this slice.
 */
export function resolveTextProp(moduleId: string): string | null {
  switch (moduleId) {
    case 'base.text':
      return 'text'
    case 'base.button':
      return 'label'
    case 'base.link':
      return 'text'
    default:
      return null
  }
}

