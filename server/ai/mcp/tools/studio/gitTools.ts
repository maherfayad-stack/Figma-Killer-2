/**
 * The git operations an agent may perform: **status, branch, commit, push,
 * open a pull request**.
 *
 * ## Why an agent gets these, and why the line moved
 *
 * The agent writes `.tsx` files directly. Before any of this, everything it
 * did landed in the working tree as an anonymous mutation mixed in with the
 * user's own, and the user's only way to separate "what the AI changed" from
 * "what I changed" was to read the diff. Letting the agent commit its OWN
 * work, with its own message, is what makes that separable.
 *
 * v1 stopped there and said so: push "publishes to a remote other people read,
 * and it is the one step that should stay a human's decision". **That reasoning
 * was about the wrong click.** The decision a human has to make is not "press
 * push this one time" — it is "may this connector publish on my behalf at
 * all", and that decision already exists, once, as the `studio.git.write`
 * grant. It is not in the built-in Admin role; somebody has to turn it on
 * deliberately, per connector or on a custom role. Requiring the same consent
 * again per call did not buy safety, it bought an agent that could build a
 * branch and then not ship it.
 *
 * So the whole publish sentence is available — *status → branch → commit →
 * push → open a PR* — behind that one grant, and a pull request is where it
 * ends: a proposal a human reviews, which is exactly the shape of consent that
 * belongs at the end of delegated work.
 *
 * **What an agent still does NOT get**, and these are not oversights:
 *
 *   - `init` — creating a repository is a one-time structural choice about the
 *     user's project that an agent has no basis for making.
 *   - `restore`, `pull`, `merge`, `rebase`, conflict resolution — every one of
 *     them can overwrite work the user has on screen and cannot see being
 *     overwritten. The panel's conflict list exists precisely because a human
 *     has to look at those.
 *   - Any form of force push, reset, clean or stash. No route builds them, so
 *     no tool can reach them.
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
 * **`studio_git_status` is the exception, and deliberately so.** It is a read:
 * it runs `git status`, mutates nothing, and reports paths the caller can
 * already list with `studio_list_files`. Gating it behind `studio.git.write`
 * would mean an agent could not tell the user what it had changed without also
 * being allowed to commit — which is backwards. It therefore declares no
 * capability, exactly like every other read in the Studio tool family.
 *
 * ## Everything else is the same engine as the panel
 *
 * Path validation (`gitPaths.ts`), the repository guard (`gitRunner.ts`), and
 * the staging discipline (`gitOperations.commitFiles` — exactly the named
 * files, never `-A`) are the same code the HTTP routes run. There is no
 * second, looser path for agents.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  commitFiles,
  isGitFailure,
  pushCurrentBranch,
  readGitStatus,
  switchBranch,
} from '../../../../handlers/studio/gitOperations'
import {
  listGitBranches,
  readBranchCommitSubjects,
  readPullRequestContext,
} from '../../../../handlers/studio/gitSyncOperations'
import {
  isAcceptableCommitMessage,
  isArgvSafeBranchName,
  parseGithubRemoteUrl,
  resolveWorkspaceRelativePath,
} from '../../../../handlers/studio/gitPaths'
import { assertOwnGitRepo } from '../../../../handlers/studio/gitRunner'
import { githubCompareUrl, openGithubPullRequest } from '../../../../handlers/studio/githubPullRequest'
import { getGithubTokenForUser } from '../../../../handlers/studio/githubToken'
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

    // `resolveToolProjectDir` THROWS for a dir outside `studio-workspace/`
    // (`ProjectDirOutsideWorkspaceError`) — this tool's own description
    // promises "a structured, non-throwing failure", and it already declares
    // the `outside-workspace` code below, so letting that throw escape broke
    // the contract the code was written for: the agent got an exception it
    // could not read instead of a refusal it could act on.
    let projectDir: string
    try {
      projectDir = resolveToolProjectDir(dirInput, ctx)
    } catch {
      return {
        ok: false,
        code: 'outside-workspace',
        error: 'That directory is not a Studio project.',
      }
    }

    const guard = assertOwnGitRepo(projectDir)
    if (!guard.ok) {
      return guard.reason === 'not-a-repository'
        ? toolRefusal('not-a-repository', 'This project has no git repository of its own, so there is nothing to commit to.', {
            remedy: 'Ask the user to create one from the Version control panel — you may not create it yourself, so this same call will keep refusing until they do.',
          })
        : toolRefusal('outside-workspace', 'That directory is not a Studio project.')
    }

    const trimmed = message.trim()
    if (!isAcceptableCommitMessage(trimmed)) {
      return toolRefusal('invalid-message', 'A commit needs a message of 1–4096 characters.')
    }

    // Re-derived server-side, exactly as the HTTP route does. One unusable
    // path fails the whole call rather than being dropped: a commit that
    // quietly contains fewer files than the agent named would be reported as
    // a success it is not.
    const resolved: string[] = []
    for (const raw of files) {
      const relPath = resolveWorkspaceRelativePath(guard.dir, raw)
      if (relPath === null) {
        return toolRefusal('invalid-path', `"${raw}" is not a committable path in this project.`, {
          remedy: 'Use a project-relative path; build output, node_modules, .git and .studio are never committable.',
        })
      }
      if (!resolved.includes(relPath)) resolved.push(relPath)
    }

    const result = await commitFiles(guard.dir, trimmed, resolved)
    // git's own failure codes are a superset of this surface's; the two
    // `commitFiles` can actually produce are named, and anything else is
    // reported honestly as `git-failed` carrying git's original code rather
    // than invented as a refusal code nobody documented.
    if (isGitFailure(result)) {
      const code = result.code === 'empty-file-list' ? 'empty-file-list' : 'git-failed'
      return toolRefusal(code, result.message, {
        details: code === 'git-failed' && result.code !== 'git-failed' ? { gitCode: result.code } : undefined,
      })
    }
    return { ok: true, sha: result.sha, shortSha: result.shortSha, files: result.files }
  },
}

// ---------------------------------------------------------------------------
// The rest of the publish sentence (G6)
// ---------------------------------------------------------------------------

/**
 * The repository guard, as a tool RESULT rather than a throw.
 *
 * Every tool here needs the same two sentences, and an agent that gets a
 * structured `{ ok: false, code }` can act on it (ask the user to create a
 * repository) where a thrown error just ends the turn. `null` means the guard
 * passed and `dir` is usable.
 */
function guardProject(dirInput: string | undefined, ctx: ToolContext):
  | { ok: true; dir: string }
  | { ok: false; code: string; error: string } {
  const guard = assertOwnGitRepo(resolveToolProjectDir(dirInput, ctx))
  if (guard.ok) return { ok: true, dir: guard.dir }
  return {
    ok: false,
    code: guard.reason === 'not-a-repository' ? 'not-a-repository' : 'outside-workspace',
    error:
      guard.reason === 'not-a-repository'
        ? 'This project has no git repository of its own. Ask the user to create one from the Version control panel — you may not create it yourself.'
        : 'That directory is not a Studio project.',
  }
}

const DirOnlyInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({
        description:
          'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioGitStatusTool: AiTool = {
  name: 'studio_git_status',
  scope: 'shared',
  execution: 'server',
  mutates: false,
  description:
    'Read the open Studio project\'s git status: the current branch, its upstream and how far ahead/behind it is, and every changed path with its staged/unstaged/untracked/unmerged state. Returns { ok:true, isRepo, branch, entries, excludedCount, hasOrigin }. `isRepo:false` is a normal answer for a project nobody has put under version control, not an error. Paths under node_modules/dist/.next/.turbo/.git/.studio are never listed (excludedCount says how many were withheld). This is the tool to call BEFORE studio_git_commit so you commit the files you actually changed and nothing else — and after, to confirm what landed. A read: it needs no capability beyond the ones you already hold.',
  inputSchema: DirOnlyInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const guard = guardProject(dirInput, ctx)
    if (!guard.ok) {
      // "No repository yet" is a STATE for status, exactly as it is on the
      // HTTP route — the agent should be able to report it, not fail on it.
      if (guard.code === 'not-a-repository') return { ok: true, isRepo: false }
      return guard
    }

    const status = await readGitStatus(guard.dir)
    if (isGitFailure(status)) return { ok: false, code: status.code, error: status.message }
    return {
      ok: true,
      isRepo: true,
      branch: status.branch,
      entries: status.entries,
      excludedCount: status.excludedCount,
      hasOrigin: status.hasOrigin,
    }
  },
}

const BranchInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: 'Absolute project directory. Defaults to the open project.' })),
    action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('switch')], {
      description:
        'list = every local and remote-tracking branch with its divergence (a read). create = branch at HEAD and switch to it, which cannot lose uncommitted work. switch = check out an EXISTING branch, which refuses over a dirty tree.',
    }),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'The branch name. Required for create and switch, ignored for list.',
      }),
    ),
  },
  { additionalProperties: false },
)

const studioGitBranchTool: AiTool = {
  name: 'studio_git_branch',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.git.write'],
  description:
    'List, create, or switch branches in the open Studio project. action:"list" returns { branches:[{ name, remote, current, upstream, ahead, behind, upstreamGone }], current, defaultBranch } — divergence is as current as the last fetch. action:"create" branches at HEAD and switches to it; this is ALLOWED with uncommitted work, because moving the branch pointer cannot change a byte in the working tree, and it is the right first step before committing a feature. action:"switch" checks out an existing branch and REFUSES with code:"dirty-tree" and the offending paths when anything is uncommitted — Studio never stashes, so commit first (studio_git_commit) and switch after. Switching changes the files under the user\'s canvas, so prefer doing it when they asked for it. Requires studio.git.write.',
  inputSchema: BranchInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, action, name } = input as { dir?: string; action: 'list' | 'create' | 'switch'; name?: string }
    const guard = guardProject(dirInput, ctx)
    if (!guard.ok) return guard

    if (action === 'list') {
      const list = await listGitBranches(guard.dir)
      if (isGitFailure(list)) return { ok: false, code: list.code, error: list.message }
      return { ok: true, ...list }
    }

    const trimmed = (name ?? '').trim()
    if (!trimmed) {
      return { ok: false, code: 'invalid-branch-name', error: `A branch name is required to ${action} a branch.` }
    }

    const result = await switchBranch(guard.dir, trimmed, action === 'create' ? 'create' : 'switch')
    if (isGitFailure(result)) {
      return {
        ok: false,
        code: result.code,
        error: result.message,
        ...(result.dirtyFiles ? { dirtyFiles: result.dirtyFiles } : {}),
      }
    }
    return { ok: true, branch: result.branch, created: result.created }
  },
}

const studioGitPushTool: AiTool = {
  name: 'studio_git_push',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.git.write'],
  description:
    'Push the open Studio project\'s current branch to origin with --set-upstream. Never a force push — there is no parameter that could make it one, and no route behind this that could either. Returns { ok:true, branch, output } with git\'s own output, or a structured refusal: no-origin-remote (the project has no remote; ask the user to connect one), detached-head, busy (somebody else is writing to this project right now — try again), or git-failed carrying git\'s real message (an authentication failure lands here and its wording is the useful part). Authentication is the GitHub account the user signed in with, resolved server-side from their session, or the host\'s own credential helper — you never supply a credential. Push what you committed; do not push a branch you did not build. Requires studio.git.write.',
  inputSchema: DirOnlyInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput } = input as { dir?: string }
    const guard = guardProject(dirInput, ctx)
    if (!guard.ok) return guard

    // The token belongs to the user this turn is running for. `null` is
    // normal: git then falls back to the host's own credential helper.
    const token = await getGithubTokenForUser(ctx.userId)
    const result = await pushCurrentBranch(guard.dir, { credential: token ?? undefined })
    if (isGitFailure(result)) return { ok: false, code: result.code, error: result.message }
    return { ok: true, branch: result.branch, output: result.output }
  },
}

const OpenPrInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: 'Absolute project directory. Defaults to the open project.' })),
    title: Type.Optional(
      Type.String({ description: 'Defaults to the subject of the most recent commit on this branch.' }),
    ),
    body: Type.Optional(
      Type.String({ description: 'Defaults to the list of commit subjects this branch adds over the base.' }),
    ),
    base: Type.Optional(
      Type.String({ description: 'The branch to merge INTO. Defaults to what origin/HEAD points at, else main.' }),
    ),
  },
  { additionalProperties: false },
)

const studioGitOpenPrTool: AiTool = {
  name: 'studio_git_open_pr',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.git.write'],
  description:
    'Open a GitHub pull request for the open Studio project\'s current branch. Push it first (studio_git_push) — GitHub cannot propose commits it does not have. Every field is optional: base defaults to origin/HEAD, title to the last commit subject, body to the commit list. Returns { ok:true, url, number, compareUrl }, or a structured refusal: not-a-github-remote (origin is not a GitHub repository), same-branch (you are standing on the base branch — create one first), no-github-token (nobody has connected a GitHub account; hand the user the compareUrl instead, it is a working link), github-rejected carrying GitHub\'s own message ("A pull request already exists", "No commits between main and feat/x" — that message IS the answer), or github-unreachable (retry). A pull request is a PROPOSAL a human reviews, which is where delegated work should end. Requires studio.git.write.',
  inputSchema: OpenPrInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, title, body, base: baseInput } = input as {
      dir?: string
      title?: string
      body?: string
      base?: string
    }
    const guard = guardProject(dirInput, ctx)
    if (!guard.ok) return guard

    const context = await readPullRequestContext(guard.dir)
    if (isGitFailure(context)) return { ok: false, code: context.code, error: context.message }

    const target = parseGithubRemoteUrl(context.originUrl)
    if (!target) {
      return {
        ok: false,
        code: 'not-a-github-remote',
        error:
          'This project\'s "origin" remote is not a GitHub repository, so a pull request cannot be opened for it.',
      }
    }

    const base = (baseInput ?? '').trim() || context.defaultBranch || 'main'
    // The same judgement `POST git/pull-request` makes on the same field, and
    // for the same reason: `base` becomes an argv token in
    // `readBranchCommitSubjects` (`origin/<base>..<head>`). The `origin/`
    // prefix stops it posing as a flag, but nothing else bounds its length or
    // rejects the control characters that would corrupt the NUL/line-delimited
    // output this feature parses. An agent's argument is no more trusted than
    // a browser's.
    if (!isArgvSafeBranchName(base)) {
      return {
        ok: false,
        code: 'invalid-branch-name',
        error: `"${base}" is not a usable base branch name.`,
      }
    }
    if (base === context.branch) {
      return {
        ok: false,
        code: 'same-branch',
        error: `The current branch "${context.branch}" is also the base branch. Create a branch for your work first (studio_git_branch with action:"create").`,
        compareUrl: githubCompareUrl(target, base, context.branch),
      }
    }

    const subjects = await readBranchCommitSubjects(guard.dir, base, context.branch)
    const result = await openGithubPullRequest({
      target,
      title: (title ?? '').trim() || subjects[0] || context.branch,
      body: body ?? subjects.map((subject: string) => `- ${subject}`).join('\n'),
      base,
      head: context.branch,
      token: await getGithubTokenForUser(ctx.userId),
    })
    if (!result.ok) return { ok: false, code: result.code, error: result.message, compareUrl: result.compareUrl }
    return { ok: true, url: result.url, number: result.number, compareUrl: result.compareUrl }
  },
}

export const studioGitMcpTools: AiTool[] = [
  studioGitStatusTool,
  studioGitBranchTool,
  studioGitCommitTool,
  studioGitPushTool,
  studioGitOpenPrTool,
]
