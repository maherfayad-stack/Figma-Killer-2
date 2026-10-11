/**
 * Tool registry types — small helpers on top of the canonical `AiTool` type
 * from `runtime/types.ts`. Defined here so tool modules can import a single
 * concise type without reaching into the runtime layer.
 */

import type { AiTool } from '../runtime/types'

export type { AiTool }

/**
 * A CMS `site_*` tool as its module declares it: everything but the write
 * gate and the loop's side-effect class. The site toolset is classified by
 * the FILE a definition lives in (`site/readTools.ts` vs `site/writeTools.ts`,
 * minus the browser-backed reads that live in the latter for dispatch
 * reasons), so `site/index.ts` stamps `requiresWrite` and `sideEffects`
 * together, in one place, from that one decision.
 */
export type SiteToolDefinition = Omit<AiTool, 'requiresWrite' | 'sideEffects'>
