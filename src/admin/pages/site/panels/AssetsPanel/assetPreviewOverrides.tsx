/**
 * assetPreviewOverrides — the escape hatch for a module whose `component`
 * cannot render standalone.
 *
 * A module's editor component is written for the canvas: most take nothing but
 * props, but a few read a node out of the store, or expect to be inside a
 * frame's portal. Those cannot be rendered in a 100px card as-is.
 *
 * This is a table **here**, not a `preview` field on `ModuleDefinition`,
 * because it is a fact about a PANEL, not about a module: the publisher, the
 * canvas and the MCP tools have no use for it, and a module in
 * `src/modules/**` should not have to know the Assets panel exists.
 *
 * Empty today — every palette-visible module renders from its own `component`
 * with its own `defaults`. Add an entry only when a card is measurably broken
 * without one, and say in a comment what the component needs that a card
 * cannot give it.
 */
import type { ReactElement } from 'react'

export const ASSET_PREVIEW_OVERRIDES: Record<string, () => ReactElement> = {}
