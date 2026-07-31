/**
 * PageNode — BaseNode plus an optional `dynamicBindings` map for CMS template
 * pages. Pages use a flat `nodes: Record<string, PageNode>` map (same as
 * `NodeTreeSchema.nodes`) — nodes are stored in a flat ID-keyed map.
 *
 * The `dynamicBindings` overlay is applied at render time when the page is
 * used as a CMS content template. Static props remain stored as fallback
 * values.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { BaseNodeSchema, parseBaseNodeFields } from './baseNode'
import { DynamicPropBindingSchema, parseDynamicBindings } from './dynamicBinding'
import { asPlainObject } from './parseHelpers'

// ---------------------------------------------------------------------------
// PageNodeSchema
// ---------------------------------------------------------------------------

export const PageNodeSchema = Type.Object({
  ...BaseNodeSchema.properties,
  /**
   * Template-only prop bindings.
   * Static props remain stored as fallback values; dynamicBindings overlay them
   * at render time when a page is used as a CMS content template.
   * Silently dropped if invalid — handled in parsePageNode.
   */
  dynamicBindings: Type.Optional(Type.Record(Type.String(), DynamicPropBindingSchema)),
  /**
   * Studio import (§7) — present only when a value in this node's
   * `props`/`inlineStyles`/`text` was resolved by the page-parser's static
   * evaluator from a non-literal source expression, rather than being a
   * literal already sitting in the source file. `source` is the short
   * original expression text (e.g. `"t.homepage.greeting"`); `note` records
   * a resolution choice worth surfacing to the editor (e.g. a dynamically
   * indexed dictionary picked a specific locale/branch). See
   * `ParsedNode.resolution` in `@core/page-parser` — `parsedPageToSitePage`
   * copies it straight across, same pattern as `locked`/`lockReason`.
   *
   * **Never locks the node.** Writing an edit back over the original
   * expression would silently destroy it, but that is a fact about one VALUE
   * and is recorded per-prop in `codeProps`; the element itself sits at a known
   * line and column and moves like any other. See `withResolution` in
   * `@core/page-parser`'s `nodeResolution.ts`.
   */
  resolution: Type.Optional(Type.Object({ source: Type.String(), note: Type.Optional(Type.String()) })),
  /**
   * Studio import (parser-06) — present on the node the parser SELECTED when
   * a component had more than one JSX-bearing `return`, or a JSX child was a
   * ternary/`&&`. Lists the branch(es) NOT shown, each just a label + source
   * location, never a materialized subtree — see `BranchAlternative` in
   * `@core/page-parser`. Does NOT lock the node: the parser is certain of the
   * STRUCTURE here, it only chose which of several runtime states to show by
   * default.
   */
  branchAlternatives: Type.Optional(Type.Array(Type.Object({
    label: Type.String(),
    loc: Type.Object({ file: Type.String(), line: Type.Number(), col: Type.Number() }),
  }))),
  /**
   * Studio import (§7) — where this node's TEXT literally lives, when its text
   * resolved from an expression that bottomed out in one string literal inside
   * the workspace (`{c.hotelsTag}` -> `hotelsTag: '…'` in `translations.js`).
   *
   * The reason a resolved node can be edited at all. The JSX is not a writeback
   * target, but this literal is: `saveSite` turns a text change on such a node
   * into a `literal` studio edit aimed here instead of a `text` edit aimed at the
   * JSX. See `ParsedNode.textOrigin` for the full reasoning and why it is scoped
   * to text rather than hung off `resolution`.
   */
  textOrigin: Type.Optional(Type.Object({
    rel: Type.String(),
    line: Type.Number(),
    col: Type.Number(),
  })),
  /**
   * Studio import (WS-8.3) — where the IMPORT DECLARATION naming this node's
   * resolved image lives, when one of its props (`src`) resolved to a
   * `studio-asset:` sentinel traced back to `import heroImg from './hero.png'`.
   *
   * Same shape and same reasoning as `textOrigin` above, aimed at a different
   * literal: the JSX (`src={heroImg}`) is never the writeback target, but the
   * import's own module-specifier string IS an ordinary literal at a known
   * position, and `setImportSpecifier` rewrites exactly that. See
   * `ParsedNode.assetOrigin` in `@core/page-parser`.
   */
  assetOrigin: Type.Optional(Type.Object({
    rel: Type.String(),
    line: Type.Number(),
    col: Type.Number(),
  })),
  /**
   * Studio import — the prop names on this node that are NOT writable back to
   * source, because the source holds an expression rather than a literal
   * attribute. Inline-style entries appear as `style:<property>`.
   *
   * This is what the editor's edit guards consult, NOT `locked`/`lockReason`.
   * Those two describe the node's STRUCTURE (a `.map` generated it, a ternary
   * chose it, a spread feeds it) and say nothing about whether `title="Where
   * to?"` on it is a writable literal. Gating props on the structural lock
   * refused every prop on 42% of an imported app's nodes — including the plain
   * literal attributes that `setJsxProp` rewrites precisely — while the panel
   * went on showing live-looking inputs. See `ParsedNode.codeProps`.
   */
  codeProps: Type.Optional(Type.Array(Type.String())),
  /**
   * Studio import (§2) — the local component this node was inlined out of
   * (`'SheetHeader'`). Provenance, not a lock: the node is editable and its
   * writeback target is that component's own source location.
   *
   * It exists because that one file backs EVERY instance of the component, so
   * an edit here lands on all of them. The properties panel warns with this
   * name and the instance count before the user commits. See
   * `ParsedNode.fromComponent` in `@core/page-parser`.
   */
  fromComponent: Type.Optional(Type.String()),
})

export type PageNode = Static<typeof PageNodeSchema>

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/** Parse a raw `resolution` field — dropped (not thrown) if malformed, same per-field tolerance as every other optional BaseNode field. */
function parseResolution(raw: unknown): { source: string; note?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.source !== 'string') return undefined
  return typeof r.note === 'string' ? { source: r.source, note: r.note } : { source: r.source }
}

/** Parse a raw `branchAlternatives` field — drops any entry missing a string `label` or a well-formed `loc`, same per-entry tolerance the rest of this parser uses. */
function parseBranchAlternatives(raw: unknown): { label: string; loc: { file: string; line: number; col: number } }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries: { label: string; loc: { file: string; line: number; col: number } }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.label !== 'string' || e.label.length === 0) continue
    const loc = e.loc as Record<string, unknown> | undefined
    if (!loc || typeof loc !== 'object') continue
    if (typeof loc.file !== 'string' || loc.file.length === 0) continue
    if (typeof loc.line !== 'number' || typeof loc.col !== 'number') continue
    entries.push({ label: e.label, loc: { file: loc.file, line: loc.line, col: loc.col } })
  }
  return entries.length > 0 ? entries : undefined
}

/** Parse a raw `textOrigin` field — same per-field tolerance as `resolution`. */
function parseTextOrigin(raw: unknown): { rel: string; line: number; col: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.rel !== 'string' || r.rel.length === 0) return undefined
  if (typeof r.line !== 'number' || typeof r.col !== 'number') return undefined
  return { rel: r.rel, line: r.line, col: r.col }
}

/** Parse a raw `assetOrigin` field — same per-field tolerance as `textOrigin` (identical shape, different meaning). */
function parseAssetOrigin(raw: unknown): { rel: string; line: number; col: number } | undefined {
  return parseTextOrigin(raw)
}

/** Parse a raw `codeProps` field, keeping only the string entries. */
function parseCodeProps(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const names = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return names.length > 0 ? names : undefined
}

/**
 * Parse a single PageNode, throwing `Error('<nodePath>.<field>: <message>')` on
 * required-field failures so parsePage/parseSiteDocument can report the exact
 * invalid path.
 *
 * Replicates the Zod `.catch()` fallback behaviour for `withFallback()` fields
 * (props, breakpointOverrides, classIds) so nodes missing these fields are
 * still accepted with sensible defaults rather than rejected.
 *
 * PageNode is a flat node (no recursive nesting). Pages use a flat
 * `nodes: Record<string, PageNode>` map, iterated directly in parsePage.
 */
export function parsePageNode(raw: unknown, nodePath: string): PageNode {
  const r = asPlainObject(raw)
  if (!r) throw new Error(`${nodePath}: not an object`)

  // Shared BaseNode fields (id/moduleId/children/props/breakpointOverrides/
  // classIds/inlineStyles/propBindings) come from the one tolerant base parser.
  const base = parseBaseNodeFields(r, nodePath)

  // Page-only overlay: template data-binding map. Silently dropped if invalid.
  const dynamicBindings = parseDynamicBindings(r.dynamicBindings)
  const resolution = parseResolution(r.resolution)
  const branchAlternatives = parseBranchAlternatives(r.branchAlternatives)
  // Studio provenance. Carried through the tolerant parser for the same reason
  // as `resolution`: dropping it silently would turn an editable resolved text
  // back into a dead field, and turn a code-valued prop back into one the editor
  // believes it may overwrite.
  const textOrigin = parseTextOrigin(r.textOrigin)
  const assetOrigin = parseAssetOrigin(r.assetOrigin)
  const codeProps = parseCodeProps(r.codeProps)

  return {
    ...base,
    ...(dynamicBindings !== undefined ? { dynamicBindings } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(branchAlternatives !== undefined ? { branchAlternatives } : {}),
    ...(textOrigin !== undefined ? { textOrigin } : {}),
    ...(assetOrigin !== undefined ? { assetOrigin } : {}),
    ...(codeProps !== undefined ? { codeProps } : {}),
    ...(typeof r.fromComponent === 'string' && r.fromComponent.length > 0
      ? { fromComponent: r.fromComponent }
      : {}),
  }
}
