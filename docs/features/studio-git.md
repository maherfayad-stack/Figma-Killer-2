# Studio git integration

**Status:** v1 (W4-3). Needs human dogfooding against a real repository with a
real remote before it is trusted for daily use.

Studio's source of truth is a real React repository on disk. Until this landed,
the editor had **zero** version-control awareness: every canvas edit was an
unattributed working-tree mutation, and a designer had no way to ship one
without leaving the tool for a terminal. Git is Studio's publish verb — there
is no export step, so "publish" means *commit, branch, push*.

---

## The shape

| Layer | Module | Owns |
|---|---|---|
| Route | `server/handlers/studio/git.ts` | Dir resolution, body validation, refusal → HTTP status. **No argv is built here.** |
| Operations | `server/handlers/studio/gitOperations.ts` | The eight things Studio may ask git to do |
| Subprocess + guard | `server/handlers/studio/gitRunner.ts` | `Bun.spawn` discipline, env allowlist, the "is this the project's own repository" guard |
| Parser | `server/handlers/studio/gitStatusParse.ts` | `--porcelain=v2 --branch -z` → typed status. Pure. |
| Input judgement | `server/handlers/studio/gitPaths.ts` | Every caller-supplied path, branch name, sha, message |
| Wire contract | `src/admin/pages/site/studio/gitRequests.ts` | TypeBox schemas + `apiRequest` calls |
| Panel | `src/admin/pages/site/panels/GitPanel/` | The rail panel: branch, changes, diff, commit, push, history |
| Agent tool | `server/ai/mcp/tools/studio/gitTools.ts` | `studio_git_commit`, gated by `studio.git.write` |

---

## Routes

All under `/admin/api/studio/git/`. Bodies are validated with
`readValidatedBody`; failures use the `{ error }` envelope.

| Method | Path | Body / query | Success |
|---|---|---|---|
| GET | `status` | `?dir` | `{ isRepo, status: { branch, entries, excludedCount, hasOrigin } \| null }` |
| GET | `diff` | `?dir&file` | `{ file, staged, unstaged, untracked, truncated }` |
| GET | `log` | `?dir&limit` | `{ commits: [{ sha, shortSha, author, date, subject }] }` |
| POST | `branch` | `{ dir?, create? } \| { dir?, switch? }` | `{ ok, branch, created }` |
| POST | `commit` | `{ dir?, message, files }` | `{ ok, sha, shortSha, files }` |
| POST | `push` | `{ dir? }` | `{ ok, branch, output }` |
| POST | `init` | `{ dir?, confirm: true, message? }` | `{ ok, branch, sha, filesCommitted }` |
| POST | `restore` | `{ dir?, sha, file }` | `{ ok, file, sha }` |

`isRepo: false` is a **normal 200**, not an error — it is what makes the panel
offer "Create a repository" rather than showing a failure for a project nobody
has put under version control yet.

A refusal based on the repository's *state* (dirty tree, no `origin`, detached
HEAD, repository already exists) answers **409** with
`{ error, code, dirtyFiles? }`. A git invocation that actually failed answers
**500**. Anything rejected by a guard answers a bare **404**.

---

## The guard that matters most

`studio-workspace/` sits **inside Studio's own working tree**. Git discovers a
repository by walking up from its `cwd` until it finds a `.git`, so running git
in a project directory that has no `.git` of its own does not fail — it
silently finds *Studio's repository* and reports, or commits into, that. A
"commit my design changes" button would have committed into this repo.

So every operation except `status` and `init` requires all three of:

1. the directory is contained under `studio-workspace/`, checked on the **real**
   path after resolving symlinks;
2. it is not `studio-workspace/` itself;
3. `<dir>/.git` exists, so discovery terminates at the project.

`GIT_CEILING_DIRECTORIES` is additionally set to the workspace root as an
independent second stop. `status` reports `isRepo: false` instead of 404ing,
because that is the state the panel needs; `init` is exempt from (3) because it
is about to create the repository.

---

## Safety rails

Every one of these is enforced **server-side**. The route surface *is* the
allowed command set; there is no generic passthrough and there must never be
one.

- **Argv arrays only.** No shell anywhere in this feature. No caller-supplied
  value is interpolated into a command string, and every pathspec is passed
  after a literal `--`.
- **No force push.** `push` is `--set-upstream origin <branch>`. There is no
  route parameter that could add `--force`.
- **No reset, no clean, no stash.** Studio never stashes on a user's behalf: a
  stash is an invisible place a designer's screen went.
- **Switching branches over a dirty tree refuses**, returning the dirty file
  list. Creating a branch does *not* — `git switch -c` at HEAD moves a pointer
  and cannot change a byte in the working tree. That asymmetry is what makes
  the intended flow (edit on the canvas → branch → commit) work without a
  stash.
- **A commit stages exactly the named files.** `git add -A` and `git commit -a`
  are unreachable from any route. In a tool where an AI agent also writes
  files, "everything" is not a set the user has reviewed.
- **Excluded directories are unreachable.** `node_modules`, `dist`, `.next`,
  `.turbo`, `.git`, and Studio's own `.studio/` are rejected as paths and
  filtered out of status — with an `excludedCount` so the panel says so rather
  than quietly disagreeing with the user's terminal.
- **`restore` takes a raw sha**, not git's revision grammar. No `HEAD~3`, no
  `@{-1}`.
- **Errors never carry a filesystem path.** `clientSafeGitError` elides the
  workspace root and caps length.

### Credentials

**Studio stores no git credentials and reads none from its environment.**
Authentication is the user's own credential helper or ssh-agent, or it does not
happen. The subprocess env is an explicit allowlist of *locators*
(`GIT_ASKPASS`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, …) and contains no token
variable. `GIT_TERMINAL_PROMPT=0` is forced so a push against a remote needing a
password fails fast with git's real message instead of blocking on a terminal
read nobody will answer.

---

## `git init`

Offered only when no `.git` exists, behind `confirm: true` (a TypeBox
`Type.Literal(true)`, so `{ confirm: false }` is rejected by the schema rather
than by a handler branch).

It is the only operation that stages with `-A`, because "commit the project as
it stands" is what an initial commit means. To stop that meaning "commit
`node_modules`", a `.gitignore` listing the excluded directories is written
first — **only when the project has none**. An existing `.gitignore` is never
modified.

---

## The panel

Rail item **Version control**. Reads top to bottom the way the work does:
branch → what changed → what it changed → say what you did → send it.

- Nothing is selected for you; the commit acts on ticked files.
- Switching branches warns inline first, then reloads the board
  (`requestCmsSiteReload`) — the `.tsx` files under every frame are about to be
  different files.
- Push shows git's own output, because the remote's "create a pull request" URL
  lives there and an auth failure's real message is the only useful thing to
  show.
- Restore is per-file, from the history list, behind a danger-styled
  confirmation naming both the file and the commit, followed by a board reload.

### Why the diff view is not CodeMirror

CodeMirror is this repo's code-*editing* primitive and is the wrong tool here:
`@codemirror/merge` is not a dependency, no language mode understands
`+`/`-`/`@@`, and `codemirror-lazy-only.test.ts` permits exactly one CodeMirror
consumer because a second static import pulls ~605 kB into the eager admin
chunk. A unified diff is line-oriented text with two gutters. The parsing lives
in `gitDiffLines.ts` (pure, unit-tested — the line numbering is the part that is
easy to get wrong) and the rendering is plain rows. Revisit only if syntax
highlighting *inside* hunks becomes necessary, and widen the gate deliberately
if so.

### Agent-authored labelling

`status` entries carry `agentAuthored`, paired server-side with
`turnWriteLog.ts` — the `PostToolUse` hook record of what the agent wrote
natively, which git cannot know about.

**Scope, stated honestly:** the write log resets at the start of every turn, so
this means *"written by the agent during the most recent turn"*, not "ever
written by an agent". A file the agent wrote three turns ago and the user has
not committed reads as unlabelled. A durable per-file authorship record would be
a separate, much larger feature.

---

## The agent tool

`studio_git_commit` — commit an explicit file list with a message. That is the
only git operation an agent gets in v1.

There is deliberately **no** `studio_git_push`, `studio_git_branch`, or
`studio_git_init`. Committing is local and reversible and never leaves the
user's machine; pushing publishes to a remote other people read, and stays a
human's decision even when the human has delegated everything before it.

### The capability

`studio.git.write` — its own capability, **not** `studio.write`. Writing a file
into a workspace is a draft the user can see and undo in the editor; recording
a commit attaches their git identity to a change in a repository they may push
to a team. Those are different consents.

Like `studio.run.project`, it is **not** granted to the built-in Admin role: it
must be granted deliberately, per MCP connector or on a custom role. `mutates:
true` additionally requires `ai.tools.write`, so both axes must be held.

The human panel is unaffected — that surface is gated by `site.structure.edit`
like every other editing panel.

`studio_git_commit` is registered in the MCP registry but is **not** in
`STUDIO_AGENT_TOOL_NAMES`, so the in-canvas agent is not offered it in v1.
That list is documented as a deliberate decision each time; adding commit to the
in-canvas turn loop is a product call that has not been made.

---

## Tests

| File | Covers |
|---|---|
| `server/handlers/__tests__/gitStatusParse.test.ts` | The porcelain-v2 parser against real captured output: renames spanning two NUL fields, paths with spaces, initial/detached/diverged branch headers, unmerged records, unknown record types |
| `server/handlers/__tests__/gitPaths.test.ts` | Every rejection: traversal on both separators, absolute/UNC/drive-letter paths, excluded directories, **symlink escape** (leaf and parent), flag-looking branch names, revision expressions where a sha is required |
| `server/handlers/__tests__/git.test.ts` | End-to-end against real git: edit → status → diff → branch → commit → **push to a local bare remote**. Plus the rejections: dir outside the workspace, a project with no `.git` (never Studio's own repo), the workspace root itself, unusable paths in every path-taking route, dirty-tree switch refusal, empty commit, push with no origin, no filesystem path in an error body |
| `server/ai/mcp/tools/studio/gitTools.test.ts` | The capability declaration (invisible with `studio.write` alone, invisible without `ai.tools.write`) and the tool's own refusals |
| `src/__tests__/studio/gitDiffLines.test.ts` | Unified-diff line numbering, `---`/`+++` not read as content, hunk-header counter resets, the no-newline marker |

---

## Not in v1

- Pull / fetch / merge / rebase. A merge conflict has no UI here; the panel
  reports `unmerged` entries and refuses to commit them.
- Stage/unstage as separate actions. Commit stages what it commits.
- Roll the whole project back to a commit. Restore is per-file, deliberately.
- Any push a human did not click.
- A durable per-file record of which changes an agent authored.
