/**
 * Studio tool barrel — exports the toolset and the system prompt builder.
 *
 * The chat handler imports `siteTools` (re-exported as `studioTools` from
 * `server/ai/tools`) and `buildSiteSystemPrompt` when assembling the prompt
 * for the Studio agent's one conversation surface.
 *
 * Write tools (everything in `siteWriteTools` except browser-backed reads) are
 * stamped `requiresWrite: true` + `sideEffects: 'write'` so `selectStudioTools`
 * can filter them out for callers without `ai.tools.write` and the tool loop
 * runs them one at a time. Everything else is stamped a gate-free
 * `sideEffects: 'none'` read.
 */

import type { AiTool, SiteToolDefinition } from '../types'
import { siteReadTools } from './readTools'
import { siteWriteTools } from './writeTools'

const READ_ONLY_NAMES_IN_WRITE_FILE = new Set([
  'site_get_node_html',
  'site_read_document',
  'site_open_document',
  'site_list_code_assets',
  'site_read_code_asset',
  'site_inspect_code_runtime',
  'site_render_snapshot',
])

function stampWriteClass(tools: SiteToolDefinition[], fromWriteFile: boolean): AiTool[] {
  return tools.map((t) => {
    // Some browser-backed tools live in writeTools.ts for bridge dispatch but
    // do not change site content — they stay reads.
    const writes = fromWriteFile && !READ_ONLY_NAMES_IN_WRITE_FILE.has(t.name)
    return { ...t, requiresWrite: writes, sideEffects: writes ? 'write' : 'none' }
  })
}

export const siteTools: AiTool[] = [
  ...stampWriteClass(siteReadTools, false),
  ...stampWriteClass(siteWriteTools, true),
]

export { buildSiteSystemPrompt } from './systemPrompt'
export { SiteAgentSnapshotSchema } from './snapshot'
export type { SiteAgentSnapshot } from './snapshot'
