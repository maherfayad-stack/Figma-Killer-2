# Studio preview deploys

**Status:** v1 (W5-4). **Needs human dogfooding** against a real project with a
real Vercel or Netlify account before it is trusted for daily use — a real
deploy cannot run in CI (see [Tests](#tests)).

Git is Studio's publish verb ([`studio-git.md`](studio-git.md)); this is the
step after it. A designer who has committed a change should be able to hand
somebody a URL without leaving the tool. v1 is exactly that and nothing more:
**build the project, deploy a preview from the current working tree, show the
URL.**

---

## The shape

| Layer | Module | Owns |
|---|---|---|
| Route | `server/handlers/studio/deploy.ts` | Dir resolution, body validation, **the trust-tier gate** |
| Jobs | `server/handlers/studio/deployJobs.ts` | The check → build → deploy pipeline, the in-memory job registry, the persisted record |
| Knowledge | `server/handlers/studio/deployProviders.ts` | Provider detection, the allowed argv per provider, reading the CLIs' output back. Pure. |
| Subprocess | `server/handlers/studio/deployRunner.ts` | `Bun.spawn` discipline, env allowlist, timeouts, containment |
| Persisted shape | `server/handlers/studio/deploySchema.ts` | `LastDeploy`, the additive `.studio/meta.json` field |
| Wire contract | `src/admin/pages/site/studio/deployRequests.ts` | TypeBox schemas + `apiRequest` calls |
| Panel | `src/admin/pages/site/panels/GitPanel/DeploySection.tsx` + `useDeployState.ts` | The Deploy section inside the Version control panel |

There is **no agent tool in v1**, matching `studio_git_push`'s absence for the
same reason: publishing to a URL other people can open stays a human's
decision even when the human has delegated everything before it.

---

## Routes

All under `/admin/api/studio/deploy`.

| Method | Path | Body / query | Success |
|---|---|---|---|
| GET | `deploy/status` | `?dir` | `{ trust, requiredTrust, canDeploy, gateMessage, detection, providers, job }` |
| POST | `deploy` | `{ dir?, provider, confirm: true }` | `{ jobId }` |
| GET | `deploy/:id` | `?dir` | the job: `{ status, phase, url, branch, dirty, message, log, truncated, … }` |

`canDeploy: false` is a **normal 200**, not an error — it is what lets the panel
explain the trust tier instead of rendering a button that refuses on click.
`providers` (the per-CLI install/auth/link probe) is `null` below the gate:
probing spawns the CLI, and a project whose code the user has not consented to
run does not get subprocesses spawned on its behalf. `detection` is three
`existsSync` calls and is always answered.

A refusal answers **409** with `{ error, code }` — currently one code,
`trust-tier-required`. Anything rejected by the containment guard answers a
bare **404**.

---

## The gate

**Tier 2 (`run-project`), no exceptions.** Deploying builds the project, and a
build runs the project's own code — `vite.config.ts`, every plugin it loads,
every script the build reaches. That is a strictly higher bar than the Tier 1
`componentBundle.ts` and `styleCompile.ts` require: those build a bounded set of
package components, this builds and then **publishes** the whole app.

`meta-03` decision 1 fixes a fresh import at Tier 0 and never auto-promotes, so
the panel's job below the gate is to say so honestly. Promoting to Tier 2 is
deliberately **not** a button in this section: it is the consent that lets
Studio execute the repository, and it should not sit one click away from
"Deploy".

---

## The flow

Three steps, in order, each a separate subprocess:

1. **check** — `vercel whoami` / `netlify status`. Reads local state, changes
   nothing, answers in seconds. It exists so the two failures that are not the
   user's code — the CLI is not installed, or nobody is signed in — are reported
   with the exact command that fixes them instead of after a five-minute build.
2. **build** — `vercel build` / `netlify build`. The project's own build, run by
   the provider's CLI rather than by a package-manager script Studio picked:
   both CLIs read the project's own framework config to decide what "build"
   means and where the output goes, so a hand-rolled `npm run build` would
   produce a directory neither CLI knows how to publish without Studio also
   guessing a publish path.
3. **deploy** — `vercel deploy --prebuilt` / `netlify deploy`. Uploads what step
   2 built, as a preview (Netlify calls it a draft).

The job is polled, never awaited inside a request — a deploy is minutes, the
same reason `installDeps.ts` is a job. The phase is reported rather than
inferred from a log, because a build failure and an upload failure are different
problems.

### Provider detection

| Signal | Meaning |
|---|---|
| `vercel.json` / `netlify.toml` | The project declares this provider |
| `.vercel/project.json` / `.netlify/state.json` | The directory is **linked** to a remote project |

One provider present → that one is offered. **Neither or both** → both are
offered with a note saying nothing was detected. Studio never picks between two
configured providers: deploying to the wrong one publishes under a URL somebody
else's DNS points at.

Detection runs against the project's **app root** (`resolveAppRoot`), because in
a monorepo import the config sits beside `package.json`, not at the project
directory.

---

## Safety rails

Every one is enforced **server-side**. As with git, the route surface *is* the
allowed command set.

- **No production deploys.** No argv in `deployProviders.ts` carries `--prod`,
  and no request field reaches an argv, so there is no input that could produce
  one. The gate test asserts this on the recorded argv of a full run.
- **No credentials, anywhere.** Studio stores no provider token, accepts none on
  this wire, and passes none to the subprocess: `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` are
  deliberately **absent** from the env allowlist even though both CLIs would
  honour them. The CLI's own login on this machine is the credential; when it is
  missing, the answer is the login command to run in a terminal.
- **No environment variables.** A deploy that needed a secret would need Studio
  to hold it. The project's own provider settings are the only source of
  build-time configuration.
- **No arbitrary arguments.** Argv arrays only, built from constants. No shell
  anywhere in this feature.
- **Studio never links or creates a remote project.** `vercel link` /
  `netlify link` create or attach a resource under the user's account; the panel
  shows the command and stops.
- **Containment.** The CLI's `cwd` must be a real directory under
  `studio-workspace/`, checked on the symlink-resolved real path, and never the
  workspace root itself (`assertWithinWorkspace`, reused from `gitRunner.ts` —
  it is a general project-directory guard that happened to be needed for git
  first). Unlike git, a project does **not** need its own `.git`: previews of a
  project nobody has version-controlled are legitimate.
- **`stdin: 'ignore'` is load-bearing.** Both CLIs prompt when a directory is
  unlinked; a prompt in a process with no terminal would block until the
  timeout. With stdin at EOF the prompt fails immediately and the CLI prints the
  real instruction, which is what the panel surfaces.
- **Bounded.** 30 s for the probe, 10 minutes each for the build and the upload;
  output capped at 200 kB per stream. Errors elide the workspace root before
  reaching a browser.

### Dirty trees are allowed

A preview of work in progress is the point, so uncommitted changes do **not**
refuse. The branch and the change count are shown next to the button and
recorded on the job, so "which of my edits is that URL showing?" has an answer.

---

## What is persisted

`.studio/meta.json` gains one additive optional field, `lastDeploy`
(`deploySchema.ts`'s `LastDeploySchema`): provider, status, URL, branch, dirty
flag, timestamps, and a one-line message. Written at the start and the end of
every deploy.

It carries **no log** — `meta.json` is a small, hand-editable settings sidecar,
not a place for a 200 kB CLI transcript. The log lives in the in-memory job for
as long as the process does.

That one record does two jobs: it is what the panel shows when a project is
reopened days later ("last preview: …"), and it is the restart-durability net.
A record found `'running'` with no live job resolves to `'interrupted'` and is
written back — never a phantom `'running'` a client would poll forever. Same
reconciliation, same reason, as `installDeps.ts`'s `resolvePersistedJobStatus`.

---

## The panel

The **Deploy** section at the bottom of the Version control panel — not its own
rail entry, because it is the end of the same sentence: *branch → what changed →
commit → push → **see it live***. The branch and dirty count it reports are the
ones the panel already has on screen.

It sits outside the panel's `isRepo` branch: a project nobody has put under
version control can still be deployed, and hiding the section there would be a
gate the server does not have.

The URL renders as a plain external link plus a copy button. So does each
blocking command (`vercel login`, `netlify link`) — Studio shows the command and
never runs it.

---

## Tests

`server/handlers/__tests__/deploy.test.ts`.

**A real deploy cannot run in CI**: it needs a CLI installed, a logged-in
account, a linked remote project, and the network. Pretending otherwise would be
the worst kind of green test. So the suite covers everything up to and including
the subprocess boundary and stops there:

| Covers | How |
|---|---|
| Provider detection | Real temp projects: config only, linked only, neither, both |
| Preview URL parsing | **Verbatim captured CLI transcripts.** Asserts the parser takes Vercel's `Preview:` line rather than the `Inspect:` dashboard link above it, and Netlify's draft URL rather than its `Build logs:` link — the trap a positional "first https://" match falls into. Plus ANSI-coloured output and the "no URL printed" case |
| Auth probe parsing | Signed in / signed out for both CLIs, including Netlify's signed-out case that still exits 0 |
| The capability gate | Through the **route**: Tier 0 and Tier 1 both 409 with `trust-tier-required`; the status route reports the gate as data and probes no CLI below it |
| Route validation | Missing/false `confirm`, unknown provider, `dir` outside the workspace, the workspace root itself, unknown job id |
| The whole pipeline | Against a **fake CLI** injected through the `spawn` seam: the exact argv of each phase in order (asserted to contain no `--prod`), the parsed URL, the `.studio/meta.json` record, and the three failure paths (not signed in → build never runs; build fails → nothing is deployed; success with no URL → said honestly) |

---

## Not in v1

- Production deploys. Not a missing feature — a deliberate absence, with no
  route and no argv that could express one.
- Any provider other than Vercel and Netlify.
- Environment variables, secrets, or build settings of any kind.
- Linking, creating, or renaming a remote project.
- Deploy history. One record per project, overwritten each time.
- An agent tool. Same reasoning as `studio_git_push`'s absence.
- Rollback, promotion of a preview to production, or deleting a deploy.
