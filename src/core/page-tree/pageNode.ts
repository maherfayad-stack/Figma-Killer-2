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
   * copies it straight across, same pattern as `locked`/`lockReason`. A node
   * carrying `resolution` is always `locked` (writing an edit back over the
   * original expression would silently destroy it).
   */
  resolution: Type.Optional(Type.Object({ source: Type.String(), note: Type.Optional(Type.String()) })),
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

  return {
    ...base,
    ...(dynamicBindings !== undefined ? { dynamicBindings } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(typeof r.fromComponent === 'string' && r.fromComponent.length > 0
      ? { fromComponent: r.fromComponent }
      : {}),
  }
}
