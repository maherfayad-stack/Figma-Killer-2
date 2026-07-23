/**
 * `studio_import_project` — thin MCP adapter over the Phase 7B GitHub import
 * engine (`server/handlers/studioGithubImport.ts`). Lets an external MCP
 * agent (Claude Code, Codex, a remote agent) pull a public or token-authed
 * GitHub repo into its own studio workspace directory, exactly the way the
 * admin UI's "Import from GitHub" dialog does.
 *
 * This tool does NOT reimplement any import logic — it calls
 * `runGithubImport` and reshapes its `{ dir, files, skipped }` outcome into a
 * response that also tells the agent what landed: a page count and a short
 * list of discovered page paths, using the SAME `discoverPageFiles` walk the
 * Phase 7A loader (`/admin/api/studio/load`) uses to find `pages/*.tsx` —
 * a directory listing, not a second ts-morph parse.
 *
 * SECURITY — do not regress: the import target is always derived
 * server-side from the parsed repo (`studio-workspace-imports/<owner>-<repo>`,
 * `runGithubImport`'s default). `dir` is deliberately NOT part of this tool's
 * input schema — `runGithubImport` clears its target directory before
 * repopulating it, so a caller-supplied target would be an arbitrary
 * recursive-delete primitive. Only `url`/`ref`/`subdir`/`token` are accepted,
 * and every field is passed to `runGithubImport` explicitly (never spread)
 * so a future schema addition can't silently reach the internal `dir` option.
 *
 * Importing writes files to disk only. It never publishes anything and never
 * touches the live editor's DB-backed page tree — the studio workspace it
 * writes to is opened and edited through the existing Studio UI / load path,
 * matching the draft-until-publish rule and the "no headless DB-mutating
 * page-tree tool" rule (see docs/features/mcp-connectors.md).
 *
 * `token`, when supplied, is forwarded to `runGithubImport` only — never
 * logged, never included in this tool's result, never persisted.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../runtime/types'
import { discoverPageFiles } from '../../../handlers/studio'
import { runGithubImport } from '../../../handlers/studioGithubImport'

const StudioImportInputSchema = Type.Object(
  {
    url: Type.String({
      description: 'GitHub repository URL, e.g. https://github.com/<owner>/<repo>.',
    }),
    ref: Type.Optional(
      Type.String({
        description: 'Branch, tag, or commit SHA to import. Defaults to the repository default branch.',
      }),
    ),
    subdir: Type.Optional(
      Type.String({
        description: 'Import only this subdirectory of the repository, instead of the whole tree.',
      }),
    ),
    token: Type.Optional(
      Type.String({
        description:
          'GitHub personal access token, forwarded as a Bearer credential for private repositories. Never stored or echoed back.',
      }),
    ),
  },
  { additionalProperties: false },
)

/**
 * Lists discovered `pages/*.tsx` paths (workspace-relative, sorted) under an
 * imported workspace, without parsing them — reuses the Phase 7A
 * `discoverPageFiles` walk purely to summarize what landed for the calling
 * agent. Returns `[]` when the import produced no `pages/` directory at all
 * (e.g. a repo with no recognizable pages, or a `subdir` scoped elsewhere).
 */
export function listImportedPagePaths(workspaceDir: string): string[] {
  const pagesDir = join(workspaceDir, 'pages')
  return existsSync(pagesDir) ? discoverPageFiles(pagesDir) : []
}

export const studioImportMcpTools: AiTool[] = [
  {
    name: 'studio_import_project',
    description:
      'Import a GitHub React app into its own studio workspace directory (studio-workspace-imports/<owner>-<repo>) so it can be opened as a multi-file studio workspace and edited live by the connector owner. Reuses the exact fetch-and-write engine behind the admin "Import from GitHub" dialog. Writes files to disk only — never publishes, and never edits the live page-tree editor directly. After importing, open the Studio UI (Site editor, studio mode) pointed at the returned dir to browse and edit it. Requires site.structure.edit.',
    scope: 'site',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ['site.structure.edit'],
    inputSchema: StudioImportInputSchema,
    handler: async (input, _ctx: ToolContext) => {
      const { url, ref, subdir, token } = input as {
        url: string
        ref?: string
        subdir?: string
        token?: string
      }
      // Explicit field pass-through — never spread the validated input — so
      // a future schema addition can't silently reach `runGithubImport`'s
      // internal, test-only `dir` option (its target-clearing step trusts
      // that option completely). `GithubImportError` thrown here propagates
      // to `executeAiTool`'s catch, which surfaces `err.message` as this
      // tool call's `{ ok: false, error }` result.
      const result = await runGithubImport({ url, ref, subdir, token })
      const pages = listImportedPagePaths(result.dir)
      return {
        dir: result.dir,
        files: result.files,
        skipped: result.skipped,
        pageCount: pages.length,
        pages,
      }
    },
  },
]
