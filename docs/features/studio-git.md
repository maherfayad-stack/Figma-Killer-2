# Studio git integration

**Status:** v1 (W4-3). Needs human dogfooding against a real repository with a
real remote before it is trusted for daily use.

Studio's source of truth is a real React repository on disk. Until this landed,
the editor had **zero** version-control awareness: every canvas edit was an
unattributed working-tree mutation, and a designer had no way to ship one
without leaving the tool for a terminal. Git is Studio's publish verb — there
is no export step, so "publish" means *commit, branch, push*.

The step after it — *see it live* — is
[`studio-deploy.md`](studio-deploy.md): a preview deploy through the provider
CLI the user already has, rendered as a Deploy section at the bottom of this
same panel.

---

## The shape

| Layer | Module | Owns |
|---|---|---|
| Route | `server/handlers/studio/git.ts` | The local verbs: status, diff, log, branch, commit, push, init, restore |
| Route | `server/handlers/studio/gitSyncRoutes.ts` | Branches and commit-and-switch — a sibling sub-router. Both files are routing only: dir resolution, body validation, refusal → HTTP status. **No argv is built in either.** |
| Operations | `server/handlers/studio/gitOperations.ts` | The eight things Studio may ask git to do |
| Subprocess + guard | `server/handlers/studio/gitRunner.ts` | `Bun.spawn` discipline, env allowlist, the "is this the project's own repository" guard |
| Write lock | `server/handlers/studio/projectWriteLock.ts` | One writer per project — saves, scaffolds, installs and git verbs |
| Parser | `server/handlers/studio/gitStatusParse.ts` | `--porcelain=v2 --branch -z` → typed status. Pure. |
| Input judgement | `server/handlers/studio/gitPaths.ts` | Every caller-supplied path, branch name, sha, message |
| Wire contract | `src/admin/pages/site/studio/gitRequests.ts` | TypeBox schemas + `apiRequest` calls |
| Panel | `src/admin/pages/site/panels/GitPanel/` | The rail panel: branch, changes, diff, commit, push, history |
| Panel — branch | `.../GitPanel/BranchSection.tsx` | The branch dropdown, “New branch from current”, the commit-and-switch dialog |
| Panel — sync | `.../GitPanel/SyncSection.tsx` | Fetch, pull, push, the rebase-or-merge choice, per-file conflict resolution |
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
| GET | `branches` | `?dir` | `{ branches: [{ name, remote, current, upstream, ahead, behind, upstreamGone }], current, defaultBranch }` |
| POST | `commit-and-switch` | `{ dir?, message, files, switch }` | `{ ok, sha, shortSha, files, branch }` |
| POST | `fetch` | `{ dir? }` | `{ ok, output }` |
| POST | `pull` | `{ dir?, strategy?: 'ff-only' \| 'rebase' \| 'merge' }` | `{ ok, strategy, output }` |
| GET | `conflicts` | `?dir` | `{ kind: 'rebase' \| 'merge' \| null, files }` |
| POST | `conflict/resolve` | `{ dir?, file, side: 'mine' \| 'theirs' }` | `{ ok, file, side }` |
| POST | `conflict/continue` | `{ dir? }` | `{ ok, kind }` |
| POST | `conflict/abort` | `{ dir?, confirm: true }` | `{ ok, kind }` |

`isRepo: false` is a **normal 200**, not an error — it is what makes the panel
offer "Create a repository" rather than showing a failure for a project nobody
has put under version control yet.

A refusal based on the repository's *state* (dirty tree, no `origin`, detached
HEAD, repository already exists, another writer holds the project write lock)
answers **409** with `{ error, code, dirtyFiles? }`. A git invocation that
actually failed answers **500**. Anything rejected by a guard answers a bare
**404**.

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
  list. The panel turns that into a choice rather than a dead end: a dialog
  with exactly two ways out — **Commit and switch** (the `commit-and-switch`
  route: commit the ticked files, then switch, both inside ONE hold of the
  project write lock) or **Cancel**. Still no stash, ever. Creating a branch is
  *not* gated on a clean tree — `git switch -c` at HEAD moves a pointer and
  cannot change a byte in the working tree. That asymmetry is what makes the
  intended flow (edit on the canvas → branch → commit) work without a stash.
- **`commit-and-switch` never rolls a commit back.** If files the user did not
  tick are still dirty afterwards, the switch refuses and names them; the
  commit stands, because it is what the user asked for and undoing it silently
  would be the surprising option.
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
- **A pull over a dirty tree refuses**, naming the files. Same rule as a branch
  switch, same reason: Studio does not stash, so it does not pull over work it
  would have to hide somewhere first.
- **A pull never chooses how to reconcile.** The default is `--ff-only`, which
  cannot rewrite anything; rebase and merge are reachable only through an
  explicit request the panel asked the user for.
- **`rebase --abort` / `merge --abort` is the only new destructive verb**, and
  it sits behind the same danger-styled confirmation `restore` uses. It is
  narrower than it looks: the pull refused to start over a dirty tree, so there
  is no uncommitted work for an abort to discard.
- **One writer at a time, per project.** See below.

### The project write lock

`server/handlers/studio/projectWriteLock.ts` — an async mutex keyed by the
**real** project path (symlinks resolved, so one project is one lock), FIFO,
reentrant.

It exists because a git verb is a *sequence* of subprocesses with real `await`
points between them, while a canvas save is one synchronous burst of writes.
Without it, a save lands between the staging step and the commit step and the
commit carries content nobody reviewed; two overlapping git verbs surface git's
own `index.lock` error, which has a filesystem path in it.

Every mutation of a project's files takes it:

| Holder | Where | Wait |
|---|---|---|
| A canvas save | `applyStudioEditBatchLocked` (`studioWriteback.ts`) | unbounded |
| A page scaffold | `scaffoldPageLocked` (`pageScaffold.ts`) | unbounded |
| A dependency install | the package-manager subprocess only (`installDeps.ts`) | unbounded |
| Every mutating git verb | `withGitWriteLock` (`gitOperations.ts`) | 5 s, then `busy` |

A save waits as long as it has to, because the user's alternative to waiting is
losing the edit. A git verb waits five seconds and then answers **409
`{ code: 'busy' }`** — a person who clicked Commit would rather be told the
project is busy than watch a spinner for the length of an install.

**Reads take no lock**: `status`, `diff`, `log`, and `branches` mutate nothing,
the panel re-reads status after every action, and a read that could answer
`busy` would turn the whole panel into an error state for the duration of an
install.

The lock is **reentrant** — the held keys travel with the async context
(`AsyncLocalStorage`), across `await`s and subprocess waits — so a verb that
reads status inside its own critical section (`push`, `pull`) does not deadlock
on itself.

`studioCssWriteback.ts` needs no lock of its own: `applyCssEdit`'s only caller
is the edit batch, so a `css` edit is already inside the save's lock.

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

### Branches

The branch control is a **dropdown of the branches that exist**, not a
free-text field — v1 asked a designer to type a name they had no way to look
up and then guess whether “Create” or “Switch” was the right button.

`GET branches` is one `for-each-ref` over `refs/heads` and `refs/remotes` with
`%(upstream:track)` for per-branch divergence. It is a **read**, so it takes no
write lock and can never answer `busy`. Divergence is as current as the last
fetch and no more — that is what the Fetch button is for.

A remote-tracking ref is offered by its **local** name (`origin/feature` reads
as `feature (from origin)`) and switched with `git switch feature`, which git
resolves to “create a local branch tracking origin/feature”. Offering
`origin/feature` literally would detach HEAD, which is the state this panel
exists to keep people out of. `origin/HEAD` is never listed: it is a symbolic
ref, not a branch — it is reported separately as `defaultBranch`.

### Fetch, pull, and conflicts

`fetch` is `git fetch --prune origin`: it changes refs, never files. What it
buys is that ahead/behind becomes true again — the branch list's divergence is
only ever as current as the last fetch.

`pull` takes a closed `strategy` union and defaults to `ff-only`. When both
sides have commits, `ff-only` fails and that failure is reported as its own
code, `diverged` — it is the moment the panel says so and offers *Rebase onto
origin* and *Merge* as two explicit buttons, because those write different
history and which one a team wants is not a design tool's call.

**Push is disabled while the branch is behind**, with "Pull first" on the
tooltip. The remote would reject it anyway; saying so before the click is the
difference between a tool and a terminal.

A conflict answers `409 { code: 'conflict', files }`, and the panel renders the
unmerged paths with **Keep mine / Keep theirs / Open in code** each, then one
**Continue**. Two things about that are load-bearing:

- **`mine`/`theirs` is the wire vocabulary, not `--ours`/`--theirs`.** Git's
  flags INVERT during a rebase: your commits are replayed on top of the
  upstream, so `--ours` is the upstream and `--theirs` is your own work.
  Translating in the browser is how somebody destroys an afternoon with one
  click, so the translation happens in `gitOperations.ts`, against the
  operation actually in progress, and is covered by a test per direction.
- **The conflict state is read from the repository, never remembered.**
  `GET conflicts` exists so a conflict survives a page reload — someone can
  pull, conflict, close the tab, and come back to the same list.

"Is a rebase in progress" is `.git/rebase-merge` / `.git/rebase-apply` via
`rev-parse --git-path`, **not** `REBASE_HEAD`: git leaves `REBASE_HEAD` behind
after a rebase completes successfully, so testing it would make a repository
report itself conflicted forever. (Verified against real git, not assumed.)

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
| `server/handlers/__tests__/gitSyncRoutes.test.ts` | The branch list against a local bare remote (upstream, ahead/behind, a `gone` upstream, `origin/HEAD` excluded), commit-and-switch and its dirty-remainder refusal, fetch/pull against a second working copy of the same bare remote, the `diverged` and `dirty-tree` refusals, a REAL conflicted rebase and merge — including that “Keep mine” keeps the user's bytes in BOTH — continue/abort, and the same rejection set as `git.test.ts` |
| `server/handlers/__tests__/projectWriteLock.test.ts` | Ordering (a save and a commit resolve in arrival order, FIFO), the `busy` refusal and its path-free message, per-project isolation, the symlink key, reentrancy across a subprocess wait |
| `server/handlers/__tests__/git.test.ts` | End-to-end against real git: edit → status → diff → branch → commit → **push to a local bare remote**. Plus the rejections: dir outside the workspace, a project with no `.git` (never Studio's own repo), the workspace root itself, unusable paths in every path-taking route, dirty-tree switch refusal, empty commit, push with no origin, no filesystem path in an error body |
| `server/ai/mcp/tools/studio/gitTools.test.ts` | The capability declaration (invisible with `studio.write` alone, invisible without `ai.tools.write`) and the tool's own refusals |
| `src/__tests__/studio/gitDiffLines.test.ts` | Unified-diff line numbering, `---`/`+++` not read as content, hunk-header counter resets, the no-newline marker |

---

## Still not here

Rewritten after G3–G6: fetch, pull, conflicts, the branch list and the agent's
push/branch/status/PR tools all shipped, so the old list described a product
that no longer exists. What remains out of scope, and why:

- **Stage/unstage as separate actions.** A commit stages exactly what it
  commits. A staging area the user can get out of sync with the tick-boxes on
  screen is a second source of truth for "what am I about to commit".
- **Rolling the whole project back to a commit.** Restore is per-file,
  deliberately — a whole-tree reset is the one git operation whose blast radius
  a designer cannot see on the canvas beforehand.
- **`reset`, `clean`, `stash`, and any form of force push.** No route builds
  them, and the route surface *is* the allowed command set.
- **Cherry-pick, revert, tags, submodules, LFS.** Nobody has asked; each is a
  new vocabulary rather than a new button.
- **A three-way merge editor.** Conflict resolution is whole-file (*Keep
  mine* / *Keep theirs* / *Open in code*). Hunk-level resolution needs a real
  merge view, which is a feature of its own — see "Why the diff view is not
  CodeMirror" for the constraint it would have to clear.
- **A durable per-file record of which changes an agent authored.**
  `agentAuthored` is still scoped to the most recent turn; see above.
- **Any push a human did not click** — except the explicit agent tool
  `studio_git_push`, which is gated behind `studio.git.write`, a capability
  that is not granted to the built-in Admin role. Granting it *is* the human's
  click, made once instead of every time.
