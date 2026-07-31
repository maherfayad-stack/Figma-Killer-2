/**
 * Studio MCP tools — 9.1 project + board orientation (headless).
 *
 * Every tool here reads straight off disk (or the in-memory install-job map)
 * and needs no open editor: a fresh MCP session can call these before anyone
 * has opened the Studio UI at all. They exist so an agent can orient itself
 * ("what projects exist, what did the probe find, what's on this page, where
 * does this node come from in source") before reaching for a mutating tool.
 *
 * `studio_get_node_source` and `studio_find_nodes` are the bridge from "the
 * board looks wrong" to "here is the exact file:line to fix" — the whole
 * point of exposing the node-id grammar (`@core/page-tree/sourceNodeId`) to
 * an external agent instead of making it re-derive locations by hand.
 *
 * Capability posture: every tool here is a READ except `studio_install_deps`
 * (spawns a real subprocess, downloads packages) — that one alone declares
 * `mutates: true` + `requiredCapabilities: ['studio.write']`. The reads have
 * no `requiredCapabilities`, which `toolAllowedForCapabilities` treats as
 * "any ai.chat caller" — same posture `get_context`/`site_list_documents`
 * use for read-only orientation tools.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { decodeSourceNodeId } from '@core/page-tree'
import type { AiTool } from '../../../runtime/types'
import {
  listStudioProjects,
  projectDisplayName,
  projectsRootDir,
  resolveProjectDir,
} from '../../../../handlers/studioProjects'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { probeProject } from '../../../../handlers/studio/projectProbe'
import { startInstallJob, getInstallJob, probeInstallStatus } from '../../../../handlers/studio/installDeps'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'

const DirInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
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
  description:
    'List every studio project (an immediate subfolder of studio-workspace/, hand-authored or GitHub-imported). Each entry includes its display name, page count, and — when the project has already been probed — a summary of its framework/style-toolchain profile. Call this first when you do not already know which project dir to target.',
  inputSchema: Type.Object({}, { additionalProperties: false }),
  handler: async () => {
    const projects = listStudioProjects(projectsRootDir())
    return {
      projects: projects.map((p) => {
        const meta = readStudioMeta(p.dir)
        return {
          dir: p.dir,
          name: p.name,
          pageCount: p.pageCount,
          trust: meta.trust ?? 'static',
          profile: meta.profile
            ? {
                framework: meta.profile.framework,
                packageManager: meta.profile.packageManager,
                componentPackages: meta.profile.componentPackages,
                tailwind: meta.profile.styleToolchain.tailwind !== null,
                warningCount: meta.profile.warnings.length,
              }
            : null,
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
  description:
    'Return the full ProjectProfile for a studio project: detected framework, route style, pages directory, style toolchain (Tailwind/Sass/CSS Modules/CSS-in-JS), component packages, path aliases, and the probe\'s own warnings (each a { code, message, fix } — the same codes studio_fidelity_report surfaces). Uses the cached probe from .studio/meta.json when present, else probes fresh (never writes the cache itself). Call this before touching a project you have not seen before — "what am I working with" in one call.',
  inputSchema: DirInputSchema,
  handler: async (input) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveProjectDir(dirInput)
    const meta = readStudioMeta(dir)
    const profile = meta.profile ?? probeProject(dir)
    return { dir, name: projectDisplayName(dir), trust: meta.trust ?? 'static', profile }
  },
}

// ---------------------------------------------------------------------------
// studio_install_deps / studio_install_status
// ---------------------------------------------------------------------------

const installDepsTool: AiTool = {
  name: 'studio_install_deps',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Start a "bun install --ignore-scripts" (or the detected package manager) job for a project as a background job — returns a jobId immediately, never blocks on the install itself (30s-3min). Poll status with studio_install_status. Postinstall scripts never run (arbitrary code execution is refused until the project is explicitly promoted past Tier 0); packages that need one are reported as a warning in the job log instead. Requires studio.write.',
  inputSchema: DirInputSchema,
  handler: async (input) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveProjectDir(dirInput)
    const status = probeInstallStatus(dir)
    if (!status.hasPackageJson) {
      return { ok: false, error: `No package.json found at ${dir}.` }
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
  description: 'Poll a studio_install_deps job by jobId: { status: running|done|failed|timeout, log, exitCode }.',
  inputSchema: InstallStatusInputSchema,
  handler: async (input) => {
    const { jobId } = input as { jobId: string }
    const job = getInstallJob(jobId)
    if (!job) return { ok: false, error: `No install job found for id ${jobId}.` }
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
  description:
    'List every page (board frame) discovered in a project: id, title, slug/route, and node count. Parses the whole project once (same pipeline the Studio UI uses to load the board) — for a large project prefer this over re-parsing yourself. Use the returned pageId with studio_find_nodes / studio_fidelity_report / studio_set_frames.',
  inputSchema: DirInputSchema,
  handler: async (input) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveProjectDir(dirInput)
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
// studio_get_node_source
// ---------------------------------------------------------------------------

const GetNodeSourceInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
    ),
    nodeId: Type.String({
      description:
        'A studio node id, e.g. "src/screens/Home.tsx:65:16" or an inlined composite id "pages/Home.jsx:77:19~components/Icon.jsx:3:6".',
    }),
    contextLines: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 20, description: 'Lines of source context around the target line. Default 2.' }),
    ),
  },
  { additionalProperties: false },
)

const getNodeSourceTool: AiTool = {
  name: 'studio_get_node_source',
  scope: 'shared',
  execution: 'server',
  description:
    'Decode a studio node id to its exact source location: { file, line, col, snippet }. This is the bridge from "the hero section is wrong" to "here is the code" — every visual finding should be paired with this. Returns ok:false with a reason for a synthetic node (no source location) or a `.map`-iteration node id (one piece of source produces N nodes; there is no single line for row 2).',
  inputSchema: GetNodeSourceInputSchema,
  handler: async (input) => {
    const { dir: dirInput, nodeId, contextLines } = input as { dir?: string; nodeId: string; contextLines?: number }
    const dir = resolveProjectDir(dirInput)
    const loc = decodeSourceNodeId(nodeId)
    if (!loc) {
      return {
        ok: false,
        error: `Node "${nodeId}" has no single writable source location — it is either synthetic (e.g. the page root) or a \`.map\` iteration (one piece of source renders N nodes, so there is no line that names just this one).`,
      }
    }
    const absFile = join(dir, ...loc.rel.split('/'))
    let snippet: string | null
    try {
      const lines = readFileSync(absFile, 'utf8').split('\n')
      const pad = contextLines ?? 2
      const start = Math.max(0, loc.line - 1 - pad)
      const end = Math.min(lines.length, loc.line + pad)
      snippet = lines.slice(start, end).join('\n')
    } catch {
      snippet = null // file unreadable — still return the decoded location
    }
    return { ok: true, file: absFile, relFile: loc.rel, line: loc.line, col: loc.col, snippet }
  },
}

// ---------------------------------------------------------------------------
// studio_find_nodes
// ---------------------------------------------------------------------------

const DEFAULT_FIND_LIMIT = 100

const FindNodesInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
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
  description:
    'Query nodes across a project\'s pages by moduleId, tag, class name, text, lock state, or codeProps presence. The agent\'s "show me everything that failed to resolve" — pass lockedOnly:true to find every dynamic/unresolved node, or codeValuedOnly:true to find every per-prop value with nowhere writable to land. Results are capped (default 100) and always include enough to call studio_get_node_source next.',
  inputSchema: FindNodesInputSchema,
  handler: async (input) => {
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
    const dir = resolveProjectDir(dirInput)
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
          const haystack = JSON.stringify(node.props ?? {})
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
        })
      }
    }

    return { dir, matchCount: matches.length, truncated: matches.length >= cap, matches }
  },
}

export const studioProjectMcpTools: AiTool[] = [
  listProjectsTool,
  projectProfileTool,
  installDepsTool,
  installStatusTool,
  listPagesTool,
  getNodeSourceTool,
  findNodesTool,
]
