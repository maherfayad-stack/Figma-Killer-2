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
 * and `studio_create_page` (write a job / write a file), which declare
 * `mutates: true` + `requiredCapabilities: ['studio.write']`. The reads have
 * no `requiredCapabilities`, which `toolAllowedForCapabilities` treats as
 * "any ai.chat caller" — same posture `get_context`/`site_list_documents`
 * use for read-only orientation tools.
 *
 * `studio_create_page` and `studio_read_file` (WS-12 §3) close the two gaps
 * that made "the agent can create a screen" impossible: without the first
 * there was no tool wrapping `POST /admin/api/studio/page`
 * (`../../../../handlers/studio/pageScaffold.ts`) at all — screen creation
 * simply wasn't reachable — and without the second, composing a new screen
 * had no way to read a SIBLING screen or a component's own source to match
 * the project's conventions (`studio_get_node_source` reads one already-known
 * node's few lines of context; this reads a whole file by path).
 */
import { join, sep } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { Type } from '@core/utils/typeboxHelpers'
import { decodeSourceNodeId } from '@core/page-tree'
import { EXCLUDED_WORKSPACE_DIR_NAMES, listWorkspaceFiles } from '@core/page-parser'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  listStudioProjects,
  projectDisplayName,
  projectsRootDir,
} from '../../../../handlers/studioProjects'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { startInstallJob, getInstallJob, probeInstallStatus } from '../../../../handlers/studio/installDeps'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { createScaffoldedPage } from '../../../../handlers/studio/pageScaffold'
import { DEFAULT_PAGE_KIND, PageKindSchema, type PageKind } from '@core/studio-board'
import { readTextCapped } from '../../../../handlers/studio/cappedFileRead'
import { canonicalSummaryForFile } from '../../../../handlers/studio/canonicalPageCheck'
import { isRealpathContainedAllowingMissing } from '../../../../handlers/studio/workspacePackageResolve'
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
          trust: meta.trust ?? 'static',
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
  description:
    'Return the full ProjectProfile for a studio project: detected framework, route style, pages directory, style toolchain (Tailwind/Sass/CSS Modules/CSS-in-JS), component packages, design systems, path aliases, the dark-mode and locale capabilities, and the probe\'s own warnings (each a { code, message, fix } — the same codes studio_fidelity_report surfaces). profile.colorScheme is how this project expresses dark mode: mechanism (class/media/none), the exact selector to gate a dark rule on, and the source file it was found in — which is often the installed design system\'s own stylesheet, not a file in the project. Uses the cached probe from .studio/meta.json when present, else probes fresh (never writes the cache itself, except to heal a cache an older probe version got wrong). Call this before touching a project you have not seen before — "what am I working with" in one call.',
  inputSchema: DirInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const meta = readStudioMeta(dir)
    const profile = resolveProjectProfile(dir)
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
    const trust = readStudioMeta(dir).trust ?? 'static'
    if (trust === 'static') {
      return {
        ok: false,
        code: 'trust-tier-required',
        error: 'This project is at Tier 0 (static) trust, which runs nothing. Ask the user to promote the project before installing dependencies — you may not promote it yourself.',
      }
    }
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
// studio_get_node_source
// ---------------------------------------------------------------------------

const GetNodeSourceInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
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
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, nodeId, contextLines } = input as { dir?: string; nodeId: string; contextLines?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)
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
  description:
    'Query nodes across a project\'s pages by moduleId, tag, class name, text, lock state, or codeProps presence. The agent\'s "show me everything that failed to resolve" — pass lockedOnly:true to find every dynamic/unresolved node, or codeValuedOnly:true to find every per-prop value with nowhere writable to land. Results are capped (default 100) and always include enough to call studio_get_node_source next.',
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
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Scaffold a new page/screen/popup/bottom sheet (see `kind`): writes a canonical-by-construction .tsx (or .jsx, matching the project\'s own convention) file, auto-places its board frame at the next free grid slot so it is immediately visible, and returns { relPath, pageId, title, rootNodeId }. This is the ONLY way to create a screen — there is no other tool and no raw-file-write path. rootNodeId is read back by actually parsing the file just written (never invented) — pass it to studio_apply_edits\' insert edits as the container to compose structure into. Returns { ok:false, conflict } instead of overwriting when the name is already taken. If the caller has the project open in a browser tab, its canvas is nudged to pick up the new page and its board frame (best-effort — nothing to do if no browser is open). Requires studio.write.',
  inputSchema: CreatePageInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, name, kind } = input as { dir?: string; name?: string; kind?: PageKind }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = createScaffoldedPage(dir, name ?? '', kind ?? DEFAULT_PAGE_KIND)
    if (!result.ok) return { ok: false, error: result.conflict }
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

// ---------------------------------------------------------------------------
// studio_read_file (WS-12 §3) — bounded, containment-checked file read
// ---------------------------------------------------------------------------

/** Generous enough for a real screen/component file; matches the order of magnitude `projectProbe.ts` uses for a single config file. */
const READ_FILE_MAX_BYTES = 200_000

const ReadFileInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    path: Type.String({
      description:
        'Project-relative POSIX path, e.g. "src/screens/Home.tsx" or "src/components/SheetHeader.tsx". Never absolute, never containing "..".',
    }),
  },
  { additionalProperties: false },
)

/**
 * Resolve a caller-supplied, project-relative path to a safe absolute file
 * path, or `null` when it doesn't check out — the same adversarial posture
 * `studioAsset.ts` applies to the (also attacker-controlled) asset path:
 * reject absolute/UNC/drive-letter forms, reject any `..` segment split on
 * BOTH separators, reject any segment named in `EXCLUDED_WORKSPACE_DIR_NAMES`
 * (`node_modules`, `.git`, …), then re-check containment on the REAL path
 * (`isRealpathContainedAllowingMissing`) so a symlink planted inside `dir` — a
 * GitHub import can contain one — can't point the read outside it.
 *
 * Containment deliberately tolerates a path that does not exist. The plain
 * `isRealpathContained` answers `false` for a missing file, which made this
 * function return `null` and the caller report "not a readable path inside
 * this project" — blaming containment for a file that was merely absent, and
 * making its own accurate "does not exist" message unreachable.
 */
function resolveSafeWorkspaceFile(dir: string, rawPath: string): string | null {
  if (/^[a-zA-Z]:/.test(rawPath)) return null // Windows drive path
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//') || rawPath.startsWith('/')) return null
  const segments = rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = join(dir)
  const resolved = join(dir, ...segments)
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  if (!isRealpathContainedAllowingMissing(resolved, dir)) return null
  return resolved
}

const readFileTool: AiTool = {
  name: 'studio_read_file',
  scope: 'shared',
  execution: 'server',
  description:
    `Read a workspace file by project-relative path, up to ${READ_FILE_MAX_BYTES.toLocaleString('en-US')} bytes. studio_get_node_source reads the few lines around ONE already-known node; this reads a whole file — use it to read a SIBLING screen or a component's own source before composing a new screen, so the result matches the project's existing conventions (imports, component vocabulary, class naming, file layout) instead of guessing. For a .tsx/.jsx path, also returns canonical: { isCanonical, violations, advisories } — the WS-13 canonical-JSX check (isCanonical is violations===0; advisories are informational, never disqualifying) — use this to confirm a screen you just composed is still fully editable. Returns { ok:false, error } for a missing file, a directory, an oversized file, or a path that fails containment (absolute, "..", or a symlink escaping the project) — never a partial read.`,
  inputSchema: ReadFileInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, path: rawPath } = input as { dir?: string; path: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const resolved = resolveSafeWorkspaceFile(dir, rawPath)
    if (!resolved) return { ok: false, error: `"${rawPath}" is not a readable path inside this project.` }
    // Name the three cases apart. They were collapsed into one message, and a
    // caller with no directory-listing tool could not tell "wrong path" from
    // "this is a folder" — so it guessed again, and again. `studio_list_files`
    // is the answer to the folder case, so the error says so.
    if (statSafe(resolved)?.isDirectory()) {
      return {
        ok: false,
        error: `"${rawPath}" is a directory, not a file. Call studio_list_files with path="${rawPath}" to see what is inside it.`,
      }
    }
    const content = readTextCapped(resolved, READ_FILE_MAX_BYTES)
    if (content === undefined) {
      return { ok: false, error: `"${rawPath}" does not exist, is not a regular file, or exceeds ${READ_FILE_MAX_BYTES.toLocaleString('en-US')} bytes. Call studio_list_files to see what paths actually exist rather than guessing another one.` }
    }
    const canonical = canonicalSummaryForFile(resolved, dir, rawPath)
    return { ok: true, dir, path: rawPath, content, ...(canonical ? { canonical } : {}) }
  },
}


/** Bounded so a pathological project cannot blow a turn; far above any real project's page/style tree. */
const LIST_FILES_MAX = 500

/** `statSync` that answers `undefined` instead of throwing for a path that isn't there. */
function statSafe(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

const ListFilesInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    path: Type.Optional(
      Type.String({ description: 'Project-relative folder to list, e.g. "pages" or "styles/imported". Omit for the whole project.' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: LIST_FILES_MAX, description: `Maximum paths to return (default ${LIST_FILES_MAX}).` }),
    ),
  },
  { additionalProperties: false },
)

/**
 * The tool whose absence made agents guess.
 *
 * Every other listing tool here is domain-shaped — pages, components, tokens,
 * nodes — and none answers "what files are actually in this project". An agent
 * with no shell and no directory listing could only probe `studio_read_file`
 * with invented paths (`pages/sign-in.tsx`, `pages/sign-in/index.tsx`,
 * `README.md`, `CLAUDE.md`, the design-system folder), read the same generic
 * "does not exist" for all of them, and try another guess. Observed doing
 * exactly that for a dozen consecutive calls.
 *
 * Walks through `listWorkspaceFiles`, so the exclusions (`node_modules`,
 * `.git`, `.studio`, `dist`, `.next`, `.turbo`) and the file-count cap are the
 * SAME ones every other workspace walk uses — one list, not a second policy
 * that could drift from it.
 */
const listFilesTool: AiTool = {
  name: 'studio_list_files',
  scope: 'shared',
  execution: 'server',
  description:
    'List the files in this project, as project-relative POSIX paths. Use this BEFORE studio_read_file whenever you are unsure a path exists — it is the only way to see the real file tree, and guessing paths one studio_read_file at a time is never the answer. Pass path to list one folder ("pages", "styles/imported"), omit it for the whole project. Generated/dependency folders (node_modules, .git, .studio, dist) are never listed. Returns { files, total, truncated }.',
  inputSchema: ListFilesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, path: rawPath, limit } = input as { dir?: string; path?: string; limit?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)

    let all: string[]
    try {
      all = listWorkspaceFiles(dir)
    } catch (err) {
      return { ok: false, error: `Could not list this project's files: ${err instanceof Error ? err.message : String(err)}` }
    }

    const prefix = (rawPath ?? '').replace(/^[./]+/, '').replace(/\/+$/, '')
    const matched = prefix.length === 0
      ? all
      : all.filter((f) => f === prefix || f.startsWith(`${prefix}/`))

    if (prefix.length > 0 && matched.length === 0) {
      return {
        ok: false,
        error: `"${rawPath}" matches no files in this project. Call studio_list_files with no path to see the whole tree.`,
      }
    }

    const cap = limit ?? LIST_FILES_MAX
    const files = matched.slice(0, cap)
    return { ok: true, dir, path: prefix.length > 0 ? prefix : undefined, files, total: matched.length, truncated: matched.length > files.length }
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
  createPageTool,
  readFileTool,
  listFilesTool,
]
