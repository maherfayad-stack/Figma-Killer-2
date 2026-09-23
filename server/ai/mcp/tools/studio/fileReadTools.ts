/**
 * Studio file READ tools — read, list, grep, and the node-id-to-source
 * bridge. Server-resolved and headless; in the MCP registry for external
 * clients, and on the in-canvas agent's surface for the HTTP drivers, which
 * have no native file tools (P4-C, AI-2).
 *
 * Every path a caller names goes through `resolveAgentFilePath`
 * (`server/handlers/studio/agentFileAccess.ts`) with intent `'read'` — the
 * same rule the write tools use with intent `'write'`. Two of these tools used
 * to carry their own checks, and both were wrong in a way that let a read
 * leave the project's source: a case-sensitive exclusion list, and none at all.
 *
 * A text read hands back `hash`, the version tag `studio_write_file`,
 * `studio_edit_file` and `studio_edit_files` accept as `expectedHash`: the
 * write refuses when the file has moved on since this read.
 */
import { readFileSync } from 'node:fs'
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal, type ToolRefusal } from '@core/ai'
import { decodeSourceNodeId } from '@core/page-tree'
import { listWorkspaceFiles } from '@core/page-parser'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { canonicalSummaryForFile } from '../../../../handlers/studio/canonicalPageCheck'
import {
  AGENT_PATH_MAX_CHARS,
  nonTextReason,
  readTextFile,
  resolveAgentFilePath,
  statIfPresent,
  type AgentFileRefusal,
} from '../../../../handlers/studio/agentFileAccess'

/** Generous enough for any real screen, component or stylesheet; the write tools share it, so everything written can be read back. */
export const AGENT_FILE_MAX_BYTES = 200_000

const DIR_FIELD = Type.Optional(
  Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
)

/** A containment refusal in the shared refusal shape. */
export function pathRefusal(refusal: AgentFileRefusal): ToolRefusal {
  return toolRefusal(refusal.code, refusal.message, { remedy: refusal.remedy })
}

// ---------------------------------------------------------------------------
// studio_read_file
// ---------------------------------------------------------------------------

const ReadFileInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    path: Type.String({
      maxLength: AGENT_PATH_MAX_CHARS,
      description: 'Path of the file inside the project, relative to its root, e.g. "pages/Home.tsx" or "src/components/SheetHeader.tsx". An absolute path inside the project is accepted too.',
    }),
  },
  { additionalProperties: false },
)

const readFileTool: AiTool = {
  name: 'studio_read_file',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    `Read one text file of this project, up to ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')} bytes. Use it to read a SIBLING screen or a component's own source before composing a new screen, so the result matches the project's conventions (imports, component vocabulary, class naming) instead of guessing. Returns { path, content, hash, bytes } — hash is the file's version: pass it as expectedHash to any write or edit of this file, and the write refuses if someone changed the file after you read it. For a .tsx/.jsx path it also returns canonical: { isCanonical, violations, advisories } — whether the screen is still fully editable on the canvas. Refuses with a coded reason for a missing file, a directory, a binary or oversized file, a credential file (.env, keys), anything inside .studio/.git/node_modules/build output, and any path outside the project.`,
  inputSchema: ReadFileInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, path: rawPath } = input as { dir?: string; path: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const target = resolveAgentFilePath(dir, rawPath, 'read')
    if (!target.ok) return pathRefusal(target)
    const read = readTextFile(target.abs, AGENT_FILE_MAX_BYTES)
    switch (read.kind) {
      case 'missing':
        return toolRefusal('no-such-file', `"${target.rel}" does not exist.`, {
          remedy: 'Call studio_list_files to see what paths actually exist rather than guessing another one.',
        })
      case 'not-a-file':
        return toolRefusal('not-a-file', `"${target.rel}" is a directory, not a file.`, {
          remedy: `Call studio_list_files with path="${target.rel}" to see what is inside it.`,
        })
      case 'too-large':
        return toolRefusal('file-too-large', `"${target.rel}" is ${read.bytes.toLocaleString('en-US')} bytes, which exceeds the ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')}-byte read cap.`, {
          remedy: 'Search it with studio_grep for the part you need instead.',
        })
      case 'not-text':
        return toolRefusal('not-text', `"${target.rel}" ${read.reason}.`)
      case 'text': {
        const canonical = canonicalSummaryForFile(target.abs, dir, target.rel)
        return { ok: true, dir, path: target.rel, content: read.content, hash: read.hash, bytes: read.bytes, ...(canonical ? { canonical } : {}) }
      }
    }
  },
}

// ---------------------------------------------------------------------------
// studio_list_files
// ---------------------------------------------------------------------------

/** Bounded so a pathological project cannot blow a turn; far above any real project's page/style tree. */
const LIST_FILES_MAX = 500

const ListFilesInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    path: Type.Optional(
      Type.String({ maxLength: AGENT_PATH_MAX_CHARS, description: 'Folder to list, relative to the project root, e.g. "pages" or "styles/imported". Omit for the whole project.' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: LIST_FILES_MAX, description: `Maximum paths to return (default ${LIST_FILES_MAX}).` }),
    ),
  },
  { additionalProperties: false },
)

/**
 * The tool whose absence made agents guess: with no directory listing, the
 * only way to find a file was to probe `studio_read_file` with invented paths.
 * Walks through `listWorkspaceFiles`, so the exclusions and the file-count cap
 * are the SAME ones every workspace walk uses.
 */
const listFilesTool: AiTool = {
  name: 'studio_list_files',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'List the files in this project, as paths relative to its root. Use this BEFORE studio_read_file whenever you are unsure a path exists — guessing paths one read at a time is never the answer. Pass path to list one folder ("pages", "styles/imported"), omit it for the whole project. Generated/dependency folders (node_modules, .git, .studio, dist) are never listed. Returns { files, total, truncated }.',
  inputSchema: ListFilesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, path: rawPath, limit } = input as { dir?: string; path?: string; limit?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)

    let all: string[]
    try {
      all = listWorkspaceFiles(dir)
    } catch (err) {
      return toolRefusal('io-error', `Could not list this project's files: ${err instanceof Error ? err.message : String(err)}`)
    }

    const prefix = (rawPath ?? '').replace(/\\/g, '/').replace(/^[./]+/, '').replace(/\/+$/, '')
    const matched = prefix.length === 0
      ? all
      : all.filter((f) => f === prefix || f.startsWith(`${prefix}/`))

    if (prefix.length > 0 && matched.length === 0) {
      return toolRefusal('no-such-file', `"${rawPath}" matches no files in this project.`, {
        remedy: 'Call studio_list_files with no path to see the whole tree.',
      })
    }

    const cap = limit ?? LIST_FILES_MAX
    const files = matched.slice(0, cap)
    return { ok: true, dir, path: prefix.length > 0 ? prefix : undefined, files, total: matched.length, truncated: matched.length > files.length }
  },
}

// ---------------------------------------------------------------------------
// studio_grep
// ---------------------------------------------------------------------------

const GREP_DEFAULT_RESULTS = 100
const GREP_MAX_RESULTS = 500
/** Files over this are skipped rather than read: a minified bundle is never what an agent is looking for. */
const GREP_MAX_FILE_BYTES = 1_000_000
/** Total bytes one search reads before it stops and says so. */
const GREP_MAX_SCANNED_BYTES = 30_000_000
/** A matched line is echoed at most this long — enough to read, never a whole minified line. */
const GREP_LINE_ECHO_CHARS = 240

const GrepInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    query: Type.String({
      minLength: 1,
      maxLength: 1_000,
      description: 'The text to find — a LITERAL string, not a regular expression (so "styles.row" and "a(b)" match exactly what they say). One line at a time: a query containing a line break matches nothing.',
    }),
    path: Type.Optional(
      Type.String({ maxLength: AGENT_PATH_MAX_CHARS, description: 'Only search under this folder (or this one file), relative to the project root, e.g. "pages". Omit to search the whole project.' }),
    ),
    caseSensitive: Type.Optional(Type.Boolean({ description: 'Match letter case exactly. Default false.' })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: GREP_MAX_RESULTS, description: `Maximum matching lines to return (default ${GREP_DEFAULT_RESULTS}).` }),
    ),
  },
  { additionalProperties: false },
)

const grepTool: AiTool = {
  name: 'studio_grep',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Search this project\'s text files for a literal string and get every matching line as { path, line, text }. The fast way to answer "where is X used / defined" — a class name, a token, a component, a translation key — without reading files one by one. Case-insensitive unless caseSensitive:true; path narrows it to one folder or file. Skips the same things studio_list_files skips (node_modules, .git, .studio, build output), binary files, credential files and files over 1 MB. Returns { matches, total, truncated, filesSearched } — truncated:true means there were more matches than limit, or the search stopped at its byte budget.',
  inputSchema: GrepInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, query, path: rawPath, caseSensitive, limit } = input as {
      dir?: string
      query: string
      path?: string
      caseSensitive?: boolean
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const cap = limit ?? GREP_DEFAULT_RESULTS
    const needle = caseSensitive ? query : query.toLowerCase()

    let all: string[]
    try {
      all = listWorkspaceFiles(dir)
    } catch (err) {
      return toolRefusal('io-error', `Could not list this project's files: ${err instanceof Error ? err.message : String(err)}`)
    }
    const prefix = (rawPath ?? '').replace(/\\/g, '/').replace(/^[./]+/, '').replace(/\/+$/, '')
    const candidates = prefix.length === 0 ? all : all.filter((f) => f === prefix || f.startsWith(`${prefix}/`))

    const matches: Array<{ path: string; line: number; text: string }> = []
    let total = 0
    let scannedBytes = 0
    let filesSearched = 0
    let budgetExhausted = false
    for (const candidate of candidates) {
      // The listing already skips excluded directories and links; the shared
      // rule adds credential files and re-checks the real path.
      const target = resolveAgentFilePath(dir, candidate, 'read')
      if (!target.ok) continue
      const stat = statIfPresent(target.abs)
      if (!stat?.isFile() || stat.size > GREP_MAX_FILE_BYTES) continue
      if (scannedBytes + stat.size > GREP_MAX_SCANNED_BYTES) {
        budgetExhausted = true
        break
      }
      scannedBytes += stat.size
      let bytes: Buffer
      try {
        bytes = readFileSync(target.abs)
      } catch {
        continue
      }
      if (nonTextReason(bytes) !== null) continue
      filesSearched += 1
      const lines = bytes.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue
        total += 1
        if (matches.length < cap) {
          const trimmed = line.trim()
          matches.push({
            path: target.rel,
            line: index + 1,
            text: trimmed.length > GREP_LINE_ECHO_CHARS ? `${trimmed.slice(0, GREP_LINE_ECHO_CHARS)}…` : trimmed,
          })
        }
      }
    }
    return { ok: true, dir, query, matches, total, truncated: total > matches.length || budgetExhausted, filesSearched }
  },
}

// ---------------------------------------------------------------------------
// studio_get_node_source
// ---------------------------------------------------------------------------

const GetNodeSourceInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    nodeId: Type.String({
      maxLength: 2 * AGENT_PATH_MAX_CHARS,
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
  sideEffects: 'none',
  description:
    'Decode a studio node id (the selected element in the live digest, a node a finding names) to its exact source location: { file, relFile, line, col, snippet, hash }. This is the bridge from "the hero section is wrong" to "here is the code". hash is the whole file\'s version — pass it as expectedHash when you edit that file. Refuses with a reason for a synthetic node (no source location), a `.map`-iteration node id (one piece of source renders N nodes, so there is no single line for row 2), and a node whose file is outside the project\'s readable source.',
  inputSchema: GetNodeSourceInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, nodeId, contextLines } = input as { dir?: string; nodeId: string; contextLines?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const loc = decodeSourceNodeId(nodeId)
    if (!loc) {
      return toolRefusal(
        'no-writable-location',
        `Node "${nodeId}" has no single writable source location — it is either synthetic (e.g. the page root) or a \`.map\` iteration (one piece of source renders N nodes, so there is no line that names just this one).`,
      )
    }
    // A node id's file part is a string the caller wrote; it gets the same
    // rule as any other path. It used to be joined on unchecked, so
    // `../../outside:1:1` read a file outside the project.
    const target = resolveAgentFilePath(dir, loc.rel, 'read')
    if (!target.ok) return pathRefusal(target)
    const read = readTextFile(target.abs, AGENT_FILE_MAX_BYTES)
    let snippet: string | null = null
    let hash: string | null = null
    if (read.kind === 'text') {
      const lines = read.content.split('\n')
      const pad = contextLines ?? 2
      const start = Math.max(0, loc.line - 1 - pad)
      const end = Math.min(lines.length, loc.line + pad)
      snippet = lines.slice(start, end).join('\n')
      hash = read.hash
    }
    // An unreadable file still yields the decoded location — the id is
    // information on its own.
    return { ok: true, file: target.abs, relFile: target.rel, line: loc.line, col: loc.col, snippet, hash }
  },
}

export const studioFileReadMcpTools: AiTool[] = [readFileTool, listFilesTool, grepTool, getNodeSourceTool]
