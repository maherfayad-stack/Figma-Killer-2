/**
 * agentRosterFigma — the Figma-specific roster additions: detecting an
 * approved Figma-capable MCP server, the `figma.md` reference file, and the
 * `figma-asset-scout` subagent. Split out of `agentRoster.ts` (already near
 * the 700-line module-size ceiling) as its own cohesive seam, the same
 * extraction pattern `agentRosterManifest.ts`/`agentRosterDocOutline.ts`
 * already established for that file.
 *
 * ## Detecting "Figma-capable"
 *
 * There is no live connection to a project's approved MCP servers at roster-
 * generation time (generation is synchronous, on the critical path before
 * every real chat turn spawns — see `agentRoster.ts`'s own doc comment) —
 * so this cannot ask a server what tools it exposes. What IS available,
 * cheaply: the server's own declared NAME and `summary` (a command line or
 * URL), from the exact same `listProjectMcpServers`/`listRegisteredMcpServers`
 * reads `agentRosterMcpTools.ts` already uses for tool vetting. A server
 * whose name or summary mentions "figma" (case-insensitive) is treated as
 * Figma-capable — a heuristic, not a certainty, but the same order of
 * confidence `designSystemDetect.ts` already uses for "does this folder look
 * like a copied-in design system."
 *
 * ## Tool names — an honest, unverified assumption
 *
 * `figma-asset-scout`'s `mcp__<server>__*` grants below name TWO tools —
 * `get_metadata` and `get_image` — from Figma's own officially documented
 * Dev Mode MCP Server (the most common "a Figma MCP" a user means today).
 * This generator has no way to confirm those are the exact tool names the
 * server a given project actually approved will expose — a different Figma
 * MCP implementation may name its tools differently, and this was never
 * dogfooded against a live connection (see the handoff this shipped with).
 * The subagent's own prompt says so explicitly and tells it to check its own
 * available tools before assuming these are present, rather than silently
 * failing a whole task on a name mismatch. Correcting these two literals
 * once a real server is connected and probed is a roster-content change,
 * not an architecture change — the vetting mechanism itself
 * (`assertKnownAgentTools`) does not care WHICH tool names are picked, only
 * that the server they name is approved.
 */
import { listProjectMcpServers } from '../../ai/drivers/projectMcpServers'
import { listRegisteredMcpServers } from '../../ai/drivers/registeredMcpServers'
import type { StudioAgentDef } from './agentRosterTypes'

export interface FigmaServerMatch {
  readonly name: string
}

function looksFigmaCapable(name: string, summary: string): boolean {
  return /figma/i.test(name) || /figma/i.test(summary)
}

/**
 * The first approved project (`.mcp.json`) or Studio-registered MCP server
 * whose name or summary mentions Figma — `undefined` when none does. Checked
 * fresh on every call (two cheap JSON/config reads, same cost class as the
 * approval lookups `agentRosterMcpTools.ts` already pays) rather than cached,
 * so approving a Figma server in Settings takes effect on the very next
 * roster regeneration once `mcpServerFingerprintWitness` (folded into
 * `computeRosterFingerprint`) invalidates the fast path.
 */
export function findApprovedFigmaServer(dir: string): FigmaServerMatch | undefined {
  const candidates = [
    ...listProjectMcpServers(dir).filter((s) => s.approved),
    ...listRegisteredMcpServers(dir).filter((s) => s.approved),
  ]
  const match = candidates.find((s) => looksFigmaCapable(s.name, s.summary))
  return match ? { name: match.name } : undefined
}

/**
 * `.claude/figma.md` — generated only when {@link findApprovedFigmaServer}
 * finds one, the same conditional pattern `design-system.md` already uses
 * for a project with no design system at all. Teaches the REAL workflow
 * (mcp-09's own findings), not generic "here's how MCP works" prose:
 *
 *   1. Resolve the fileKey/nodeId PER COMPONENT via
 *      studio_list_component_bindings — never assume one Figma file for a
 *      whole project. Confirmed against this repo's own ALM design system:
 *      27 components map into one Figma file, but Checkbox/Radio map into a
 *      SEPARATE file. A hardcoded single key silently targets the wrong file
 *      for whichever components don't happen to live in it.
 *   2. Check `nodeIdPlaceholder` before fetching anything — 5 of 29 real
 *      bindings in that same corpus are unfilled `figma connect create`
 *      scaffolds (`node-id=REPLACE-ME`), not resolvable references. Fetching
 *      one is a guaranteed-failing request, not a degraded-but-useful one.
 *   3. Code Connect is the CHEAP path when it exists: a component that
 *      already has one carries its own Figma node URL — no need to search
 *      Figma by hand for something already in the codebase.
 *   4. Land the export through `studio_fetch_remote_asset`, not
 *      `studio_upload_asset` — the point of the whole feature: the bytes
 *      never transit the calling model.
 */
export function figmaReference(serverName: string): string {
  return [
    '# Figma asset workflow',
    '',
    `An approved Figma-capable MCP server ("${serverName}") is connected for this project. This is the real workflow for pulling a component's assets (icons, exports, reference images) from Figma into the repo — not generic MCP advice.`,
    '',
    '## 1. Resolve the Figma file key and node PER COMPONENT — never assume one',
    '',
    'Call studio_list_component_bindings (filter by component name when you know it) before touching Figma at all. It returns, per component, { figmaUrl, figmaFileKey, figmaNodeId, nodeIdPlaceholder }, parsed straight from this project\'s own Figma Code Connect files when it has any. A design system can live across MULTIPLE Figma files — verified in this codebase\'s own ALM design system, where most components map into one file but two (Checkbox, Radio) map into a completely separate one. Read figmaFileKey from the response every time; never hardcode or reuse a key you saw for a different component. The response\'s own fileKeys field tells you in one call whether this project uses one Figma file or several.',
    '',
    '## 2. Check nodeIdPlaceholder BEFORE fetching anything',
    '',
    'nodeIdPlaceholder:true means the URL still carries an unfilled `figma connect create` template (`node-id=REPLACE-ME`) — it is NOT a resolvable Figma reference. Fetching it is a guaranteed-failing request, not a degraded one. Report plainly that this component\'s Code Connect binding was never finished (a human needs to fill it in Figma) rather than guessing at a node id or silently skipping the component.',
    '',
    '## 3. Code Connect is the cheap path — prefer it over searching Figma by hand',
    '',
    'When a component already has a real (non-placeholder) binding, its figmaUrl IS the exact node to open — decode it (figmaFileKey + figmaNodeId) and go straight there with your Figma MCP server\'s own tools. Only fall back to searching/browsing Figma from scratch for something with no Code Connect binding at all.',
    '',
    '## 4. Get the node, export at the right scale',
    '',
    'Use the connected Figma MCP server\'s own tools to read the node and produce an export URL or image bytes — the exact tool names depend on which Figma MCP server this project approved. Check your own available tool list before calling one; do not assume a name exists just because it is common. If your server returns an export URL, prefer that over inline bytes — it feeds step 5 directly. Ask for a scale/format appropriate to the asset (SVG for an icon that should stay crisp at any size; a raster format at 2x/3x for a photographic image).',
    '',
    '## 5. Land it WITHOUT routing bytes through yourself',
    '',
    'Call studio_fetch_remote_asset({ url }) with the export URL — the fetch and the write both happen server-side; the bytes never pass through you. Only reach for studio_upload_asset (which needs the bytes as a base64 argument YOU hold) when a tool genuinely handed you raw bytes with no URL at all — that path is far more expensive for anything but a tiny icon, since every byte becomes tokens in your own context.',
    '',
    '## 6. Report the landed path — do not wire it into JSX yourself',
    '',
    'studio_fetch_remote_asset returns { relPath }. Report it back plainly (which component, which file). Composing it into a screen (writing the import, the <img>/component prop) is the composing agent\'s job (e.g. screen-builder), not this one\'s — locate, pull, and land is the whole remit here.',
  ].join('\n')
}

/**
 * `figma-asset-scout` — locates a Figma node for a component, pulls its
 * asset, and lands it in the repo. Deliberately narrow: it does NOT hold
 * studio_apply_edits or any structural tool — wiring a landed asset into JSX
 * is a composing agent's job, not this one's. See the module doc for why the
 * two `mcp__<server>__*` grants below are a best-effort, unverified
 * assumption about which tool names the approved server actually exposes.
 */
export function figmaAssetScoutAgent(
  serverName: string,
  assertKnown: (def: StudioAgentDef) => StudioAgentDef,
): StudioAgentDef {
  return assertKnown({
    name: 'figma-asset-scout',
    description: 'Locates a Figma node for a component (via this project\'s own Code Connect bindings when it has any), pulls its export, and lands it in the repo — never composes it into a screen itself.',
    tools: [
      'studio_read_file',
      'studio_list_component_bindings',
      'studio_find_component',
      'studio_fetch_remote_asset',
      `mcp__${serverName}__get_metadata`,
      `mcp__${serverName}__get_image`,
    ],
    prompt: [
      'You are figma-asset-scout, Studio\'s Figma-asset agent. Your job is exactly three steps: locate a node, pull its asset, land it in the repo. You do not compose anything into a screen — hand the landed relPath back and stop.',
      '',
      `Read .claude/figma.md (via studio_read_file) once per session before your first tool call — the full workflow. Short version: studio_list_component_bindings to resolve the RIGHT Figma file/node for the specific component (never assume one file for the whole project — this project's own design system uses two), check nodeIdPlaceholder before doing anything else (an unfilled REPLACE-ME binding is not fetchable), then use mcp__${serverName}__get_metadata / mcp__${serverName}__get_image — your connected Figma MCP server's tools — to read the node and produce an export.`,
      '',
      `If either mcp__${serverName} tool is not actually in your available tool list, say so plainly rather than guessing at a substitute name — the exact tools this server exposes were assumed, not verified, when this roster was generated.`,
      '',
      'Land the export with studio_fetch_remote_asset({ url }) — pass the URL your Figma tool returned, never bytes you decoded yourself. This is the whole point of this agent existing: an asset\'s bytes are fetched and written server-side, never carried through your own context as base64.',
      '',
      'Report { relPath } plainly and stop. Wiring the asset into JSX (an import, an <img> or component prop) is a composing agent\'s job — you locate, pull, and land; you do not build the screen.',
    ].join('\n'),
  })
}
