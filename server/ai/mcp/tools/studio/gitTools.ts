/**
 * `studio_git_commit` — the one git operation an agent may perform.
 *
 * ## Why an agent gets exactly this, and nothing else
 *
 * The agent writes `.tsx` files directly. Before this tool, everything it did
 * landed in the working tree as an anonymous mutation mixed in with the user's
 * own, and the user's only way to separate "what the AI changed" from "what I
 * changed" was to read the diff. Letting the agent commit its OWN work, with
 * its own message, is what makes that separable.
 *
 * There is deliberately no `studio_git_push`, `studio_git_branch`, or
 * `studio_git_init` tool in v1. Committing is local and reversible: a bad
 * commit is `git reset` away and never leaves the user's machine. Pushing is
 * neither — it publishes to a remote other people read, and it is the one step
 * that should stay a human's decision even when the human has delegated
 * everything before it. Branch and init are one-time structural choices about
 * the user's repository that an agent has no basis for making.
 *
 * ## Capability
 *
 * `studio.git.write`, a capability of its own — NOT `studio.write`. Writing a
 * file into a workspace and recording a commit under the user's git identity
 * are different consents: the first is a draft the user can see and undo in
 * the editor, the second attaches their name to a change in a repository they
 * may push to a team. Same reasoning that keeps `studio.run.project` separate
 * from `studio.write`, and — like it — this capability is not granted to the
 * built-in Admin role: it has to be granted deliberately, per connector or per
 * custom role. `mutates: true` additionally requires `ai.tools.write`, so both
 * axes must be held.
 *
 * ## Everything else is the same engine as the panel
 *
 * Path validation (`gitPaths.ts`), the repository guard (`gitRunner.ts`), and
 * the staging discipline (`gitOperations.commitFiles` — exactly the named
 * files, never `-A`) are the same code the HTTP routes run. There is no
 * second, looser path for agents.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { commitFiles, isGitFailure } from '../../../../handlers/studio/gitOperations'
import { isAcceptableCommitMessage, resolveWorkspaceRelativePath } from '../../../../handlers/studio/gitPaths'
import { assertOwnGitRepo } from '../../../../handlers/studio/gitRunner'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({
        description:
          'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.',
      }),
    ),
    message: Type.String({
      minLength: 1,
      description:
        'The commit message. Write what changed and why, in the imperative mood, the way the project\'s own history reads.',
    }),
    files: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description:
        'Project-relative POSIX paths to commit — exactly these and nothing else. There is no "commit everything" option: name the files you changed.',
    }),
  },
  { additionalProperties: false },
)

const studioGitCommitTool: AiTool = {
  name: 'studio_git_commit',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.git.write'],
  description:
    'Commit an explicit list of files in the open Studio project, with a message. Stages EXACTLY the files you name (never `git add -A`), so a commit contains only what you meant. Returns { ok:true, sha, shortSha, files }, or a structured, non-throwing failure: not-a-repository (the project has no git repository — ask the user to create one, you cannot), or git-failed with git\'s own message (a missing git identity and an empty commit both land here). Requires studio.git.write, which is granted deliberately and is NOT implied by studio.write. There is no push, branch, or init tool: committing is local and undoable, publishing is the user\'s decision.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, message, files } = input as { dir?: string; message: string; files: string[] }
    const guard = assertOwnGitRepo(resolveToolProjectDir(dirInput, ctx))
    if (!guard.ok) {
      return {
        ok: false,
        code: guard.reason === 'not-a-repository' ? 'not-a-repository' : 'outside-workspace',
        error:
          guard.reason === 'not-a-repository'
            ? 'This project has no git repository of its own, so there is nothing to commit to. Ask the user to create one from the Version control panel — you may not create it yourself.'
            : 'That directory is not a Studio project.',
      }
    }

    const trimmed = message.trim()
    if (!isAcceptableCommitMessage(trimmed)) {
      return { ok: false, code: 'invalid-message', error: 'A commit needs a message of 1–4096 characters.' }
    }

    // Re-derived server-side, exactly as the HTTP route does. One unusable
    // path fails the whole call rather than being dropped: a commit that
    // quietly contains fewer files than the agent named would be reported as
    // a success it is not.
    const resolved: string[] = []
    for (const raw of files) {
      const relPath = resolveWorkspaceRelativePath(guard.dir, raw)
      if (relPath === null) {
        return {
          ok: false,
          code: 'invalid-path',
          error: `"${raw}" is not a committable path in this project. Use a project-relative path; build output, node_modules, .git and .studio are never committable.`,
        }
      }
      if (!resolved.includes(relPath)) resolved.push(relPath)
    }

    const result = await commitFiles(guard.dir, trimmed, resolved)
    if (isGitFailure(result)) return { ok: false, code: result.code, error: result.message }
    return { ok: true, sha: result.sha, shortSha: result.shortSha, files: result.files }
  },
}

export const studioGitMcpTools: AiTool[] = [studioGitCommitTool]
