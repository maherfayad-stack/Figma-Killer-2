# Studio git integration
> **Purpose:** version control against the project's own repository, GitHub sign-in, the agent commit tool · **Read when:** touching the Git panel or git routes · **Trust:** current · **Owner:** server-engineer · **Verified:** not yet

**Status:** v1 (W4-3). **Dogfooded against a real private github.com repository**
by `tests/e2e/github-sync.e2e.ts` (the G8 script from `git-22`), which creates a
throwaway repo per run and checks every claim against GitHub itself as well as
against the panel. Fourteen of its seventeen cases pass; the three that do not
are one defect outside this feature — see "What the G8 dogfood found" below.

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
| Route | `server/handlers/studio/gitSyncRoutes.ts` | Branches, commit-and-switch, fetch, pull, conflicts, pull requests — a sibling sub-router. Both files are routing only: dir resolution, body validation, refusal → HTTP status. **No argv is built in either.** |
| Operations — local | `server/handlers/studio/gitOperations.ts` | status, diff, log, branch, commit, push, init, restore, remotes — and the shared vocabulary: `GitOperationFailure`/`gitFailure`, `withGitWriteLock`, `originAcceptsStoredGithubToken` |
| Operations — remote | `server/handlers/studio/gitSyncOperations.ts` | The branch LIST, commit-and-switch, fetch, pull, conflicts, pull-request context. Split on responsibility: everything here is about reconciling with `origin`, or proposing the result to the people behind it |
| Subprocess + guard | `server/handlers/studio/gitRunner.ts` | `Bun.spawn` discipline, env allowlist, the "is this the project's own repository" guard, the one-shot credential handover |
| Credential handover | `server/handlers/studio/gitAskpass.ts` | The one-shot `GIT_ASKPASS` script and the token charset it refuses |
| Write lock | `server/handlers/studio/projectWriteLock.ts` | One writer per project — saves, scaffolds, installs and git verbs |
| Parsers | `server/handlers/studio/gitOutputParse.ts` | git's stdout → typed structures: `--porcelain=v2 --branch -z` status, `remote -v`, `log --format=…`, `for-each-ref`. Pure, and CRLF-safe through `splitLines`/`toLf` (see [docs/server.md](../server.md) → "Line endings — subprocess output"). |
| Input judgement | `server/handlers/studio/gitPaths.ts` | Every caller-supplied path, branch name, sha, message, **remote URL** |
| Remotes + clone | `server/handlers/studio/gitRemoteRoutes.ts` | `git/remotes`, `git/remote`, `git/clone` |
| Clone job | `server/handlers/studio/gitClone.ts` | Target derivation, refusals, partial-clone cleanup, the polled job store |
| GitHub sign-in | `server/handlers/studio/githubAuthRoutes.ts` | `/admin/api/studio/github/*` — device flow, PAT paste, account, sign-out, repo list |
| Device grant | `server/handlers/studio/githubDeviceFlow.ts` | The OAuth device flow and its in-memory pending-flow store |
| GitHub REST | `server/handlers/studio/githubApi.ts` | `GET /user`, `GET /user/repos`, validated with TypeBox |
| Pull requests | `server/handlers/studio/githubPullRequest.ts` | `POST /repos/{owner}/{repo}/pulls`, the compare URL, and the no-token answer |
| Credential store | `server/handlers/studio/githubCredentialStore.ts` | The `git_credentials` table; encryption on write, decryption on read |
| Token lookup | `server/handlers/studio/githubToken.ts` | `getGithubTokenForUser(userId)` / `getGithubTokenForRequest(req)` — the one shared entry every network verb calls |
| Wire contract — local | `src/admin/pages/site/studio/gitRequests.ts` | TypeBox schemas + `apiRequest` calls for the local verbs and the GitHub sign-in namespace |
| Wire contract — remote | `src/admin/pages/site/studio/gitSyncRequests.ts` | The same, for branches, commit-and-switch, fetch, pull, conflicts and pull requests |
| Panel | `src/admin/pages/site/panels/GitPanel/` | The rail panel: repository, branch, changes, diff, commit, push, history |
| Panel — branch | `.../GitPanel/BranchSection.tsx` | The branch dropdown, “New branch from current”, the commit-and-switch dialog |
| Panel — sync | `.../GitPanel/SyncSection.tsx` | Fetch, pull, push, the rebase-or-merge choice, per-file conflict resolution, “Open PR” |
| Agent tools | `server/ai/mcp/tools/studio/gitTools.ts` | `studio_git_status` (a read) plus `studio_git_branch`/`commit`/`push`/`open_pr`, gated by `studio.git.write` |

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
| GET | `remotes` | `?dir` | `{ remotes: [{ name, fetchUrl, pushUrl }] }` |
| POST | `remote` | `{ dir?, set: { name: 'origin', url } }` | `{ ok, remote }` |
| POST | `clone` | `{ url }` | `{ jobId }` |
| GET | `clone/status` | `?jobId` | `{ job }` — phase + the terminal `ImportSummary` |
| GET | `branches` | `?dir` | `{ branches: [{ name, remote, current, upstream, ahead, behind, upstreamGone }], current, defaultBranch }` |
| POST | `commit-and-switch` | `{ dir?, message, files, switch }` | `{ ok, sha, shortSha, files, branch }` |
| POST | `fetch` | `{ dir? }` | `{ ok, output }` |
| POST | `pull` | `{ dir?, strategy?: 'ff-only' \| 'rebase' \| 'merge' }` | `{ ok, strategy, output }` |
| GET | `conflicts` | `?dir` | `{ kind: 'rebase' \| 'merge' \| null, files }` |
| POST | `conflict/resolve` | `{ dir?, file, side: 'mine' \| 'theirs' }` | `{ ok, file, side }` |
| POST | `conflict/continue` | `{ dir? }` | `{ ok, kind }` |
| POST | `conflict/abort` | `{ dir?, confirm: true }` | `{ ok, kind }` |
| GET | `pull-request/context` | `?dir` | `{ supported, base, head, compareUrl, isDefaultBranch }` |
| POST | `pull-request` | `{ dir?, title?, body?, base? }` | `{ ok, url, number, compareUrl }` |

`isRepo: false` is a **normal 200**, not an error — it is what makes the panel
offer "Create a repository" rather than showing a failure for a project nobody
has put under version control yet.

A refusal based on the repository's *state* (dirty tree, no `origin`, detached
HEAD, repository already exists, another writer holds the project write lock)
answers **409** with `{ error, code, dirtyFiles? }`. A git invocation that
actually failed answers **500**. Anything rejected by a guard answers a bare
**404**.

### Connecting a repository

`POST git/remote` writes **`origin` and only `origin`** — `name` is a
`Type.Literal('origin')` on the wire, so another name is refused by the schema
rather than by a handler branch. `GET git/remotes` reports **all** of them,
including ones Studio did not write: a panel that quietly disagrees with the
user's terminal is the failure `excludedCount` exists to avoid elsewhere.

**Every URL that route returns has its credential stripped first**
(`redactRemoteUrlCredentials`, `gitOperations.ts`, applied inside
`readRemotes` so `setOriginRemote`'s response inherits it too). Studio's own
`setOriginRemote` re-composes through `parseGithubRemoteUrl` and never writes
a credential into a remote — but a repository cloned OUTSIDE Studio routinely
carries one, and `git remote -v` prints `.git/config` verbatim:
`https://x-access-token:<token>@github.com/o/r` is what a GitHub Actions
checkout leaves behind, `https://<pat>@github.com/o/r` what a token-pasted
`git clone` leaves behind. `git/remotes` is a `site.read` route, so without
this the **Client** role could read that token out of a repository the
operator imported (`sec-16`'s informational finding). For `http`/`https` the
whole userinfo goes, because a token with no password half is the commonest
shape; for `ssh://` only the password does, since `git@` is the SSH account
and removing it would make the panel disagree with the terminal. The scp-like
`git@github.com:o/r.git` has no userinfo syntax and is untouched.

**The URL is the widest-blast-radius input in this feature**, because git takes
a *transport*, not an address: `ext::sh -c …` executes a shell command,
`file://` and a bare path make a "remote" out of any directory on this server
(Studio's own repository included), and `ssh://user@host/…` reaches wherever
the host's keys reach. `parseGithubRemoteUrl` is therefore an allowlist of
exactly two shapes — `https://github.com/<owner>/<repo>` and
`git@github.com:<owner>/<repo>.git` — and the URL handed to git is
**re-composed from the parsed owner/repo**, never the caller's string. Userinfo
(`https://user:pass@…`) is refused: it would persist a credential in plaintext
into `.git/config`.

`<owner>` and `<repo>` are judged by `isGithubOwnerSegment` /
`isGithubRepoSegment` (`studio/gitPaths.ts`), not by a bare charset test. The
charset `[A-Za-z0-9_.-]` excludes `/`, `:`, `@`, whitespace and control
characters, but it does **not** exclude `.` or `..` — which are path
instructions, not names — so the SSH form used to accept
`git@github.com:../repo.git` and the HTTPS form was only saved by `new URL`
normalising the pathname (`sec-13`, informational). The rule now refuses a
dots-only segment, a leading or trailing `-` on an owner, a leading `-` on a
repository (which would make the derived `<owner>-<repo>` project folder name
argv-flag-shaped), and anything past GitHub's own ceilings of 39 and 100
characters. `.github`, `socket.io` and `my_org` still parse. The zipball
import's `parseGithubRepoUrl` (`server/handlers/studioGithubImport.ts`) calls
the same two functions, so the two entry paths cannot disagree about what a
repository is called — and, since `sec-15`, it refuses userinfo for the same
reason this parser does, rather than accepting a URL carrying a credential and
silently dropping it.

`POST git/clone` is the **Clone (keeps history)** alternative to the zipball
import, as a polled job with the same shape and the same terminal
`ImportSummary`. `git clone --filter=blob:none` — a partial clone, so a
repository with a decade of large assets does not become a gigabyte on disk to
show forty screens. Its guards:

- the target is **`studio-workspace/<owner>-<repo>`, derived server-side** from
  the parsed URL. The body schema is `additionalProperties: false` and has no
  `dir`, so a request carrying one is *rejected*, not ignored;
- containment is checked before the clone (on the deepest existing ancestor,
  via `isRealpathContainedAllowingMissing`) **and again on the real path
  afterwards** — a repository can carry git-stored symlinks;
- **an occupied directory refuses (409 `project-exists`)**. Unlike the zipball
  import, a clone never clears its target: `git clone` needs an empty
  directory, and making one by deleting a project is deleting user data to
  satisfy a button;
- a clone that fails removes its own partial directory — but only when this job
  is what created it, so a refusal caused by a pre-existing project can never
  delete that project;
- the credential is the signed-in user's, resolved from the session. There is
  no `token` field on this wire either.

### Signing in to GitHub

A second namespace, `/admin/api/studio/github/`. **Every route here requires a
session** — unlike the rest of `/admin/api/studio/*` — because a credential
belongs to an account, and `git_credentials` is keyed by user id. The three
state-changing ones (`POST device/start`, `POST token`, `DELETE token`)
additionally go through `originAllowed`, the same CSRF origin check the CMS and
AI route families apply: `SameSite=Lax` stops a cross-site POST from carrying
the session cookie, and this closes the same-site-different-subdomain case,
which matters more here than anywhere else on this surface because a forged
`POST token` would plant an attacker's credential under the operator's account.

| Method | Path | Body / query | Success |
|---|---|---|---|
| POST | `device/start` | — | `{ flowId, userCode, verificationUri, expiresInSeconds, intervalSeconds }` |
| GET | `device/poll` | `?flowId` | `{ status: 'pending' \| 'authorized' \| 'denied' \| 'expired', retryInSeconds, account }` |
| POST | `token` | `{ token }` | `{ account }` — the paste-a-PAT fallback |
| DELETE | `token` | — | `{ ok: true }` — idempotent |
| GET | `account` | — | `{ account: … \| null, clientConfigured }` |
| GET | `repos` | — | `{ repositories: [{ fullName, cloneUrl, isPrivate, defaultBranch, pushedAt }] }` |

`account` is `{ login, avatarUrl, scopes, expiresAt, createdAt }`. **No response
body in this namespace ever contains a token**, and `GET account` does not
decrypt one — it reads the row's metadata plus an in-memory identity cache, so
opening the panel neither puts plaintext in memory nor spends a GitHub call.

`device/start` answers **501** when the server has no
`GITHUB_OAUTH_CLIENT_ID`, with a message naming the paste fallback — that is a
configuration state, not a failure. A poll for a `flowId` that was never issued,
has already finished, **or belongs to another account** is an identical
**404**: distinguishing them would confirm the existence of someone else's
sign-in.

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
  would be the surprising option. *Names* them literally: `dirtyFiles` was
  always on the wire, but the **message** — the only field `apiRequest`
  surfaces to the browser — used to read "these files are still uncommitted",
  which is not something a user can act on without leaving Studio for a
  terminal. It now spells out up to four paths and summarises the rest.
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
- **A pull that STOPS still reports what it did.** A conflicting pull leaves a
  rebase in progress and unmerged files on disk, so `SyncSection`'s failure
  path re-reads the conflict state as well as git status. Without that the
  panel said "Rebase failed" and showed nothing to act on until the user closed
  and reopened it — the per-file *Keep mine / Keep theirs / Continue* list is
  the whole point of the feature, and it was one bumped nonce away from being
  unreachable (found by the G8 dogfood).
- **`continue` refuses in Studio's words, not git's.** `git rebase --continue`
  rejects a repository where any tracked file has unstaged changes — including
  files that had nothing to do with the conflict — and says *"You must edit all
  merge conflicts and then mark them as resolved using git add"*, which is
  written for a terminal and is not even true by then. So
  `continueConflictResolution` reads status first and answers a named
  `409 dirty-tree` listing the files. The read is `readGitStatus`, **not**
  `git diff --name-only`: measured mid-rebase, porcelain reported
  ` M prototype/registry.generated.jsx` while `git diff --name-only` reported
  nothing at the same instant, and `rebase --continue` agreed with porcelain.
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

**Studio reads no git credential from its environment.** That rule has not
changed and will not. What changed in G2 is that a user may now *sign in*, and
the token they sign in with is stored per user, encrypted.

- **Where it lives.** `git_credentials` (migration `023_git_credentials`, both
  dialects): one row per `(user_id, provider)`, `ciphertext` + `iv` from
  `server/secrets/encryption.ts` (AES-256-GCM under the process master key —
  the same pair `ai_provider_credentials` uses). Signing in again replaces the
  row. There is no `key_fingerprint`: a token that will not decrypt is deleted
  and the user is asked to sign in again, because that takes ten seconds and a
  rotation state would not.
- **How it reaches git — and how it does not.** Not the environment (a
  subprocess env is inherited by everything it spawns and is readable from
  `/proc/<pid>/environ`), and not the remote URL (that is argv, world-readable
  in the process table, and git echoes remote URLs into its own error
  messages). Instead `runGit`'s `credential` option writes a **one-shot `sh`
  script** to a fresh temp directory, points `GIT_ASKPASS` at it, and deletes
  the directory in a `finally` — so the token cannot outlive the single
  invocation it was written for. The script answers `x-access-token` to the
  Username prompt and the token to anything else. The `#!` line is what makes
  one script work on all three platforms: Git for Windows resolves the
  interpreter itself and runs the file through its own bundled `sh`.
- **The askpass script's 0600/0700 modes are a POSIX guarantee only.** On Windows Node maps
  `mode` onto the read-only attribute and nothing else — the script and its
  directory report `666` however they were asked for. What keeps the token
  private there is `%TEMP%`'s ACL (`C:\Users\<user>\AppData\Local\Temp` admits
  only that account), which is an assumption about the host rather than
  something Studio enforces: an operator who points `TMP`/`TEMP` at a shared
  directory makes the script readable to other local accounts for the length of
  one git invocation. `dispose()` is what bounds that window.
- **The token is embedded in single quotes, and a token that could escape them
  is refused** (`isEmbeddableGitToken`: `[A-Za-z0-9_]{8,255}`, which every
  GitHub token format satisfies). Refused, not escaped — an escaping bug there
  is arbitrary code execution as the server user. The paste route applies the
  same check *before* it calls GitHub.
- **`-c credential.helper=` is prepended** when a credential is supplied, so a
  stale cached helper credential cannot answer first and make the sign-in the
  user just performed appear to have done nothing.
- **Which routes use it.** Only the ones that cross the network: `clone`,
  `push`, `fetch`, `pull`, and the pull-request call. Each resolves it from the
  **session** (`getGithubTokenForRequest`) — there is deliberately no `token`
  field on any of those wires, so no request and no proxy log can carry one.
  Nobody signed in is a normal state: git then falls back to the host's own
  credential helper or ssh-agent, exactly as before.
- **Only a github.com remote is ever offered the token.** An askpass program is
  handed a *prompt*, not a destination it can refuse — the script answers
  whatever host git dialled. So the decision is made before the script exists:
  `gitClone.ts` only ever has a `parseGithubRemoteUrl`-allowlisted URL, and
  **every** verb that dials `origin` — `push`, `fetch` and `pull` — reads
  `origin`'s push URL through that same allowlist
  (`originAcceptsStoredGithubToken`, imported, never re-derived) and drops the
  credential when it does not pass. This matters because `origin` is not always
  Studio's: `setOriginRemote` writes only allowlisted URLs, but a project can
  arrive with a `.git` the user pointed at a company host, a mirror, or an
  `ext::` transport in their own terminal. A non-GitHub origin is not an
  error — the verb simply proceeds with the pre-G2 fallback.
- **`GIT_TERMINAL_PROMPT=0` stays**, credential or not — the askpass script
  answers without a terminal, and without the flag a remote needing a password
  would block on a read nobody will answer.
- **Nothing is logged.** `clientSafeGitError` additionally elides the host's
  temp root now, so a failure to exec the askpass script cannot name a
  filesystem path in a browser message.
- **Every state-changing route on this surface runs `originAllowed`** — the
  credential-writing GitHub routes, and `gitSyncRoutes.ts`'s POSTs (`fetch`,
  `pull`, `commit-and-switch`, the conflict verbs, `pull-request`).
  `SameSite=Lax` already stops a POST from an unrelated origin from carrying the
  session cookie; this closes the same-registrable-domain case it does not
  cover, which matters because a forged `pull` rewrites a working tree and a
  forged `pull-request` publishes a proposal under the user's GitHub identity.

**A note for anyone writing a test here.** A network git call with **no**
credential invokes the host's credential helper, and on Windows that is Git
Credential Manager — which opens a GUI dialog and blocks for the full
`GIT_NETWORK_TIMEOUT_MS`. Every fixture that pushes, fetches or pulls must set
`credential.helper=` (an empty value clears the list) and use a **local bare
repository reached by path**, as `git.test.ts` and `gitSyncRoutes.test.ts` do.

The **scope requested is `repo` and nothing else** — never `workflow`, which
would let a token rewrite `.github/workflows/*` and is arbitrary code execution
on the user's CI. The panel shows the scopes GitHub actually granted, read back
off the token, rather than the ones that were asked for.

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
repository → branch → what changed → what it changed → say what you did →
send it.

- **Repository** (`RepositorySection.tsx`) is the top block and sits *outside*
  the `isRepo` branch: signing in is worth doing before `git init`, and a
  project with no repository yet is exactly the one about to need a remote. The
  device flow is the default — a short code, a URL, and a poll keyed on a
  `waiting` state, the same shape `ProvidersTab.tsx` uses for the Claude login.
  "Paste a token instead" opens automatically when the server reports
  `clientConfigured: false`, or when `device/start` answers 501. Below the
  account it shows `origin` and offers **Connect** — paste a URL, or, once
  signed in, **Pick from your repositories** (`GET github/repos`). Connecting
  refreshes the panel's status read, because `hasOrigin` is what enables Push.
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

### Opening a pull request

The last step of the publish sentence, and the only place Studio asks GitHub to
create something. It is two routes, and the split is the point:

- **`GET pull-request/context`** answers "should this panel offer to open a PR
  at all, and what would it compare?" — `{ supported, base, head, compareUrl,
  isDefaultBranch }`. `supported: false` is a normal 200 for a project with no
  `origin`, an `origin` that is not GitHub, or a detached HEAD; the same
  posture `status`'s `isRepo: false` takes. Because the compare URL comes from
  here, **no browser code parses a remote URL and none reads a field off an
  error body**.
- **`POST pull-request`** is then one click. `base` defaults to `origin/HEAD`,
  `title` to the last commit subject, `body` to the commit list
  (`origin/<base>..<head>`, so it lists what the reviewer does not already
  have). A designer who has just pushed a branch should not have to compose
  anything.

The button appears once the branch **has an upstream** (it has been pushed) and
**is not the base branch**. The compare link sits beside it either way.

**With no connected GitHub account the answer is `409 { code:
'no-github-token', compareUrl }`**, and the panel says "Sign in to GitHub to
open a PR" with the link still there. A link is a worse product than a button
and a much better one than a dead end. Nothing is attempted anonymously — the
request is not sent at all.

`owner`/`repo` come from `gitPaths.parseGithubRemoteUrl`, the same re-composing
allowlist `POST git/remote` validates a URL with; there is one definition of
"is this a GitHub remote" in this feature. The token comes from
`getGithubTokenForRequest` — the requesting user's session and nothing else —
appears only in an `Authorization` header, and is in no message, no URL and no
log. GitHub's own refusal ("A pull request already exists", "No commits between
main and feat/x") is passed through verbatim: it names a repository, never this
server's filesystem. A GitHub that answered 5xx or could not be reached is a
**502**, not a refusal, because retrying is the right next action.

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

## The agent tools

Five, and together they are the whole publish sentence: **`studio_git_status`
→ `studio_git_branch` → `studio_git_commit` → `studio_git_push` →
`studio_git_open_pr`**.

v1 stopped at commit and said so: push "publishes to a remote other people
read, and stays a human's decision". **That reasoning was about the wrong
click.** The decision a human has to make is not "press push this one time" —
it is "may this connector publish on my behalf at all", and that decision
already exists, exactly once, as the `studio.git.write` grant below. Asking for
it again per call bought no safety; it bought an agent that could build a
branch and then not ship it. A pull request is where the sentence ends, which
is the right shape: a proposal a human reviews.

What an agent still does **not** get, and these are not oversights:

- **`init`** — creating a repository is a one-time structural choice about the
  user's project that an agent has no basis for making.
- **`restore`, `pull`, `merge`, `rebase`, conflict resolution** — every one can
  overwrite work the user has on screen and cannot see being overwritten. The
  panel's conflict list exists precisely because a human has to look at those.
- **Force push, reset, clean, stash** — no route builds them, so no tool can
  reach them.

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

None of the five is in `STUDIO_AGENT_TOOL_NAMES`, so the **in-canvas** agent is
not offered them — they reach external MCP connectors (Claude Code, Codex, a
remote agent) only. That list is documented as a deliberate decision each time;
putting git into the in-canvas turn loop is a product call that has not been
made.

**`studio_git_status` is the one exception to the capability rule**, and
deliberately so. It is a read: it mutates nothing and reports paths the caller
can already list with `studio_list_files`. Gating it behind `studio.git.write`
would mean an agent could not tell the user what it had changed without also
being allowed to commit it, which is backwards. It declares no capability, like
every other read in the Studio family.

---

## Tests

| File | Covers |
|---|---|
| `server/handlers/__tests__/gitOutputParse.test.ts` | All four parsers against real captured output: renames spanning two NUL fields, paths with spaces, initial/detached/diverged branch headers, unmerged records, unknown record types; the two-line-per-remote fold; the `%x1e` log record shape; `%(HEAD)`, `gone`, and the excluded `origin/HEAD`. Plus a CRLF twin of each transcript — the `\r` lands on `%(HEAD)` and on the sha after every record separator, and both are silent |
| `server/handlers/__tests__/gitPaths.test.ts` | Every rejection: traversal on both separators, absolute/UNC/drive-letter paths, excluded directories, **symlink escape** (leaf and parent), flag-looking branch names, revision expressions where a sha is required |
| `server/handlers/__tests__/githubPullRequest.test.ts` | The GitHub call with an injected `fetch`: the token reaches the `Authorization` header and no other field, no token means a named refusal carrying the compare URL and NO request at all, GitHub's own message passes through, and 4xx/5xx map to different codes |
| `server/handlers/__tests__/gitSyncRoutes.test.ts` | The branch list against a local bare remote (upstream, ahead/behind, a `gone` upstream, `origin/HEAD` excluded), commit-and-switch and its dirty-remainder refusal, fetch/pull against a second working copy of the same bare remote, the pull-request context on both remote URL shapes and its `supported: false` states, the `diverged` and `dirty-tree` refusals, a REAL conflicted rebase and merge — including that “Keep mine” keeps the user's bytes in BOTH — continue/abort, and the same rejection set as `git.test.ts` |
| `server/handlers/__tests__/projectWriteLock.test.ts` | Ordering (a save and a commit resolve in arrival order, FIFO), the `busy` refusal and its path-free message, per-project isolation, the symlink key, reentrancy across a subprocess wait |
| `server/handlers/__tests__/git.test.ts` | End-to-end against real git: edit → status → diff → branch → commit → **push to a local bare remote**. Plus the rejections: dir outside the workspace, a project with no `.git` (never Studio's own repo), the workspace root itself, unusable paths in every path-taking route, dirty-tree switch refusal, empty commit, push with no origin, no filesystem path in an error body |
| `server/ai/mcp/tools/studio/gitTools.test.ts` | Every tool's capability declaration (each mutating one invisible with `studio.write` alone and without `ai.tools.write`; `studio_git_status` visible as an ordinary read), the exact tool list (no init/restore/pull), and each tool's refusals — including a real push to a local bare remote |
| `src/__tests__/studio/gitDiffLines.test.ts` | Unified-diff line numbering, `---`/`+++` not read as content, hunk-header counter resets, the no-newline marker |
| `tests/e2e/github-sync.e2e.ts` | **The G8 dogfood against a real private github.com repository** — the twelve steps a bare local remote cannot settle. Self-skips without `gh auth token`; creates and destroys its own scratch repo. See `docs/e2e/README.md` |

---

## What the G8 dogfood found

Everything G1–G7 promised holds against real GitHub: paste-a-token sign-in, a
*Keep history* clone of a private repository with its history and `origin`
intact, branching over a dirty tree without losing the uncommitted work, commit
+ push landing the exact sha on GitHub, a real pull request titled with the last
commit subject, `1↓` blocking Push with "Pull first", a fast-forward pull
putting GitHub's bytes on disk, `1↑ 1↓` producing the rebase-or-merge question
instead of a decision, a same-line conflict listed per file with *Keep mine*
writing the local text, Abort restoring the branch byte for byte, the write
lock's `busy` refusal leaving no `index.lock`, commit-and-switch keeping the
commit while refusing the switch by name, and sign-out leaving no usable
credential behind.

Three cases do not pass, and they are all the same defect, which lives **outside
this feature**: `loadStudioPages` calls `ensurePrototypeShell(dir)` on every
board open (`server/handlers/studioPageLoad.ts`), writing Studio's own runnable
preview shell — `prototype/`, `index.html`, `vite.config.js`, `package.json`,
plus four `*.generated.*` files — into the user's working tree. None of those
paths is in git's excluded set (`node_modules`, `dist`, `.next`, `.turbo`,
`.git`, `.studio`), so on a freshly cloned repository **16 paths the user never
touched are uncommitted the moment the board opens**, a successful pull
re-dirties the tree on its own reload, and `git rebase --continue` then refuses
because a tracked file has unstaged changes.

That is not a git-panel bug and the fix is not a line in this feature: whether
the preview shell belongs in the user's history, in their `.gitignore`, or in
git's excluded set is a decision for the prototype-shell owner. What this
feature does about it now is refuse *honestly* — see the `continue` bullet under
Safety rails.

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
