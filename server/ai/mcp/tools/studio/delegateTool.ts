/**
 * `studio_delegate` — the API-key path's subagents (AI-23). The HTTP drivers'
 * counterpart of the `claude` CLI's `Task` tool: one bounded child agent per
 * page, run concurrently, each able to write only its own page's two files.
 * The runner, the child's surface and the enforcement are in
 * `server/ai/delegation/delegateRunner.ts`.
 *
 * This file owns the input: each task names ONE page's component file, the
 * page's `.module.css` beside it is the only other file that task may write,
 * and no two tasks may name the same page — the disjointness that makes
 * concurrent children safe without a lock is checked here, before anything
 * runs.
 *
 * ## Where it is offered
 *
 * Only on an HTTP driver's turn with a project open (`selectStudioTools`). The
 * runner lives on the chat turn (`ToolContext.delegate`): it needs the turn's
 * driver, credential and prompt, which an external MCP client has none of —
 * so the tool is not in the external catalog, and a call without a runner
 * refuses `delegation-unavailable` rather than pretending.
 *
 * Write-gated like the file tools it hands out (`ai.tools.write` +
 * `studio.write`), and `sideEffects: 'write'`: the loop runs it on its own,
 * never beside another write, and plan mode refuses it until a plan is
 * approved.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import type { AiTool, DelegateTask, ToolContext } from '../../../runtime/types'
import { AGENT_PATH_MAX_CHARS, resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { DELEGATE_TOOL_NAME } from '../../../delegation/delegateRunner'
import { pathRefusal } from './fileReadTools'

/** Children per call. Each is a full agent loop on the user's key. */
export const MAX_DELEGATE_TASKS = 4
const PAGE_FILE = /\.(tsx|jsx)$/i

const DelegateInputSchema = Type.Object(
  {
    tasks: Type.Array(
      Type.Object(
        {
          page: Type.String({
            minLength: 1,
            maxLength: AGENT_PATH_MAX_CHARS,
            description: 'The page\'s component file, project-relative, e.g. "pages/Checkout.tsx". The subagent may write this file and the .module.css beside it (pages/Checkout.module.css), and nothing else.',
          }),
          brief: Type.String({
            minLength: 20,
            maxLength: 12_000,
            description: 'Everything the subagent needs, self-contained: it sees nothing of this conversation. What the screen contains, the design-system components to use, the reference id to measure against, the tokens and copy to use, and what "done" means.',
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_DELEGATE_TASKS, description: 'One task per page. Two tasks may not name the same page.' },
    ),
  },
  { additionalProperties: false },
)

export const studioDelegateTool: AiTool = {
  name: DELEGATE_TOOL_NAME,
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    `Build up to ${MAX_DELEGATE_TASKS} pages at once: one subagent per page, running at the same time, each owning exactly its page file and that page's .module.css (any other write is refused not-owned). Do every shared change first yourself — translation keys, shared components, tokens, dependencies, references — because subagents cannot touch them. Each brief must stand alone: the subagent sees nothing of this conversation. Returns { results[]: { page, ok, model, report, filesWritten, toolCalls, rounds, stopped? } } once all finish; then check each page yourself (studio_screenshot or studio_compare). Refusals: overlapping-ownership (two tasks, one page), invalid-input (not a .tsx/.jsx page), path-outside-project, protected-path, needs-user, delegation-unavailable. Requires studio.write.`,
  inputSchema: DelegateInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { tasks } = input as { tasks: Array<{ page: string; brief: string }> }
    const dir = ctx.workspaceDir
    if (!ctx.delegate || !dir) {
      return toolRefusal('delegation-unavailable', 'There is no chat turn with an open project to run subagents in.', {
        remedy: 'Build the pages yourself, one after another.',
      })
    }

    const resolved: DelegateTask[] = []
    const seen = new Set<string>()
    for (const task of tasks) {
      const page = resolveAgentFilePath(dir, task.page, 'write')
      if (!page.ok) return pathRefusal(page)
      if (!PAGE_FILE.test(page.rel)) {
        return toolRefusal('invalid-input', `"${page.rel}" is not a page component file (.tsx or .jsx).`, {
          remedy: 'Name each page by its component file, e.g. "pages/Checkout.tsx".',
        })
      }
      const styles = resolveAgentFilePath(dir, page.rel.replace(PAGE_FILE, '.module.css'), 'write')
      if (!styles.ok) return pathRefusal(styles)
      const key = page.rel.toLowerCase()
      if (seen.has(key)) {
        return toolRefusal('overlapping-ownership', `"${page.rel}" is named by more than one task, so two subagents would write the same files.`, {
          remedy: 'Give each page to exactly one task.',
        })
      }
      seen.add(key)
      resolved.push({ page: page.rel, owned: [page.rel, styles.rel], brief: task.brief })
    }

    const results = await ctx.delegate.run(resolved, ctx)
    return { ok: true, results }
  },
}
