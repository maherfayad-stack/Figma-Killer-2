/**
 * Architecture Gate — splitting `mutates` changed the LOOP, not the GATE (AI-5).
 *
 * `AiTool.mutates` used to be two things at once: the capability gate
 * (`ai.tools.write` required) and the tool loop's read/write boundary
 * (concurrency and duplicate suppression). Those are different questions.
 * `studio_screenshot` must stay write-gated — its live fallback borrows the
 * user's open tab — but it is an OBSERVER, and treating it as a write made the
 * loop answer "look again after the fix" with the stale first capture.
 *
 * The split is `requiresWrite` (the gate, read only by
 * `toolAllowedForCapabilities`) and `sideEffects` (read only by the loop).
 * This gate proves the split moved nothing across the permission boundary:
 *
 *   1. {@link WRITE_GATED_BEFORE_THE_SPLIT} is the exact set of tools that
 *      carried `mutates: true` on 2026-09-23, with the `requiredCapabilities`
 *      each held, dumped from the registry before the change. Every one is
 *      still `requiresWrite` with the same capabilities, and NO other tool
 *      became write-gated or lost its gate.
 *   2. A caller holding every capability except `ai.tools.write` is offered
 *      none of them on any surface, and `executeAiTool` refuses one anyway.
 *   3. Every `sideEffects: 'write'` tool is write-gated — the loop's notion of
 *      a write can never be looser than the permission system's.
 *
 * Adding a new write tool is a deliberate edit to the table below, which is
 * the point: the set of things an `ai.chat`-only caller cannot reach should
 * never change as a side effect of something else.
 *
 * {@link WRITE_GATED_ADDED_SINCE} is that edit, made deliberately, one entry
 * per new tool, with the bundle that added it.
 */
import { describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { CORE_CAPABILITIES, type CoreCapability } from '../../core/capabilities'
import { mcpToolsForCapabilities, mcpToolsForStudioWorkspace } from '../../../server/ai/mcp/registry'
import { siteTools } from '../../../server/ai/tools/site'
import { selectStudioTools } from '../../../server/ai/tools'
import { studioAgentTools, studioHttpAgentTools } from '../../../server/ai/tools/studio'
import { executeAiTool } from '../../../server/ai/drivers/http/execTool'
import type { AiTool } from '../../../server/ai/runtime/types'

/** Every tool that was `mutates: true` before AI-5, and the capabilities it required. Dumped from the registry, not written from memory. */
const WRITE_GATED_BEFORE_THE_SPLIT: Readonly<Record<string, readonly CoreCapability[]>> = {
  mcp_propose_server: ['studio.write'],
  site_add_page: ['site.structure.edit'],
  site_apply_css: ['site.style.edit'],
  site_assign_class: ['site.style.edit'],
  site_clear_page_template: ['site.structure.edit'],
  site_delete_node: ['site.structure.edit'],
  site_delete_page: ['site.structure.edit'],
  site_duplicate_node: ['site.structure.edit'],
  site_duplicate_page: ['site.structure.edit'],
  site_insert_html: ['site.structure.edit'],
  site_move_node: ['site.structure.edit'],
  site_patch_code_asset: ['site.structure.edit'],
  site_publish: ['pages.publish'],
  site_remove_class: ['site.style.edit'],
  site_rename_node: ['site.content.edit', 'site.structure.edit'],
  site_rename_page: ['site.structure.edit'],
  site_replace_node_html: ['site.structure.edit'],
  site_set_color_tokens: ['site.style.edit'],
  site_set_font_tokens: ['site.style.edit'],
  site_set_page_template: ['site.structure.edit'],
  site_set_spacing_scale: ['site.style.edit'],
  site_set_type_scale: ['site.style.edit'],
  site_update_node_props: ['site.content.edit', 'site.structure.edit'],
  site_write_code_asset: ['site.structure.edit'],
  studio_apply_edits: ['studio.write'],
  studio_codemod: ['studio.write'],
  studio_compare: ['studio.write'],
  studio_create_page: ['studio.write'],
  studio_delete_design_reference: ['studio.write'],
  studio_delete_design_variable_set: ['studio.write'],
  studio_duplicate_frame_as_variant: ['studio.write'],
  studio_export_frames: ['studio.write'],
  studio_extract_reference_asset: ['studio.write'],
  studio_fetch_remote_asset: ['studio.write'],
  studio_git_branch: ['studio.git.write'],
  studio_git_commit: ['studio.git.write'],
  studio_git_open_pr: ['studio.git.write'],
  studio_git_push: ['studio.git.write'],
  studio_import_figma_frame: ['studio.write'],
  studio_import_project: ['site.structure.edit'],
  studio_ingest_design_variables: ['studio.write'],
  studio_install_deps: ['studio.write'],
  studio_measure_element: ['studio.write'],
  studio_plan_variants: ['studio.write'],
  studio_register_design_reference: ['studio.write'],
  studio_render_reference: ['studio.run.project'],
  studio_reply_comment: ['studio.write'],
  studio_resolve_comment: ['studio.write'],
  studio_screenshot: ['studio.write'],
  studio_set_frame_axes: ['studio.write'],
  studio_set_frames: ['studio.write'],
  studio_typecheck: ['studio.write'],
  studio_upload_asset: ['studio.write'],
}

/**
 * Write-gated tools added AFTER the split, each a deliberate decision:
 *
 *   - P4-C (AI-2): the API-key path's file authoring. Offered only on the HTTP
 *     drivers' surface (`studioHttpAgentTools`), write-gated exactly like
 *     every other Studio write (`ai.tools.write` + `studio.write`).
 *   - P4-D (AI-17, AI-15): `studio_arrange_frames` writes board geometry
 *     (`.studio/boards.json`, like `studio_set_frames`) and
 *     `studio_set_tokens` rewrites a project stylesheet through the agent
 *     write gate. Both on both agent paths and in the registry, both
 *     `ai.tools.write` + `studio.write`, both `sideEffects: 'write'`.
 *     `studio_component_snippet` (AI-14) is a read and is NOT here.
 *   - P4-E (AI-13): `studio_find_image` searches licensed stock and LANDS the
 *     photos (and their credit line) in the project, through the agent write
 *     gate — `ai.tools.write` + `studio.write`, `sideEffects: 'write'`, on
 *     both agent paths and in the registry. Its siblings `studio_find_icon`,
 *     `studio_list_assets` and `studio_list_fonts` are reads and are NOT here.
 *   - P4-G (AI-21): `studio_lint` runs the project's own ESLint, which loads
 *     the project's config and plugins — project code, the
 *     `studio_render_reference` risk class. Gated the same way:
 *     `ai.tools.write` + `studio.run.project`, and the project's tier checked
 *     in the handler. It changes nothing, so it is an observer to the loop
 *     (`sideEffects: 'none'`).
 */
const WRITE_GATED_ADDED_SINCE: Readonly<Record<string, readonly CoreCapability[]>> = {
  studio_arrange_frames: ['studio.write'],
  studio_edit_file: ['studio.write'],
  studio_edit_files: ['studio.write'],
  studio_find_image: ['studio.write'],
  studio_lint: ['studio.run.project'],
  studio_set_tokens: ['studio.write'],
  studio_write_file: ['studio.write'],
}

const WRITE_GATED: Readonly<Record<string, readonly CoreCapability[]>> = {
  ...WRITE_GATED_BEFORE_THE_SPLIT,
  ...WRITE_GATED_ADDED_SINCE,
}

/** The observers the audit named — write-gated, and never a `'write'` to the loop. */
const WRITE_GATED_OBSERVERS = [
  'studio_screenshot',
  'studio_compare',
  'studio_measure_element',
  'studio_typecheck',
  'studio_lint',
  'studio_export_frames',
  'studio_render_reference',
]

const ALL = [...CORE_CAPABILITIES] as CoreCapability[]
const ALL_BUT_WRITE = ALL.filter((cap) => cap !== 'ai.tools.write')

/** Every tool on every surface, first definition per name — the same union the pre-split dump was taken from. */
function everyTool(): AiTool[] {
  const byName = new Map<string, AiTool>()
  for (const tool of [...mcpToolsForCapabilities(ALL), ...siteTools, ...studioAgentTools, ...studioHttpAgentTools]) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

describe('the write gate is exactly what it was before sideEffects existed', () => {
  it('every previously write-gated tool is still requiresWrite, with the same capabilities', () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]))
    for (const [name, caps] of Object.entries(WRITE_GATED)) {
      const tool = byName.get(name)
      expect(tool, `${name} was write-gated before the split and no longer exists on any surface`).toBeDefined()
      expect(tool!.requiresWrite, `${name} lost its ai.tools.write gate`).toBe(true)
      expect([...(tool!.requiredCapabilities ?? [])].sort(), `${name}'s requiredCapabilities changed`).toEqual([...caps].sort())
    }
  })

  it('no other tool became write-gated, and none silently lost the gate', () => {
    const gated = everyTool().filter((tool) => tool.requiresWrite === true).map((tool) => tool.name).sort()
    expect(gated).toEqual(Object.keys(WRITE_GATED).sort())
  })

  it('a caller with every capability but ai.tools.write is offered none of them, on any surface', () => {
    const offered = [
      ...mcpToolsForCapabilities(ALL_BUT_WRITE),
      ...mcpToolsForStudioWorkspace(ALL_BUT_WRITE),
      ...selectStudioTools(ALL_BUT_WRITE),
      ...selectStudioTools(ALL_BUT_WRITE, { studioProjectOpen: true }),
      ...selectStudioTools(ALL_BUT_WRITE, { studioProjectOpen: true, fileAccess: 'studio-tools' }),
    ].map((tool) => tool.name)
    for (const name of Object.keys(WRITE_GATED)) {
      expect(offered, `${name} was offered to a caller without ai.tools.write`).not.toContain(name)
    }
  })

  it('executeAiTool refuses a write-gated observer for that caller before its handler runs', async () => {
    let ran = false
    const screenshot = everyTool().find((tool) => tool.name === 'studio_screenshot')!
    const probe: AiTool = { ...screenshot, inputSchema: Type.Object({}), handler: async () => { ran = true; return {} } }
    const out = await executeAiTool(probe, {}, { callBrowser: async () => ({ ok: true }) }, new AbortController().signal, {
      db: {} as never,
      userId: 'u1',
      conversationId: 'c1',
      snapshot: {},
      capabilities: ALL_BUT_WRITE,
    })
    expect(out.ok).toBe(false)
    expect(ran).toBe(false)
  })
})

describe('sideEffects is never looser than the gate', () => {
  it('every sideEffects:"write" tool is write-gated', () => {
    const ungatedWrites = everyTool().filter((tool) => tool.sideEffects === 'write' && tool.requiresWrite !== true)
    expect(ungatedWrites.map((tool) => tool.name)).toEqual([])
  })

  it('every tool declares one of the three side-effect classes', () => {
    for (const tool of everyTool()) {
      expect(['none', 'cache', 'write'], `${tool.name} declares sideEffects '${String(tool.sideEffects)}'`).toContain(tool.sideEffects)
    }
  })

  it('the audit\'s write-gated observers stay gated and are not writes to the loop', () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]))
    for (const name of WRITE_GATED_OBSERVERS) {
      const tool = byName.get(name)!
      expect(tool.requiresWrite, `${name} must stay write-gated`).toBe(true)
      expect(tool.sideEffects, `${name} is an observer; the loop must not serialise or dedupe it`).not.toBe('write')
    }
  })
})
