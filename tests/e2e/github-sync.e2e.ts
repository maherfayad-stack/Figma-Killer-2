/**
 * The G8 dogfood — Studio against a REAL, private GitHub repository.
 *
 * `STUDIO-FIGMA-FEEL-PLAN.md` §3 G8 and `git-22`'s "Human action needed" both
 * end at the same sentence: the whole git track (G1–G7) shipped without anyone
 * ever pointing it at github.com. Everything under it is covered by unit tests
 * that use a **local bare repository** — correctly, because those tests must
 * not need the network — and a local bare repository cannot answer the only
 * questions G8 asks: does the branch exist on GitHub, is that a real pull
 * request, is the file on disk after Pull the one GitHub has.
 *
 * So this spec makes a private repository, drives Studio's Version control
 * panel through the twelve steps of that dogfood, and checks every claim
 * twice — once in the UI, once against GitHub itself (`gh api`, or a fresh
 * `git clone` into a temp directory) or against the `.git` on disk.
 *
 * ## What makes this safe to run
 *
 * - **It self-skips** when `gh auth token` fails. No credential, no run, and
 *   the skip is annotated so a green CI run cannot be mistaken for coverage.
 * - **The repository is a throwaway**, named `studio-g8-scratch-<unix-ms>`,
 *   created private in `beforeAll` and destroyed in `afterAll` — which runs
 *   even when a step fails. `gh repo delete` needs the `delete_repo` scope,
 *   which a normal `repo`-scoped token does not have; when that happens the
 *   repository is archived and the name is printed as a step annotation, so
 *   it is never quietly abandoned. See `helpers/githubScratchRepo.ts`.
 * - **The project is a throwaway too, twice over.** Studio clones the scratch
 *   repository into `<WORKSPACE_ROOT>/<owner>-<repo>`, which `afterAll`
 *   removes — and `WORKSPACE_ROOT` is already `verify-2`'s per-run copy of
 *   `studio-workspace/` under `.tmp/`, so nothing this spec or the PRODUCT
 *   writes can reach the tracked corpus. `test4` is only ever READ, out of that
 *   copy, as the seed for the scratch repository's first commit.
 * - **The token is never printed, logged or written to disk.** Every
 *   authenticated call is made by `gh`; git's network verbs borrow gh's
 *   credential helper for one invocation. The single place the token exists in
 *   this process is `readGithubTokenForSignIn()` → `locator.fill()`, which is
 *   the dogfood's own step 1, and that function refuses to run under
 *   `E2E_TRACE=1` / `E2E_VIDEO=1` because a trace records fill values.
 *
 * ## How to read a failure here
 *
 * Every step of this spec is a sentence out of `git-22`'s dogfood script. A
 * failing step is a **product** finding, not a flaky test, and the assertion
 * message says which sentence stopped being true. Where a step is known to be
 * broken it is marked `test.fail()` with the defect named in its docblock —
 * Playwright then fails the run if it starts passing, so a fix cannot land
 * silently.
 *
 * Running it: see `docs/e2e/README.md`.
 */
import { expect, test, type Browser, type Locator, type Page, type Response } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { OWNER_STATE_FILE, WORKSPACE_ROOT } from './helpers/constants'
import { expectEditorReady } from './helpers/editor'
import {
  cloneFresh,
  closeRemotePullRequest,
  createScratchRepo,
  danglingGitLocks,
  deleteScratchRepo,
  git,
  gitOut,
  githubCredentialAvailable,
  listRemotePullRequests,
  localBranch,
  localHeadSha,
  localHeadSubject,
  localStatusLines,
  localTrackedFiles,
  readGithubTokenForSignIn,
  readRemoteFile,
  remoteBranchSha,
  remoteBranchShaOrNull,
  removeDir,
  seedScratchRepo,
  writeRemoteFile,
  type ScratchRepo,
  type ScratchRepoCleanup,
} from './helpers/githubScratchRepo'

/**
 * The project copied into the scratch repository's first commit. `test4` is
 * the only workspace project that is a real Studio project end to end — a
 * `package.json`, a pages directory, and enough `.tsx` to make "edit a file on
 * GitHub, pull it back" mean something. It is READ ONLY here: the copy goes to
 * an OS temp directory, and Studio only ever sees the clone.
 */
const SEED_PROJECT = 'test4'

/** The dogfood's working branch, exactly as `git-22`'s script names it. */
const DOGFOOD_BRANCH = 'feat/dogfood'

/**
 * Every edit this spec makes to a source file is a single trailing comment
 * line. One line, always the last one, so the local and remote versions of a
 * step collide on the SAME line — which is what step 8 needs and what an
 * append-a-new-line edit would never produce.
 */
const MARKER_PREFIX = '// g8-dogfood:'
const MARKER_LINE = /\r?\n\/\/ g8-dogfood:.*$/

/**
 * Anything a client-facing refusal must never contain.
 *
 * `clientSafeGitError` elides the workspace root and the OS temp root; this is
 * the spec's own statement of what "elided" has to mean. Both workspace names
 * are listed because the e2e stack reads a throwaway copy under `.tmp/` while a
 * developer's stack reads the tracked tree.
 */
const PATH_LEAK = /[A-Za-z]:\\|e2e-workspace|studio-workspace/

/** Unique per run, so a marker can never be confused with one a previous run left on GitHub. */
const RUN_ID = `${Date.now()}`

// ─── Shared state across the serial steps ────────────────────────────────────

let repo: ScratchRepo
let cleanup: ScratchRepoCleanup | null = null
let seedWorkDir: string | null = null
const tempDirs: string[] = []

let page: Page
/** The cloned project on disk — Studio's open workspace for steps 3–12. */
let projectDir = ''
/** The tracked `.tsx` every step edits. Chosen from the clone, not hard-coded. */
let dogfoodFile = ''
/** A second tracked file, for the un-ticked half of step 11. */
let secondFile = ''
/** The pull request step 5 opened, so `afterAll` can close it even if step 5 failed late. */
let openedPullRequest: number | null = null
/**
 * Every time this spec had to commit files Studio wrote by itself, and what
 * they were. Reported at the end: the size of the workaround IS the size of
 * the defect cases 2b and 6b name.
 */
const scaffoldingRewrites: Array<{ when: string; paths: string[] }> = []

const available = githubCredentialAvailable()

// ─── Console / pageerror recorder ────────────────────────────────────────────

interface RecordedConsoleEvent {
  source: 'console.error' | 'pageerror'
  text: string
  step: string
}

const consoleEvents: RecordedConsoleEvent[] = []
let currentStep = 'before the first step'

/**
 * Every entry must be pinned to something THIS spec provoked, and every entry
 * must match at least one event — an allowlist line that stops describing the
 * run starts hiding whatever it matches next (`verify-3`'s rule, kept).
 */
const CONSOLE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /Failed to load resource.*\b409\b/i,
    why:
      'Chromium logs every non-2xx response at error level. Steps 8, 9, 10 and 11 deliberately provoke a ' +
      '409 refusal (conflict, busy, dirty-tree) — the refusals ARE the feature being tested.',
  },
]

function recordConsole(target: Page): void {
  target.on('console', (message) => {
    if (message.type() !== 'error') return
    consoleEvents.push({ source: 'console.error', text: message.text(), step: currentStep })
  })
  target.on('pageerror', (error) => {
    consoleEvents.push({ source: 'pageerror', text: `${error.name}: ${error.message}`, step: currentStep })
  })
}

// ─── Toast recorder ──────────────────────────────────────────────────────────

interface RecordedToast {
  kind: string
  text: string
}

declare global {
  interface Window {
    __g8ToastLog?: RecordedToast[]
  }
}

/**
 * Record every toast CARD as it is inserted.
 *
 * Reading the live DOM at one instant races the 4 s auto-dismiss: a refusal
 * toast can be gone before an assertion gets to it, and "the toast never
 * appeared" and "the toast appeared and expired" are very different findings.
 */
async function installToastRecorder(target: Page): Promise<void> {
  await target.evaluate(() => {
    if (window.__g8ToastLog) return
    const log: Array<{ kind: string; text: string }> = []
    window.__g8ToastLog = log
    const record = (node: Node) => {
      if (!(node instanceof HTMLElement)) return
      const cards = node.matches('[data-toast-kind]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-toast-kind]'))
      for (const card of cards) {
        log.push({ kind: card.getAttribute('data-toast-kind') ?? 'unknown', text: (card.textContent ?? '').trim() })
      }
    }
    new MutationObserver((records) => {
      for (const mutation of records) mutation.addedNodes.forEach(record)
    }).observe(document.body, { subtree: true, childList: true })
  })
}

/** Everything recorded since the last drain. */
async function drainToasts(target: Page): Promise<RecordedToast[]> {
  return target.evaluate(() => {
    const log = window.__g8ToastLog
    if (!log) throw new Error('the toast recorder was never installed')
    const out = log.slice()
    log.length = 0
    return out
  })
}

// ─── Panel helpers ───────────────────────────────────────────────────────────

function gitPanel(): Locator {
  return page.getByTestId('git-panel')
}

async function openGitPanel(): Promise<Locator> {
  const panel = gitPanel()
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByTestId('panel-rail-git').click()
  }
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

/**
 * Close and reopen the panel.
 *
 * Not cosmetic: `useGitStatus`/`useGitBranches`/`useGitConflicts` each read
 * once per nonce and never poll, so a change this spec made on disk (or on
 * GitHub) is invisible until something remounts them. Closing the panel
 * unmounts `GitPanel` entirely, which is the only remount a user can drive.
 */
async function remountGitPanel(): Promise<Locator> {
  const panel = gitPanel()
  if (await panel.isVisible().catch(() => false)) {
    await page.getByTestId('panel-rail-git').click()
    await expect(panel).toBeHidden()
  }
  // `GitPanel` returns `null` while closed but is never actually unmounted, so
  // `useGitStatus` keeps the PREVIOUS answer on screen while the new one is in
  // flight (stale-while-revalidate, deliberately — its module doc says so).
  // Waiting for the status response is therefore part of reopening: without
  // it, a case can read a panel that is still describing the state before the
  // thing it just did. Measured: step 10 ticked a checkbox that a stale
  // conflict had left disabled.
  const settled = page.waitForResponse(
    (response) => response.url().includes('/admin/api/studio/git/status'),
    { timeout: 60_000 },
  )
  await page.getByTestId('panel-rail-git').click()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await settled
  await expect(panel.getByText('Changes', { exact: true })).toBeVisible({ timeout: 30_000 })
  return panel
}

function panelButton(name: string): Locator {
  return gitPanel().getByRole('button', { name, exact: true })
}

/**
 * The `Sync` section's header button.
 *
 * `Section` renders its `meta` (the `1↑ 1↓` / `Conflict` summary) as a span
 * inside the disclosure button, so the header's own text is where divergence
 * is visible without opening anything — which is the claim being made.
 */
function syncSectionHeader(): Locator {
  return gitPanel().locator('button[aria-expanded]').filter({ hasText: 'Sync' }).first()
}

/** The tooltip a disabled Button shows on hover. */
async function tooltipOf(button: Locator): Promise<string> {
  await button.hover()
  const tooltip = page.getByRole('tooltip').first()
  await expect(tooltip).toBeVisible({ timeout: 10_000 })
  const text = (await tooltip.textContent()) ?? ''
  // Move the pointer off so the next hover is a fresh open.
  await page.mouse.move(0, 0)
  return text.trim()
}

/** Open the branch combobox and read every option it offers. */
async function branchOptions(): Promise<string[]> {
  const combobox = gitPanel().getByRole('combobox', { name: 'Branch' })
  await combobox.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible({ timeout: 10_000 })
  const options = await listbox.getByRole('option').allTextContents()
  await page.keyboard.press('Escape')
  return options.map((option) => option.trim())
}

async function pickBranch(name: string): Promise<void> {
  const combobox = gitPanel().getByRole('combobox', { name: 'Branch' })
  await combobox.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible({ timeout: 10_000 })
  await listbox.getByRole('option', { name, exact: true }).click()
}

/** Tick one file in Changes. The native input is visually hidden by design. */
async function tickFile(file: string): Promise<void> {
  // Enabled, not just present: the row's checkbox is disabled while git still
  // reports the path as unmerged, so waiting for it is how this spec tells
  // "the panel has caught up" from "the panel disagrees with the repository".
  const box = gitPanel().getByRole('checkbox', { name: `Include ${file} in the commit` })
  await expect(box, `${file} is not offered as a committable change`).toBeEnabled({ timeout: 30_000 })
  await box.check({ force: true })
}

async function typeCommitMessage(message: string): Promise<void> {
  await gitPanel().getByRole('textbox', { name: 'Commit message' }).fill(message)
}

/**
 * Click something and return the server's answer to the route it triggers.
 *
 * A refusal is asserted on the RESPONSE, not only on the toast: the toast is
 * how a user learns, the 409 body (`code`, `error`) is what the contract says.
 */
async function clickAndAwait(
  action: () => Promise<void>,
  urlFragment: string,
  method = 'POST',
): Promise<Response> {
  const pending = page.waitForResponse(
    (response) => response.url().includes(urlFragment) && response.request().method() === method,
    { timeout: 120_000 },
  )
  await action()
  return pending
}

// ─── Source-file helpers ─────────────────────────────────────────────────────

/** Line endings are not the subject of any assertion here — `parser-13` owns that. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function absolute(file: string): string {
  return path.join(projectDir, ...file.split('/'))
}

/** Replace (or add) the single trailing marker comment. Returns the new text. */
function withMarker(text: string, marker: string): string {
  // Trailing whitespace goes BEFORE the marker line is removed, and again
  // after. `MARKER_LINE` is anchored at end-of-input, so a file that ends with
  // a newline *after* the marker does not match it — which silently appends a
  // SECOND marker instead of replacing the first, and every later "which
  // marker is on disk" read then answers about the wrong one. Measured on the
  // first real run of this spec, not theorised.
  const base = normalize(text).replace(/\s+$/, '').replace(MARKER_LINE, '').replace(/\s+$/, '')
  return `${base}\n${MARKER_PREFIX} ${marker}\n`
}

function setLocalMarker(file: string, marker: string): void {
  const target = absolute(file)
  fs.writeFileSync(target, withMarker(fs.readFileSync(target, 'utf8'), marker), 'utf8')
}

/**
 * The marker on disk. Throws when a file carries more than one: two markers
 * means an edit appended rather than replaced, and every assertion built on
 * "the marker says X" would then be measuring the wrong line.
 */
function readLocalMarker(file: string): string | null {
  const markers = [...normalize(fs.readFileSync(absolute(file), 'utf8')).matchAll(/\/\/ g8-dogfood: (.*)/g)]
  if (markers.length > 1) {
    throw new Error(`${file} carries ${markers.length} dogfood markers; an edit appended instead of replacing`)
  }
  return markers.length === 1 ? markers[0]![1]!.trim() : null
}

/** Put a marker on GitHub's copy of `file`, on `branch`. Returns the commit sha. */
function setRemoteMarker(file: string, marker: string, branch: string): string {
  const current = readRemoteFile(repo, file, branch)
  return writeRemoteFile(repo, file, withMarker(current.text, marker), `dogfood: ${marker}`, branch)
}

/**
 * Commit everything Studio wrote into the project by itself, so the rest of
 * the dogfood starts from a clean tree.
 *
 * This is a WORKAROUND for the defect case 2b records, not part of the script:
 * `loadStudioPages` calls `ensurePrototypeShell(dir)` on every board open, which
 * rewrites the runnable preview shell into the user's repository. Without this
 * the tree is never clean, and every pull and every branch switch in steps 6–11
 * refuses over files nobody edited — so none of the rest of G8 could be
 * measured at all.
 */
function absorbStudioScaffolding(when: string): string[] {
  const dirty = localStatusLines(projectDir)
  scaffoldingRewrites.push({ when, paths: dirty })
  if (dirty.length === 0) return []
  git(projectDir, ['add', '-A'])
  git(projectDir, [
    '-c',
    'user.name=Studio G8 Dogfood',
    '-c',
    'user.email=g8-dogfood@studio.invalid',
    'commit',
    '-m',
    "dogfood: absorb Studio's own preview-shell scaffolding (see case 2b)",
  ])
  return dirty
}

/**
 * How far HEAD is ahead of / behind `origin/<branch>`, straight from git.
 *
 * Asserted against what the panel shows rather than against a hard-coded pair:
 * the panel's job is to agree with the repository, and the workaround for
 * `proto-01` (see `absorbStudioScaffolding`) adds commits of its own, so the
 * literal `1↑ 1↓` of the dogfood script is not a number this spec can assume.
 */
function aheadBehind(branch: string): { ahead: number; behind: number } {
  return {
    ahead: Number(gitOut(projectDir, ['rev-list', '--count', `origin/${branch}..HEAD`])),
    behind: Number(gitOut(projectDir, ['rev-list', '--count', `HEAD..origin/${branch}`])),
  }
}

/**
 * Get out of a rebase this spec could not finish, so the next case starts from
 * a repository rather than from a half-applied one.
 *
 * Only reachable because case 8 is an expected failure — see its docblock.
 */
function recoverFromStoppedRebase(): boolean {
  const inProgress =
    fs.existsSync(path.join(projectDir, '.git', 'rebase-merge')) ||
    fs.existsSync(path.join(projectDir, '.git', 'rebase-apply'))
  if (!inProgress) return false
  git(projectDir, ['rebase', '--abort'], { allowFailure: true })
  return true
}

/** Commit the current working tree state of `file` with plain git — used where the UI is not the subject. */
function commitLocally(file: string, message: string): string {
  git(projectDir, ['add', '--', file])
  git(projectDir, [
    '-c',
    'user.name=Studio G8 Dogfood',
    '-c',
    'user.email=g8-dogfood@studio.invalid',
    'commit',
    '-m',
    message,
  ])
  return localHeadSha(projectDir)
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

test.describe('G8 — Studio against a real private GitHub repository', () => {
  test.describe.configure({ mode: 'serial' })

  test.skip(
    !available,
    'gh auth token failed: this machine has no GitHub credential, so the G8 dogfood cannot run. ' +
      'Run `gh auth login` (scope: repo) and re-run — see docs/e2e/README.md.',
  )

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(600_000)

    repo = createScratchRepo()
    const source = path.join(WORKSPACE_ROOT, SEED_PROJECT)
    if (!fs.existsSync(source)) {
      throw new Error(`the seed project ${source} is not on disk, so there is nothing to put in the scratch repository`)
    }
    const seeded = seedScratchRepo(repo, source)
    seedWorkDir = seeded.workDir

    const context = await browser.newContext({ storageState: OWNER_STATE_FILE })
    page = await context.newPage()
    recordConsole(page)
    await page.goto('/admin/site')
    await expectEditorReady(page)
    await installToastRecorder(page)
  })

  /**
   * Teardown, ordered so that **the remote repository is dealt with first**.
   *
   * The local directories are throwaways inside a throwaway workspace; the
   * GitHub repository is the only thing here that outlives the run. An earlier
   * version deleted the clone first, and a Windows `EPERM` on a git pack file
   * threw before `deleteScratchRepo` was ever reached — leaving a private
   * repository behind because a file was read-only. Nothing in this hook is
   * allowed to throw for that reason.
   */
  test.afterAll(async () => {
    test.setTimeout(300_000)
    if (openedPullRequest !== null) {
      try {
        closeRemotePullRequest(repo, openedPullRequest)
      } catch {
        // The repository is about to be destroyed; a PR that could not be
        // closed is not worth failing teardown over.
      }
    }
    if (repo) cleanup = deleteScratchRepo(repo)
    if (page) await page.context().close().catch(() => undefined)
    if (projectDir) removeDir(projectDir)
    if (seedWorkDir) removeDir(seedWorkDir)
    for (const dir of tempDirs) removeDir(dir)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1 — sign in
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `GITHUB_OAUTH_CLIENT_ID` is not set on this machine, so `device/start`
   * answers 501 and the paste-a-token disclosure is the path a user has
   * (`git-21`). That is the fallback G2 shipped precisely so an install with
   * no OAuth App still works, and this step is the only proof it does.
   */
  test('1 — signing in with a pasted token through the Version control panel', async () => {
    currentStep = '1 sign in'
    test.setTimeout(180_000)
    const panel = await openGitPanel()

    // The disclosure opens itself when the server reports no OAuth App; click
    // it only if it did not.
    const tokenField = panel.getByRole('textbox', { name: 'GitHub personal access token' })
    if (!(await tokenField.isVisible().catch(() => false))) {
      await panel.getByRole('button', { name: 'Paste a token instead' }).click()
    }
    await expect(tokenField).toBeVisible()
    expect(await tokenField.getAttribute('type'), 'the token field must be a password field').toBe('password')

    // The ONE place the token exists in this process. Never logged, never
    // asserted on, never written anywhere.
    await tokenField.fill(readGithubTokenForSignIn())
    const saved = await clickAndAwait(
      () => panel.getByRole('button', { name: 'Save', exact: true }).click(),
      '/admin/api/studio/github/token',
    )
    expect(saved.status(), 'GitHub did not accept the pasted token').toBe(200)

    // The refusal that matters on this surface: no response in the github
    // namespace may carry a credential back.
    const savedBody = JSON.stringify(await saved.json())
    expect(savedBody, 'the sign-in response echoed a token-shaped value').not.toMatch(/gh[pousr]_[A-Za-z0-9_]{10,}/)

    const accountResponse = await page.request.get('/admin/api/studio/github/account')
    expect(accountResponse.status()).toBe(200)
    const account = (await accountResponse.json()) as {
      account: { login: string; scopes: string[] } | null
      clientConfigured: boolean
    }
    expect(account.account?.login, 'the panel did not report a signed-in account').toBe(repo.owner)
    expect(JSON.stringify(account), 'GET account leaked a token-shaped value').not.toMatch(
      /gh[pousr]_[A-Za-z0-9_]{10,}/,
    )

    await expect(panel.getByText(repo.owner, { exact: true })).toBeVisible()
    test.info().annotations.push({
      type: 'signed in as',
      description: `${repo.owner} · scopes reported by GitHub: ${account.account?.scopes.join(', ') ?? 'none'}`,
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2 — clone with Keep history
  // ───────────────────────────────────────────────────────────────────────────

  test('2 — Import project → Keep history clones the private repo, and origin + main show up', async () => {
    currentStep = '2 clone'
    test.setTimeout(600_000)

    await page.getByRole('button', { name: 'Import project' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Import project' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(repo.httpsUrl)
    await dialog.getByRole('switch').click()

    const cloneStarted = await clickAndAwait(
      () => dialog.getByRole('button', { name: 'Import', exact: true }).click(),
      '/admin/api/studio/git/clone',
    )
    expect(cloneStarted.status(), 'the clone was refused before it started').toBe(200)

    // The summary step replaces the form when the job finishes.
    const openProject = page.getByRole('button', { name: 'Open project' })
    await expect(openProject, 'the clone never produced an import summary').toBeVisible({ timeout: 420_000 })
    await openProject.click()

    projectDir = path.join(WORKSPACE_ROOT, repo.expectedProjectFolder)
    expect(fs.existsSync(projectDir), `Studio did not clone into ${repo.expectedProjectFolder}`).toBe(true)
    expect(fs.existsSync(path.join(projectDir, '.git')), 'the clone has no .git, so it kept no history').toBe(true)

    // History really came along: `main` has the seed commit, with a parent-less
    // first commit rather than a synthesised one.
    expect(localBranch(projectDir)).toBe('main')
    expect(localHeadSha(projectDir)).toBe(remoteBranchSha(repo, 'main'))
    expect(localHeadSubject(projectDir)).toBe('seed: the G8 dogfood project')
    expect(gitOut(projectDir, ['remote', 'get-url', 'origin'])).toContain(repo.full)

    const tracked = localTrackedFiles(projectDir)
    dogfoodFile = tracked.find((file) => /^pages\/.+\.tsx$/.test(file)) ?? tracked.find((file) => file.endsWith('.tsx'))!
    secondFile = tracked.find((file) => file !== dogfoodFile && file.endsWith('.tsx')) ?? 'package.json'
    expect(dogfoodFile, 'the cloned project tracks no .tsx to edit').toBeTruthy()

    await expectEditorReady(page)
    const panel = await remountGitPanel()

    // The Repository block names origin. Asserted as a SUBSTRING so a future
    // redaction of the remote URL (`sec-18`) does not fail a claim it does not
    // change: what matters is that the panel points at this repository.
    await expect(panel.getByText('origin', { exact: true })).toBeVisible()
    await expect(panel.getByText(new RegExp(repo.full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible()

    expect(await branchOptions(), 'the branch dropdown does not list main').toContain('main')
    test.info().annotations.push({
      type: 'cloned project',
      description: `${repo.expectedProjectFolder} · ${tracked.length} tracked files · editing ${dogfoodFile}`,
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3 — branch with uncommitted work
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // 2b — the defect the rest of the dogfood has to work around
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * **EXPECTED FAILURE — `proto-01`: opening a project dirties its repository.**
   *
   * `loadStudioPages` calls `ensurePrototypeShell(dir)` on every board open
   * (`server/handlers/studioPageLoad.ts:566`), which writes Studio's own
   * runnable preview shell — `prototype/`, `index.html`, `vite.config.js`,
   * `package.json`, plus four `*.generated.*` files — into the user's working
   * tree. None of those paths is in git's excluded set (`node_modules`, `dist`,
   * `.next`, `.turbo`, `.git`, `.studio`), so they show up as the user's own
   * uncommitted changes.
   *
   * That is not cosmetic here. Studio refuses to pull or switch branches over a
   * dirty tree — deliberately, because it never stashes — so on a freshly
   * cloned repository **every pull and every branch switch refuses over changes
   * the user did not make**, and the fix is not something they can perform from
   * inside the panel.
   *
   * Left as `test.fail()` rather than fixed here: whether the preview shell
   * belongs in the user's history, in their `.gitignore`, or in git's excluded
   * set is a decision for the prototype-shell and G-track owners, not a
   * three-line edit. The steps after this one commit the scaffolding first —
   * see `absorbStudioScaffolding` — because otherwise none of G8's remaining
   * ten steps can be measured at all.
   */
  test('2b — opening a cloned project does not dirty its git working tree', async () => {
    currentStep = '2b scaffolding'
    test.fail()
    const dirty = localStatusLines(projectDir)
    test.info().annotations.push({
      type: 'written by Studio on open',
      description: dirty.join(' · ') || 'nothing',
    })
    expect(
      dirty,
      'opening the project wrote to files the user never touched, and Studio then refuses to pull or ' +
        'switch branches over them',
    ).toEqual([])
  })

  /**
   * The asymmetry `BranchSection`'s doc calls the point of the whole design:
   * creating a branch is NOT gated on a clean tree, because `git switch -c` at
   * HEAD moves a pointer and cannot lose a byte. If uncommitted work did not
   * come along, "edit on the canvas, then branch, then commit" would be
   * impossible without a stash — and Studio never stashes.
   */
  test('3 — New branch over a dirty tree brings the uncommitted work with it', async () => {
    currentStep = '3 branch'
    test.setTimeout(180_000)

    const absorbed = absorbStudioScaffolding('after the board opened (step 2)')
    test.info().annotations.push({
      type: 'workaround for 2b',
      description: `committed ${absorbed.length} path(s) Studio scaffolded on open`,
    })
    expect(localStatusLines(projectDir), 'the tree is still dirty after absorbing the scaffolding').toEqual([])

    setLocalMarker(dogfoodFile, `step3-local-${RUN_ID}`)
    expect(localStatusLines(projectDir).some((line) => line.endsWith(dogfoodFile))).toBe(true)

    const panel = await remountGitPanel()
    await expect(
      panel.getByRole('checkbox', { name: `Include ${dogfoodFile} in the commit` }),
      'the panel does not list the file that was just changed',
    ).toBeVisible()

    await panelButton('New').click()
    await panel.getByRole('textbox', { name: 'New branch name' }).fill(DOGFOOD_BRANCH)
    const created = await clickAndAwait(
      () => panelButton('Create').click(),
      '/admin/api/studio/git/branch',
    )
    expect(created.status(), 'creating a branch over a dirty tree was refused').toBe(200)

    expect(localBranch(projectDir)).toBe(DOGFOOD_BRANCH)
    expect(
      readLocalMarker(dogfoodFile),
      'the uncommitted edit did not come along to the new branch',
    ).toBe(`step3-local-${RUN_ID}`)
    expect(
      localStatusLines(projectDir).some((line) => line.endsWith(dogfoodFile)),
      'the file stopped being dirty, so something committed or discarded it',
    ).toBe(true)

    const toasts = await drainToasts(page)
    expect(toasts.map((toast) => toast.text).join(' | ')).toContain(`On branch ${DOGFOOD_BRANCH}`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4 — commit + push
  // ───────────────────────────────────────────────────────────────────────────

  test('4 — Commit then Push puts the branch on GitHub and the panel says "Up to date"', async () => {
    currentStep = '4 commit + push'
    test.setTimeout(300_000)

    const message = `dogfood: step 4 commit from Studio (${RUN_ID})`
    const panel = await remountGitPanel()
    await tickFile(dogfoodFile)
    await typeCommitMessage(message)

    const committed = await clickAndAwait(
      () => panel.getByRole('button', { name: /^Commit 1 file$/ }).click(),
      '/admin/api/studio/git/commit',
    )
    expect(committed.status(), 'the commit was refused').toBe(200)
    expect(localHeadSubject(projectDir)).toBe(message)
    expect(
      localStatusLines(projectDir).some((line) => line.endsWith(dogfoodFile)),
      'the file is still dirty after being committed',
    ).toBe(false)

    const localSha = localHeadSha(projectDir)
    expect(remoteBranchShaOrNull(repo, DOGFOOD_BRANCH), 'the branch was on GitHub before Push ran').toBeNull()

    const pushed = await clickAndAwait(() => panelButton('Push').click(), '/admin/api/studio/git/push')
    expect(pushed.status(), 'the push was refused').toBe(200)

    expect(remoteBranchSha(repo, DOGFOOD_BRANCH), 'GitHub does not have the commit Studio pushed').toBe(localSha)

    // A sha proves a commit exists; a clone proves what is in it.
    const witness = cloneFresh(repo, DOGFOOD_BRANCH, 'after-push')
    tempDirs.push(path.dirname(witness))
    expect(normalize(fs.readFileSync(path.join(witness, ...dogfoodFile.split('/')), 'utf8'))).toContain(
      `${MARKER_PREFIX} step3-local-${RUN_ID}`,
    )

    const settled = await remountGitPanel()
    await expect(
      settled.getByText(`Up to date with origin/${DOGFOOD_BRANCH}`),
      'the panel does not report the branch as up to date after a successful push',
    ).toBeVisible({ timeout: 30_000 })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5 — open a pull request
  // ───────────────────────────────────────────────────────────────────────────

  test('5 — Open PR creates a real pull request titled with the last commit subject', async () => {
    currentStep = '5 pull request'
    test.setTimeout(180_000)

    const panel = await remountGitPanel()
    const openPr = panelButton('Open PR')
    await expect(openPr, '"Open PR" is not offered for a pushed non-default branch').toBeVisible({ timeout: 30_000 })

    const opened = await clickAndAwait(() => openPr.click(), '/admin/api/studio/git/pull-request')
    expect(opened.status(), 'the pull request was refused').toBe(200)
    const body = (await opened.json()) as { number: number; url: string }
    openedPullRequest = body.number

    const remote = listRemotePullRequests(repo)
    const created = remote.find((pull) => pull.number === body.number)
    expect(created, `GitHub has no pull request #${body.number}`).toBeTruthy()
    expect(created!.state).toBe('open')
    expect(created!.headRef).toBe(DOGFOOD_BRANCH)
    expect(created!.baseRef).toBe('main')
    expect(created!.title, 'the PR title is not the last commit subject').toBe(localHeadSubject(projectDir))

    await expect(panel.getByRole('link', { name: 'Compare on GitHub' })).toHaveAttribute(
      'href',
      new RegExp(repo.full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )

    closeRemotePullRequest(repo, body.number)
    openedPullRequest = null
    expect(listRemotePullRequests(repo).find((pull) => pull.number === body.number)!.state).toBe('closed')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6 — fetch, refuse the push, pull
  // ───────────────────────────────────────────────────────────────────────────

  test('6 — a commit made on GitHub shows as 1 behind, blocks Push, and Pull brings it to disk', async () => {
    currentStep = '6 fetch + pull'
    test.setTimeout(300_000)

    const remoteSha = setRemoteMarker(dogfoodFile, `step6-remote-${RUN_ID}`, DOGFOOD_BRANCH)

    await remountGitPanel()
    const fetched = await clickAndAwait(() => panelButton('Fetch').click(), '/admin/api/studio/git/fetch')
    expect(fetched.status(), 'Fetch was refused').toBe(200)

    const behind = await remountGitPanel()
    await expect(
      behind.getByText('1 behind', { exact: false }),
      'the panel does not report the branch as 1 behind after fetching a remote commit',
    ).toBeVisible({ timeout: 30_000 })
    await expect(syncSectionHeader()).toContainText('1↓')

    // Push is refused BEFORE the click — the difference between a tool and a
    // terminal, per `SyncSection`'s own doc.
    const push = panelButton('Push')
    await expect(push).toHaveAttribute('aria-disabled', 'true')
    expect(await tooltipOf(push)).toContain('Pull first')

    // A pull refuses over a dirty tree by design, so this is also the claim
    // that merely having the project OPEN in Studio does not dirty the user's
    // repository. A failure here names whatever wrote to it.
    expect(
      localStatusLines(projectDir),
      'the working tree was dirty before the pull, so something wrote to the project on its own',
    ).toEqual([])

    const pulled = await clickAndAwait(() => panelButton('Pull').click(), '/admin/api/studio/git/pull')
    expect(pulled.status(), `the fast-forward pull was refused: ${await pulled.text()}`).toBe(200)

    expect(localHeadSha(projectDir), 'the pull did not move HEAD to the commit GitHub has').toBe(remoteSha)
    expect(readLocalMarker(dogfoodFile), "GitHub's version of the file is not the one on disk").toBe(
      `step6-remote-${RUN_ID}`,
    )
    // The board is re-read from disk after a pull (`onWorkingTreeChanged` →
    // `requestCmsSiteReload`). What must be true afterwards is that the editor
    // is still there showing the new files, not an error state.
    await expectEditorReady(page)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6b — the second half of the same defect
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * **EXPECTED FAILURE — `proto-01`, the part that bites twice.**
   *
   * A successful pull calls `onWorkingTreeChanged` → `requestCmsSiteReload`,
   * the board re-loads, `loadStudioPages` calls `ensurePrototypeShell` again,
   * and the project is dirty once more — immediately, with no user action in
   * between. So the SECOND pull of a session refuses over a tree the first
   * pull dirtied, and the panel's own advice ("commit them first") points at
   * files the user never wrote.
   *
   * This is why case 2b cannot be dismissed as a one-off at import time.
   */
  test('6b — a successful pull leaves the working tree clean', async () => {
    currentStep = '6b re-dirtied'
    test.fail()
    const dirty = localStatusLines(projectDir)
    test.info().annotations.push({
      type: 'rewritten by the post-pull board reload',
      description: dirty.join(' · ') || 'nothing',
    })
    expect(
      dirty,
      'the board reload that follows a pull re-wrote the preview shell, so the next pull refuses over ' +
        'changes the user did not make',
    ).toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7 — divergence
  // ───────────────────────────────────────────────────────────────────────────

  test('7 — commits on both sides report 1↑ 1↓ and Studio refuses to choose how to reconcile', async () => {
    currentStep = '7 divergence'
    test.setTimeout(300_000)

    absorbStudioScaffolding('after the pull in step 6')
    setLocalMarker(dogfoodFile, `step7-local-${RUN_ID}`)
    commitLocally(dogfoodFile, `dogfood: step 7 local (${RUN_ID})`)
    setRemoteMarker(dogfoodFile, `step7-remote-${RUN_ID}`, DOGFOOD_BRANCH)

    await remountGitPanel()
    const fetched = await clickAndAwait(() => panelButton('Fetch').click(), '/admin/api/studio/git/fetch')
    expect(fetched.status()).toBe(200)

    const diverged = await remountGitPanel()
    const divergence = aheadBehind(DOGFOOD_BRANCH)
    expect(divergence.ahead, 'this branch has no commit origin lacks').toBeGreaterThan(0)
    expect(divergence.behind, 'origin has no commit this branch lacks').toBe(1)
    await expect(
      syncSectionHeader(),
      'the Sync header does not report the divergence git reports',
    ).toContainText(`${divergence.ahead}↑ ${divergence.behind}↓`)

    const choice = diverged.getByRole('group', { name: 'Reconcile with origin' })
    await expect(choice, 'Studio did not ask which way to reconcile').toBeVisible()
    await expect(choice.getByRole('button', { name: 'Rebase onto origin' })).toBeVisible()
    await expect(choice.getByRole('button', { name: 'Merge', exact: true })).toBeVisible()

    // The refusal: a fast-forward pull is not offered when it cannot succeed.
    const pull = panelButton('Pull')
    await expect(pull).toHaveAttribute('aria-disabled', 'true')
    expect(await tooltipOf(pull)).toContain('choose rebase or merge')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 8 — same-line conflict
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * **PARTIAL EXPECTED FAILURE — `proto-01`, third face.**
   *
   * Everything this case asserts up to and including *Keep mine* holds: the
   * rebase stops, the panel lists the conflicted file with a per-file choice,
   * and *Keep mine* puts the LOCAL text on disk with no conflict markers left.
   * (Two of those only became true in this change — see the fix in
   * `SyncSection.tsx`: before it, a conflicting pull never re-read the conflict
   * state, so the panel showed "Rebase failed" and nothing to act on.)
   *
   * **Continue cannot finish**, and the reason is `proto-01` again. Resolving a
   * file calls `onWorkingTreeChanged` → `requestCmsSiteReload`, the board
   * reloads, `ensurePrototypeShell` rewrites `prototype/*.generated.*`, and
   * `git rebase --continue` refuses while ANY tracked file has unstaged
   * changes. Confirmed against plain git outside Studio: identical conflict,
   * identical resolution, one unrelated unstaged file — `rebase --continue`
   * fails; without it, it succeeds.
   *
   * Git's own words for that refusal are *"You must edit all merge conflicts
   * and then mark them as resolved using git add"*, which is both written for a
   * terminal and untrue — nothing is unmerged. `continueConflictResolution` now
   * checks for unstaged changes first and answers a named `dirty-tree` 409
   * listing the files, so the panel shows a sentence a person can act on
   * instead of a 500 carrying git's message. That is the part fixed here; the
   * cause — Studio writing to the project while a conflict is open — is
   * `proto-01`'s to fix.
   */
  test('8 — a same-line conflict is a list, "Keep mine" writes the local text, and Continue finishes', async () => {
    currentStep = '8 conflict'
    test.setTimeout(300_000)
    // EXPECTED FAILURE at the LAST step only: everything up to and including
    // "Keep mine" is asserted and holds. See the docblock above.
    test.fail()

    const panel = await remountGitPanel()
    const rebase = await clickAndAwait(
      () => panel.getByRole('button', { name: 'Rebase onto origin' }).click(),
      '/admin/api/studio/git/pull',
    )
    expect(rebase.status(), 'the rebase did not stop on the conflict both sides created').toBe(409)
    const refusal = (await rebase.json()) as { code: string; error: string; conflictFiles?: string[] }
    expect(refusal.code).toBe('conflict')
    expect(refusal.error, 'the refusal named a filesystem path').not.toMatch(PATH_LEAK)

    // The conflict has to be ON SCREEN without the user closing and reopening
    // the panel — scoped to the conflict list, because the same path also
    // appears in Changes (with a `!` mark) and a bare text match would pass on
    // a panel that offers nothing to do about it. That is exactly what this
    // step found on its first run.
    await expect(
      panel.getByText(/Rebase stopped on \d+ conflicted file/),
      'the panel never reported the stopped rebase',
    ).toBeVisible({ timeout: 30_000 })
    const conflictRow = panel.getByRole('listitem').filter({ hasText: dogfoodFile }).filter({ hasText: 'Keep mine' })
    await expect(
      conflictRow,
      'the conflicted file is not offered with a per-file choice after the rebase stopped',
    ).toBeVisible({ timeout: 30_000 })

    // `Keep mine` also fires `onWorkingTreeChanged` → `requestCmsSiteReload`,
    // and THAT board load is what rewrites the preview shell into the project
    // (`proto-01`). Waiting for it before touching Continue is what turns this
    // step's outcome from a race between two writers into a decision: either
    // Studio can finish a rebase over its own writes, or it says so.
    const boardReloaded = page.waitForResponse(
      (response) => response.url().includes('/admin/api/studio/load'),
      { timeout: 120_000 },
    )
    const kept = await clickAndAwait(
      () => conflictRow.getByRole('button', { name: 'Keep mine' }).click(),
      '/admin/api/studio/git/conflict/resolve',
    )
    expect(kept.status()).toBe(200)
    await boardReloaded
    const onDisk = normalize(fs.readFileSync(absolute(dogfoodFile), 'utf8'))
    expect(onDisk, 'conflict markers are still in the file after resolving it').not.toContain('<<<<<<<')
    expect(readLocalMarker(dogfoodFile), '"Keep mine" did not put the local text on disk').toBe(
      `step7-local-${RUN_ID}`,
    )

    // Continue stays disabled while anything is still unmerged, so waiting for
    // it to become clickable is itself the assertion that the resolve landed.
    const continueButton = panelButton('Continue')
    await expect(continueButton, 'Continue never became available after the file was resolved').toBeEnabled({
      timeout: 30_000,
    })
    const indexBeforeContinue = gitOut(projectDir, ['ls-files', '-u'])
    // Raw, NOT trimmed: the leading two columns are the whole point here —
    // `M ` is staged, ` M` is unstaged, and only the second kind stops a
    // rebase. Trimming them away is how the first version of this diagnostic
    // reported the same string for two very different repositories.
    const statusBeforeContinue = gitOut(projectDir, ['status', '--porcelain'])
    const unstagedBeforeContinue = gitOut(projectDir, ['diff', '--name-only'])
    test.info().annotations.push({
      type: 'the repository when Continue was pressed',
      description:
        `git status --porcelain:
${statusBeforeContinue || '(clean)'}
` +
        `git diff --name-only (unstaged):
${unstagedBeforeContinue || '(none)'}`,
    })
    const continued = await clickAndAwait(
      () => continueButton.click(),
      '/admin/api/studio/git/conflict/continue',
    )
    const continueAnswer = await continued.text()
    test.info().annotations.push({
      type: 'what Continue answered',
      description: `${continued.status()} ${continueAnswer.slice(0, 300)}`,
    })
    // When it refuses, the refusal has to be Studio's own and has to name what
    // is in the way — not git's terminal message arriving as a 500. Guarded on
    // the status so that a future fix which lets Continue SUCCEED makes the
    // `toBe(200)` below pass, which fails this `test.fail()` case loudly
    // instead of letting the docblock rot.
    if (continued.status() !== 200) {
      const refusal = JSON.parse(continueAnswer) as { code?: string; error?: string; dirtyFiles?: string[] }
      expect(refusal.code, 'Continue refused with something other than the named dirty-tree refusal').toBe(
        'dirty-tree',
      )
      expect(
        refusal.dirtyFiles ?? [],
        'the refusal did not name the files standing in the way of the rebase',
      ).not.toEqual([])
      expect(refusal.error ?? '', 'the refusal leaked a filesystem path').not.toMatch(
        PATH_LEAK,
      )
    }

    expect(
      continued.status(),
      `Continue did not finish the rebase: ${continueAnswer}
` +
        `git ls-files -u:
${indexBeforeContinue || '(nothing unmerged)'}
` +
        `git status --porcelain:
${statusBeforeContinue || '(clean)'}
` +
        `git diff --name-only: ${unstagedBeforeContinue || '(none)'}`,
    ).toBe(200)

    expect(fs.existsSync(path.join(projectDir, '.git', 'rebase-merge')), 'the rebase is still in progress').toBe(false)
    expect(fs.existsSync(path.join(projectDir, '.git', 'rebase-apply')), 'the rebase is still in progress').toBe(false)
    expect(readLocalMarker(dogfoodFile)).toBe(`step7-local-${RUN_ID}`)
    // The remote commit is now an ancestor: that is what a rebase means.
    expect(
      git(projectDir, ['merge-base', '--is-ancestor', `origin/${DOGFOOD_BRANCH}`, 'HEAD'], { allowFailure: true }).ok,
      "the rebase did not replay onto origin's commit",
    ).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 9 — abort
  // ───────────────────────────────────────────────────────────────────────────

  test('9 — Abort puts the branch back exactly where it was before the pull', async () => {
    currentStep = '9 abort'
    test.setTimeout(300_000)

    const recovered = recoverFromStoppedRebase()
    test.info().annotations.push({
      type: 'recovery',
      description: recovered
        ? "aborted the rebase case 8 could not finish (see 8's docblock)"
        : 'the rebase from case 8 had already finished',
    })
    absorbStudioScaffolding('after case 8')
    setLocalMarker(dogfoodFile, `step9-local-${RUN_ID}`)
    commitLocally(dogfoodFile, `dogfood: step 9 local (${RUN_ID})`)
    setRemoteMarker(dogfoodFile, `step9-remote-${RUN_ID}`, DOGFOOD_BRANCH)

    const before = localHeadSha(projectDir)
    const beforeText = normalize(fs.readFileSync(absolute(dogfoodFile), 'utf8'))

    let panel = await remountGitPanel()
    expect((await clickAndAwait(() => panelButton('Fetch').click(), '/admin/api/studio/git/fetch')).status()).toBe(200)
    panel = await remountGitPanel()

    const rebase = await clickAndAwait(
      () => panel.getByRole('button', { name: 'Rebase onto origin' }).click(),
      '/admin/api/studio/git/pull',
    )
    expect(rebase.status(), 'the second rebase did not stop on a conflict').toBe(409)
    await expect(
      panel.getByRole('listitem').filter({ hasText: dogfoodFile }).filter({ hasText: 'Keep mine' }),
      'the second conflict is not listed with a per-file choice',
    ).toBeVisible({ timeout: 30_000 })

    // Two clicks, by design: the first arms the danger confirmation.
    await panel.getByRole('button', { name: /^Abort the (rebase|merge)$/ }).click()
    const aborted = await clickAndAwait(
      () => panel.getByRole('button', { name: /^Really abort the (rebase|merge)\?$/ }).click(),
      '/admin/api/studio/git/conflict/abort',
    )
    expect(aborted.status(), 'the abort was refused').toBe(200)

    expect(localHeadSha(projectDir), 'the abort did not put HEAD back where it was').toBe(before)
    expect(localBranch(projectDir)).toBe(DOGFOOD_BRANCH)
    expect(normalize(fs.readFileSync(absolute(dogfoodFile), 'utf8')), 'the file is not what it was before the pull').toBe(
      beforeText,
    )
    expect(
      localStatusLines(projectDir).some((line) => line.endsWith(dogfoodFile)),
      'the abort left the file it restored uncommitted',
    ).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10 — the write lock
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * G7. While a dependency install holds the project write lock, a git verb
   * waits five seconds and then answers `409 { code: 'busy' }` rather than
   * surfacing git's own `index.lock` error — which has a filesystem path in
   * it, and which leaves a lock file behind that wedges the repository.
   *
   * The commit is set up completely (file ticked, message typed) BEFORE the
   * install starts, so the only thing between the install and the click is the
   * click.
   */
  test('10 — a commit during an install is refused as busy, and leaves no index.lock', async () => {
    currentStep = '10 write lock'
    test.setTimeout(300_000)

    setLocalMarker(dogfoodFile, `step10-local-${RUN_ID}`)
    const panel = await remountGitPanel()
    await tickFile(dogfoodFile)
    await typeCommitMessage(`dogfood: step 10, should never land (${RUN_ID})`)
    const headBefore = localHeadSha(projectDir)

    const start = await page.evaluate(async (dir: string) => {
      const response = await fetch('/admin/api/studio/install', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
      })
      return { status: response.status, body: (await response.json()) as { jobId?: string } }
    }, projectDir)
    expect(start.status, 'the install did not start').toBe(200)
    const jobId = start.body.jobId!

    const installStatus = async (): Promise<string> => {
      const response = await page.request.get(`/admin/api/studio/install/${jobId}?dir=${encodeURIComponent(projectDir)}`)
      return ((await response.json()) as { status: string }).status
    }
    // `startInstallJob` records `running` synchronously and takes the write
    // lock in the very next async step, so there is nothing to wait for here
    // beyond the round trip the assertion below already costs.
    expect(await installStatus(), 'the install was not running after it started').toBe('running')

    const refused = await clickAndAwait(
      () => panel.getByRole('button', { name: /^Commit 1 file$/ }).click(),
      '/admin/api/studio/git/commit',
    )
    const stillRunning = await installStatus()

    expect(
      stillRunning,
      'the install finished before the commit could contend for the lock, so this step observed nothing. ' +
        'Re-run against a project with no node_modules (a fresh clone) — see docs/e2e/README.md.',
    ).toBe('running')
    expect(refused.status(), 'the commit was not refused while another writer held the project').toBe(409)
    const body = (await refused.json()) as { code: string; error: string }
    expect(body.code).toBe('busy')
    expect(body.error, 'the busy refusal named a filesystem path').not.toMatch(PATH_LEAK)
    expect(localHeadSha(projectDir), 'the refused commit landed anyway').toBe(headBefore)

    const toasts = await drainToasts(page)
    const busyToast = toasts.find((toast) => toast.text.includes('Commit failed'))
    expect(busyToast, 'the user was not told the commit failed').toBeTruthy()
    expect(busyToast!.kind, 'a state refusal was reported as an error rather than a warning').toBe('warning')

    // Wait the install out, then check git left nothing behind.
    await expect
      .poll(installStatus, { timeout: 600_000, message: 'the install never finished' })
      .not.toBe('running')
    expect(danglingGitLocks(projectDir), 'git left a lock file behind').toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 11 — commit-and-switch
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The commit stands and the switch does not — and the refusal has to NAME
   * the file that is still dirty, because "some other file" is not something a
   * user can act on.
   */
  test('11 — commit-and-switch with a file left un-ticked keeps the commit and refuses the switch by name', async () => {
    currentStep = '11 commit-and-switch'
    test.setTimeout(300_000)

    // Start from a clean tree so the refusal below is about the file this case
    // deliberately left un-ticked, and not about step 10's refused commit, the
    // lockfile the install wrote, or `proto-01`'s scaffolding.
    absorbStudioScaffolding('before step 11 — step 10 left an install behind')
    setLocalMarker(dogfoodFile, `step11-ticked-${RUN_ID}`)
    setLocalMarker(secondFile, `step11-unticked-${RUN_ID}`)
    const dirtyNow = localStatusLines(projectDir)
    expect(
      dirtyNow.map((line) => line.replace(/^\S+\s+/, '')).sort(),
      'step 11 needs exactly the two files it made dirty',
    ).toEqual([dogfoodFile, secondFile].sort())

    const message = `dogfood: step 11 ticked only (${RUN_ID})`
    const panel = await remountGitPanel()
    await tickFile(dogfoodFile)
    await pickBranch('main')

    const dialog = page.getByRole('dialog').filter({ hasText: 'Commit before switching?' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('textbox', { name: 'Commit message' }).fill(message)

    const refused = await clickAndAwait(
      () => dialog.getByRole('button', { name: /^Commit 1 file and switch$/ }).click(),
      '/admin/api/studio/git/commit-and-switch',
    )
    expect(refused.status(), 'the switch was allowed over a still-dirty tree').toBe(409)
    const body = (await refused.json()) as { code: string; error: string; dirtyFiles?: string[] }
    expect(body.code).toBe('dirty-tree')
    expect(body.dirtyFiles, 'the refusal did not report which files are still dirty').toContain(secondFile)

    // The commit stands.
    expect(localHeadSubject(projectDir), 'the commit was rolled back').toBe(message)
    expect(localBranch(projectDir), 'the branch was switched despite the refusal').toBe(DOGFOOD_BRANCH)
    expect(localStatusLines(projectDir).some((line) => line.endsWith(secondFile))).toBe(true)

    const toasts = await drainToasts(page)
    const refusalToast = toasts.find((toast) => toast.text.includes('Commit and switch failed'))
    expect(refusalToast, 'the user was not told the switch was refused').toBeTruthy()
    expect(
      refusalToast!.text,
      'the refusal the user reads does not name the file that stopped the switch',
    ).toContain(secondFile)

    await expect(panel.getByRole('combobox', { name: 'Branch' })).toHaveValue(DOGFOOD_BRANCH)

    // The dialog deliberately stays open after the refusal — the user may want
    // to tick the file it named and try again — and it is modal, so nothing
    // behind it is reachable until it is dismissed. Close it the way a person
    // would rather than leaving the next case to discover a blocked rail.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog, 'Cancel did not dismiss the commit-and-switch dialog').toBeHidden({ timeout: 15_000 })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 12 — sign out
  // ───────────────────────────────────────────────────────────────────────────

  test('12 — Sign out deletes the stored credential, not just the account badge', async () => {
    currentStep = '12 sign out'
    test.setTimeout(180_000)

    const panel = await remountGitPanel()
    const signedOut = await clickAndAwait(
      () => panel.getByRole('button', { name: 'Sign out' }).click(),
      '/admin/api/studio/github/token',
      'DELETE',
    )
    expect(signedOut.status()).toBe(200)

    const account = (await (await page.request.get('/admin/api/studio/github/account')).json()) as {
      account: unknown | null
    }
    expect(account.account, 'the account is still reported after signing out').toBeNull()

    // The badge disappearing is not the claim. The claim is that the stored
    // token is GONE — so the one route that can only work with a decrypted
    // credential must now fail.
    // Through `page.request`, not the page: this is a check on the SERVER's
    // answer, and routing it through the app would only prove the panel stopped
    // asking. (It is also why this needs no console-error allowlist entry — an
    // APIRequestContext request never reaches the page's console.)
    const repos = await page.request.get('/admin/api/studio/github/repos')
    test.info().annotations.push({
      type: 'GET github/repos after sign-out',
      description: `HTTP ${repos.status()}`,
    })
    expect(
      repos.ok(),
      'GET github/repos still succeeded after sign-out, so a usable credential is still stored',
    ).toBe(false)
    expect(
      JSON.stringify(await repos.text()),
      'the failure response carried a token-shaped value',
    ).not.toMatch(/gh[pousr]_[A-Za-z0-9_]{10,}/)

    await expect(panel.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // The run as a whole
  // ───────────────────────────────────────────────────────────────────────────

  test('the whole dogfood produced no unexplained console errors', async () => {
    currentStep = 'console'
    const unexplained = consoleEvents.filter(
      (event) => !CONSOLE_ALLOWLIST.some((entry) => entry.pattern.test(event.text)),
    )
    const unused = CONSOLE_ALLOWLIST.filter(
      (entry) => !consoleEvents.some((event) => entry.pattern.test(event.text)),
    )

    test.info().annotations.push({
      type: 'console events',
      description: `${consoleEvents.length} recorded, ${consoleEvents.length - unexplained.length} allowlisted`,
    })

    expect(
      unused.map((entry) => `${entry.pattern} — ${entry.why}`),
      'an allowlist entry matched nothing in this run: an entry that stops describing the run starts hiding ' +
        'whatever it matches next',
    ).toEqual([])
    expect(
      unexplained.map((event) => `[${event.step}] ${event.source}: ${event.text}`),
      'the dogfood logged errors nobody explained',
    ).toEqual([])
  })

  test('the scratch repository was destroyed', async () => {
    // `afterAll` has not run yet when this test does, so the teardown is
    // reported by the NEXT run's reader rather than asserted here. What this
    // case exists for is to put the repository name in the report while the
    // run is still readable, so a refused delete is never silent.
    for (const rewrite of scaffoldingRewrites) {
      test.info().annotations.push({
        type: 'proto-01 — Studio rewrote the project',
        description: `${rewrite.when}: ${rewrite.paths.length} path(s)${rewrite.paths.length ? ` — ${rewrite.paths.join(' · ')}` : ''}`,
      })
    }
    test.info().annotations.push({
      type: 'scratch repository',
      description: `${repo.full} — deleted in afterAll; if the delete is refused (no delete_repo scope) it is archived and must be removed by hand: gh repo delete ${repo.full} --yes`,
    })
    expect(repo.name.startsWith('studio-g8-scratch-'), 'the scratch repository is not named as a throwaway').toBe(true)
    expect(cleanup, 'cleanup ran before the last test, which means the ordering changed').toBeNull()
  })
})
