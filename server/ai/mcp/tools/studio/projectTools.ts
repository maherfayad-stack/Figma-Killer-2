/**
 * Studio MCP tools — 9.1 project + board orientation (headless).
 *
 * Every tool here reads straight off disk (or the in-memory install-job map)
 * and needs no open editor: a fresh MCP session can call these before anyone
 * has opened the Studio UI at all. They exist so an agent can orient itself
 * ("what projects exist, what did the probe find, what's on this page, where
 * does this node come from in source") before reaching for a mutating tool.
 *
 * `studio_find_nodes` is the bridge from "the board looks wrong" to "here is
 * the exact file:line to fix"; the file tools themselves (read, list, grep,
 * `studio_get_node_source`) live in `./fileReadTools.ts`, behind the one
 * containment rule every agent file access shares.
 *
 * Capability posture: every tool here is a READ except `studio_install_deps`
 * and `studio_create_page` (write a job / write a file), which declare
 * `requiresWrite: true` + `requiredCapabilities: ['studio.write']`. The reads have
 * no `requiredCapabilities`, which `toolAllowedForCapabilities` treats as
 * "any ai.chat caller" — same posture `get_context`/`site_list_documents`
 * use for read-only orientation tools.
 *
 * `studio_create_page` (WS-12 §3) wraps `POST /admin/api/studio/page`
 * (`../../../../handlers/studio/pageScaffold.ts`) for an external client.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import { stripSvgPartStamps } from '@core/vector'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  listStudioProjects,
  projectDisplayName,
  projectsRootDir,
} from '../../../../handlers/studioProjects'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { DEFAULT_TRUST_TIER, readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { startInstallJob, getInstallJob, probeInstallStatus } from '../../../../handlers/studio/installDeps'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { scaffoldPageLocked } from '../../../../handlers/studio/pageScaffold'
import { DEFAULT_PAGE_KIND, PageKindSchema, type PageKind } from '@core/studio-board'
import { pushStudioLiveReload } from './liveReloadPush'

const DirInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
  },
  { additionalProperties: false },
)

// ---------------------------------------------------------------------------
// studio_list_projects
// ---------------------------------------------------------------------------

const listProjectsTool: AiTool = {
  name: 'studio_list_projects',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'List every studio project (an immediate subfolder of studio-workspace/, hand-authored or GitHub-imported). Each entry includes its display name, page count, and — when the project has already been probed — a summary of its framework/style-toolchain profile. Call this first when you do not already know which project dir to target.',
  inputSchema: Type.Object({}, { additionalProperties: false }),
  handler: async () => {
    const projects = listStudioProjects(projectsRootDir())
    return {
      projects: projects.map((p) => {
        const meta = readStudioMeta(p.dir)
        // `resolveProjectProfile` rather than the raw cache: a profile probed
        // before `node_modules` existed reports `componentPackages: []`
        // forever, and this listing is exactly where an agent decides whether
        // a project has a design system worth reading.
        const profile = resolveProjectProfile(p.dir)
        return {
          dir: p.dir,
          name: p.name,
          pageCount: p.pageCount,
          trust: meta.trust ?? DEFAULT_TRUST_TIER,
          profile: {
            framework: profile.framework,
            packageManager: profile.packageManager,
            componentPackages: profile.componentPackages,
            tailwind: profile.styleToolchain.tailwind !== null,
            warningCount: profile.warnings.length,
          },
        }
      }),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_project_profile
// ---------------------------------------------------------------------------

const projectProfileTool: AiTool = {
  name: 'studio_project_profile',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Return the full ProjectProfile for a studio project: detected framework, route style, pages directory, style toolchain (Tailwind/Sass/CSS Modules/CSS-in-JS), component packages, design systems, path aliases, the dark-mode and locale capabilities, and the probe\'s own warnings (each a { code, message, fix } — the same codes studio_fidelity_report surfaces). profile.colorScheme is how this project expresses dark mode: mechanism (class/media/none), the exact selector to gate a dark rule on, and the source file it was found in — which is often the installed design system\'s own stylesheet, not a file in the project. Uses the cached probe from .studio/meta.json when present, else probes fresh (never writes the cache itself, except to heal a cache an older probe version got wrong). Call this before touching a project you have not seen before — "what am I working with" in one call.',
  inputSchema: DirInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const meta = readStudioMeta(dir)
    const profile = resolveProjectProfile(dir)
    return { dir, name: projectDisplayName(dir), trust: meta.trust ?? DEFAULT_TRUST_TIER, profile }
  },
}

// ---------------------------------------------------------------------------
// studio_install_deps / studio_install_status
// ---------------------------------------------------------------------------

const installDepsTool: AiTool = {
  name: 'studio_install_deps',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Start a "bun install --ignore-scripts" (or the detected package manager) job for a project as a background job — returns a jobId immediately, never blocks on the install itself (30s-3min). Poll status with studio_install_status. Refuses outright at Tier 0 (static) trust — the agent may ASK the user to promote the project first, never promote it itself. Postinstall scripts never run even once promoted (arbitrary code execution is refused separately); packages that need one are reported as a warning in the job log instead. Requires studio.write.',
  inputSchema: DirInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    // WS-12 §2.3 — Tier 0 = read + AST edits only. Installing dependencies
    // is a real toolchain action; it must refuse here, at the tool's own
    // authorization boundary, not rely on a caller-supplied mode (this
    // check has no notion of "bypass" at all — there is nothing for a
    // permission mode to widen).
    const trust = readStudioMeta(dir).trust ?? DEFAULT_TRUST_TIER
    if (trust === 'static') {
      return toolRefusal(
        'trust-tier-required',
        'This project is at Tier 0 (static) trust, which runs nothing.',
        { remedy: 'Ask the user to promote the project before installing dependencies — you may not promote it yourself, so this same call will keep refusing until they do.' },
      )
    }
    const status = probeInstallStatus(dir)
    if (!status.hasPackageJson) {
      return toolRefusal('no-package-json', `No package.json found at ${dir}.`, {
        remedy: 'There is nothing to install. Confirm this is the project you meant.',
      })
    }
    if (status.hasNodeModules) {
      return { ok: true, jobId: null, alreadyInstalled: true, dependencyCount: status.dependencyCount }
    }
    const jobId = startInstallJob(dir)
    return { ok: true, jobId, dependencyCount: status.dependencyCount, packageManager: status.packageManager }
  },
}

const InstallStatusInputSchema = Type.Object(
  { jobId: Type.String({ description: 'A jobId returned by studio_install_deps.' }) },
  { additionalProperties: false },
)

const installStatusTool: AiTool = {
  name: 'studio_install_status',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description: 'Poll a studio_install_deps job by jobId: { status: running|done|failed|timeout, log, exitCode }.',
  inputSchema: InstallStatusInputSchema,
  handler: async (input) => {
    const { jobId } = input as { jobId: string }
    const job = getInstallJob(jobId)
    if (!job) return toolRefusal('no-such-job', `No install job found for id ${jobId}.`, {
      remedy: 'It expired, or the id is wrong. Start a new one with studio_install_deps.',
    })
    return { ok: true, job }
  },
}

// ---------------------------------------------------------------------------
// studio_list_pages
// ---------------------------------------------------------------------------

const listPagesTool: AiTool = {
  name: 'studio_list_pages',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'List every page (board frame) discovered in a project: id, title, slug/route, and node count. Parses the whole project once (same pipeline the Studio UI uses to load the board) — for a large project prefer this over re-parsing yourself. Use the returned pageId with studio_fidelity_report, studio_set_frames, and any other tool that takes a pageId.',
  inputSchema: DirInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { pages } = await loadStudioPages(dir)
    return {
      dir,
      pages: pages.map((page) => ({
        pageId: page.id,
        title: page.title,
        slug: page.slug,
        nodeCount: Object.keys(page.nodes).length,
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_find_nodes
// ---------------------------------------------------------------------------

const DEFAULT_FIND_LIMIT = 100

const FindNodesInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pageId: Type.Optional(Type.String({ description: 'Restrict the search to one page id (from studio_list_pages).' })),
    moduleId: Type.Optional(
      Type.String({ description: 'Substring match against the node\'s moduleId, e.g. "base.image" or "pkg.".' }),
    ),
    tag: Type.Optional(
      Type.String({ description: 'Exact match against props.tag (the rendered HTML tag), when the node overrides its module default.' }),
    ),
    className: Type.Optional(Type.String({ description: 'Substring match against any class name applied to the node.' })),
    text: Type.Optional(
      Type.String({ description: 'Substring match against the node\'s serialized props (covers text content, src, alt, etc.).' }),
    ),
    lockedOnly: Type.Optional(
      Type.Boolean({ description: 'Only nodes with a lockReason (a source/dynamic lock) — "show me everything that failed to resolve".' }),
    ),
    codeValuedOnly: Type.Optional(
      Type.Boolean({ description: 'Only nodes with at least one codeProps entry (a per-prop value with no writable target).' }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: 'Cap on returned matches. Default 100.' })),
  },
  { additionalProperties: false },
)

const findNodesTool: AiTool = {
  name: 'studio_find_nodes',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Query nodes across a project\'s pages by moduleId, tag, class name, text, lock state, or codeProps presence. The agent\'s "show me everything that failed to resolve" — pass lockedOnly:true to find every dynamic/unresolved node, or codeValuedOnly:true to find every per-prop value with nowhere writable to land. Results are capped (default 100) and always include enough to call studio_get_node_source next. Each match carries sourceFingerprint when the node has one: pass it back in the expect map of studio_apply_edits ({ [nodeId]: sourceFingerprint }) so an edit made after the file changed refuses element-moved instead of writing to whatever now sits at that line.',
  inputSchema: FindNodesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const {
      dir: dirInput,
      pageId,
      moduleId,
      tag,
      className,
      text,
      lockedOnly,
      codeValuedOnly,
      limit,
    } = input as {
      dir?: string
      pageId?: string
      moduleId?: string
      tag?: string
      className?: string
      text?: string
      lockedOnly?: boolean
      codeValuedOnly?: boolean
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { pages, styleRules } = await loadStudioPages(dir)
    const cap = limit ?? DEFAULT_FIND_LIMIT

    const matches: Array<{
      pageId: string
      nodeId: string
      moduleId: string
      tag?: string
      classNames: string[]
      lockReason?: string
      codeProps?: string[]
      sourceFingerprint?: string
    }> = []

    outer: for (const page of pages) {
      if (pageId && page.id !== pageId) continue
      for (const [nodeId, node] of Object.entries(page.nodes)) {
        if (matches.length >= cap) break outer
        if (moduleId && !node.moduleId.includes(moduleId)) continue
        const nodeTag = typeof node.props?.tag === 'string' ? (node.props.tag as string) : undefined
        if (tag && nodeTag !== tag) continue
        const classNames = (node.classIds ?? []).map((id) => styleRules[id]?.name ?? id)
        if (className && !classNames.some((name) => name.includes(className))) continue
        if (text) {
          // SVG-3 — an agent searching text must not match Studio's own part stamps.
          const haystack = stripSvgPartStamps(JSON.stringify(node.props ?? {}))
          if (!haystack.toLowerCase().includes(text.toLowerCase())) continue
        }
        if (lockedOnly && !node.lockReason) continue
        if (codeValuedOnly && !(node.codeProps && node.codeProps.length > 0)) continue

        matches.push({
          pageId: page.id,
          nodeId,
          moduleId: node.moduleId,
          ...(nodeTag ? { tag: nodeTag } : {}),
          classNames,
          ...(node.lockReason ? { lockReason: node.lockReason } : {}),
          ...(node.codeProps && node.codeProps.length > 0 ? { codeProps: node.codeProps } : {}),
          // P1-A — hand it back in the `expect` of `studio_apply_edits` to have a stale id refuse instead of writing a neighbour.
          ...(node.sourceFingerprint ? { sourceFingerprint: node.sourceFingerprint } : {}),
        })
      }
    }

    return { dir, matchCount: matches.length, truncated: matches.length >= cap, matches }
  },
}

// ---------------------------------------------------------------------------
// studio_create_page (WS-12 §3) — wraps POST /admin/api/studio/page
// ---------------------------------------------------------------------------

const CreatePageInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          'Component/file name, turned into a PascalCase identifier (e.g. "order summary" -> OrderSummary.tsx). Omit to auto-name from the kind: Page/Page2 for a screen, Popup, Sheet/Sheet2 for a sheet. Collisions with an existing name return a conflict rather than overwriting it.',
      }),
    ),
    kind: Type.Optional(
      Type.Union(PageKindSchema.anyOf, {
        description:
          'What SHAPE of page to scaffold. "screen" (the default) is a full page. "popup" is a centred dialog over a dimmed screen. "sheet-small" and "sheet-large" are bottom sheets — a panel on the bottom edge with the screen showing above it, short and tall respectively. Every kind writes a screen-sized board frame: an overlay is drawn over the screen presenting it, so the scrim above the panel IS part of the design.',
      }),
    ),
  },
  { additionalProperties: false },
)

const createPageTool: AiTool = {
  name: 'studio_create_page',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Scaffold a new page/screen/popup/bottom sheet (see `kind`): writes a canonical-by-construction .tsx (or .jsx, matching the project\'s own convention) file, auto-places its board frame at the next free grid slot so it is immediately visible, and returns { relPath, pageId, title, rootNodeId }. This is the ONLY way to create a screen — there is no other tool and no raw-file-write path. rootNodeId is read back by actually parsing the file just written (never invented) — pass it to studio_apply_edits\' insert edits as the container to compose structure into. Returns { ok:false, conflict } instead of overwriting when the name is already taken. If the caller has the project open in a browser tab, its canvas is nudged to pick up the new page and its board frame (best-effort — nothing to do if no browser is open). Requires studio.write.',
  inputSchema: CreatePageInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, name, kind } = input as { dir?: string; name?: string; kind?: PageKind }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = await scaffoldPageLocked(dir, name ?? '', kind ?? DEFAULT_PAGE_KIND)
    if (!result.ok) {
      return toolRefusal('write-conflict', result.conflict, {
        remedy: 'Pick a different name, or edit the existing file instead — this tool never overwrites.',
      })
    }
    // A scaffolded page always writes BOTH a new page file AND a new board
    // frame (`autoPlaceBoardFrame`, `pageScaffold.ts`'s own doc) — never one
    // without the other — so the live-reload push always carries both.
    pushStudioLiveReload(ctx.userId, { dir, pageIds: [result.pageId], boardsChanged: true })
    return {
      ok: true,
      dir,
      relPath: result.relPath,
      pageId: result.pageId,
      title: result.title,
      rootNodeId: result.rootNodeId ?? null,
    }
  },
}

export const studioProjectMcpTools: AiTool[] = [
  listProjectsTool,
  projectProfileTool,
  installDepsTool,
  installStatusTool,
  listPagesTool,
  findNodesTool,
  createPageTool,
]
