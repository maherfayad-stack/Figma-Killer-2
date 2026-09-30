/**
 * Disposable local server for automated browser E2E tests.
 *
 * This wrapper owns every piece of throwaway data a Playwright run touches. It
 * resets that data, then runs the same Vite + Bun CMS stack a developer uses —
 * with three deliberate differences:
 *
 *  1. **The CMS runs WITHOUT `--watch`.** Under `bun --watch`, the publish
 *     pipeline writing baked HTML into the uploads dir (and the SQLite DB
 *     churning) can trigger a server reload mid test, which drops in-memory
 *     state and tears the stack down. A regression suite needs a stable server,
 *     so E2E pins one. Vite is additionally told to ignore the runtime-written
 *     paths (see `vite.config.ts`), so publishing never reloads the admin app
 *     mid-test either.
 *
 *  2. **The Studio workspace is a COPY.** `studio-workspace/` is tracked by git
 *     and is a user's real React project everywhere else; a run must not leave
 *     a diff in it. `auth.setup.ts` stamps `lastOpenedAt` into the project it
 *     opens, the shell scaffolder writes `index.html` / `prototype/*` and
 *     rewrites `package.json`, and the framework compiler drops a
 *     `.studio/framework.json` — all real product behaviour, none of it
 *     something a test run may commit. So the tree is copied to
 *     `.tmp/e2e-workspace` here and both servers are pointed at the copy with
 *     `STUDIO_WORKSPACE_DIR` (`projectsRootDir()` reads it per call, and it is
 *     the anchor of every containment guard in the feature, so the specs' own
 *     fixture projects land inside it too). Recreated on START, not removed on
 *     stop: Playwright cannot shut a webServer down gracefully on Windows
 *     (`launchProcess` says so in as many words), so a teardown hook would be
 *     the one thing that never runs — and a failed run's evidence is worth
 *     keeping anyway. `tests/e2e/helpers/constants.ts` re-exports the path.
 *
 *  3. **Vite's boot is supervised.** See below — this is what makes
 *     `bun run test:e2e` able to start its own stack on Windows at all.
 *
 * ## Why Vite is supervised, and not merely spawned
 *
 * `scripts/lib/stackChild.ts` has the measurement: handed a pipe for stdout,
 * Vite intermittently binds its port and then answers nothing, because it is
 * blocked inside a write. Giving each child a log FILE instead took a boot from
 * 3/10 to 8/10 on this machine. The rest is closed here: after spawning Vite we
 * ask it for a page it serves itself, and a Vite that has not answered is killed
 * and respawned rather than left for Playwright to report as a bare "Timed out
 * waiting 600000ms".
 *
 * Two details that are load-bearing:
 *
 *   - **The readiness probe asks for `/admin`, not `/`.** `/` is proxied by
 *     `vite.config.ts` into the CMS's public-site renderer, which on a
 *     just-created database takes seconds and depends on state this script has
 *     no opinion about. `/admin` is the editor's own `index.html`, served by
 *     Vite, and is what every spec navigates to first anyway.
 *   - **"Still starting" and "stuck" are told apart by the LISTENER, not by a
 *     clock.** A checkout with a cold `node_modules/.vite` pre-bundles every
 *     dependency before it calls `listen()`, and that is slow work, not a hang
 *     — killing it would be wrong, and the retry would have to start over. So
 *     while nothing is accepting connections on the port, we keep waiting, up
 *     to a deliberately generous ceiling. **Once the port DOES accept**, Vite
 *     has called `listen()` and owes us an answer in milliseconds; a listener
 *     that stays silent for `VITE_ANSWER_GRACE_MS` is the defect above, and it
 *     is restarted then rather than minutes later.
 */
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { cp, mkdir, rm } from 'node:fs/promises'
import { bunCommand, viteCommand } from './lib/bunCommand'
import {
  E2E_ADMIN_ORIGIN,
  E2E_CMS_PORT,
  E2E_VITE_MODE,
  E2E_VITE_PORT,
  E2E_WORKSPACE_DIR,
  E2E_WORKSPACE_SOURCE_DIR,
} from './lib/e2eStack'
import { logSupervisor, spawnStackChild, truncateChildLog, type StackChild } from './lib/stackChild'

const DATABASE_PATH = './.tmp/e2e-agent.db'
const UPLOADS_DIR = './.tmp/e2e-uploads'
const CMS_LOG = './.tmp/e2e-cms.log'
/** One log per boot ATTEMPT: two children must never share a file handle, and each attempt's evidence stands on its own. */
const viteLogFor = (attempt: number): string =>
  attempt === 1 ? './.tmp/e2e-vite.log' : `./.tmp/e2e-vite.attempt${attempt}.log`

/**
 * Ceiling on "has not called `listen()` yet".
 *
 * Two numbers, chosen from one fact on disk. Vite pre-bundles every dependency
 * into `node_modules/.vite/deps` before it listens, and on a checkout that has
 * never done it that is minutes of honest work — killing it would be wrong, and
 * the retry would start from nothing. With that cache already written, the same
 * boot is 0.6-4 s here, so a minute of silence is not slow, it is the stuck
 * boot `scripts/lib/stackChild.ts` documents, and waiting three more minutes to
 * say so helps nobody.
 */
const VITE_BOOT_CEILING_MS = existsSync('node_modules/.vite/deps/_metadata.json')
  ? 60_000
  : 180_000
/** How long a LISTENING Vite may go without answering before it counts as stuck. */
const VITE_ANSWER_GRACE_MS = 30_000
/** Worst case 3 × the ceiling above, which stays inside `playwright.config.ts`'s `webServer.timeout`. */
const VITE_BOOT_ATTEMPTS = 3
const VITE_PROBE_INTERVAL_MS = 500
/** Ceiling on one readiness request. A healthy Vite serves `index.html` in milliseconds. */
const VITE_PROBE_TIMEOUT_MS = 5_000
/** How long to wait for a killed Vite to release the port before respawning. */
const VITE_PORT_RELEASE_TIMEOUT_MS = 15_000

/**
 * Removes one disposable path, turning the ONE error that is not a bug in this
 * script into the sentence that fixes it.
 *
 * A leftover stack from a killed run still holds `.tmp/e2e-agent.db` open, and
 * Windows then fails the delete with `EBUSY`. Unhandled, that surfaces through
 * Playwright as "Process from config.webServer was not able to start. Exit
 * code: 1" over a raw Bun stack trace — which reads like the stack is broken,
 * and has cost more than one session (`docs/state-archive/2026-Q3.md`).
 */
async function resetDisposablePath(target: string): Promise<void> {
  try {
    await rm(target, { force: true, recursive: true })
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code !== 'EBUSY' && code !== 'EPERM') throw err
    console.error(
      `[e2e-dev] Cannot reset ${target}: another process still has it open ` +
        `(${code}). A previous e2e stack was killed without its children going ` +
        `with it. Kill the leftover \`bun\` processes (Windows: ` +
        `\`taskkill /IM bun.exe /F\`) and run again.`,
    )
    process.exit(1)
  }
}

await mkdir('./.tmp', { recursive: true })
for (const target of [
  DATABASE_PATH,
  `${DATABASE_PATH}-shm`,
  `${DATABASE_PATH}-wal`,
  UPLOADS_DIR,
  E2E_WORKSPACE_DIR,
]) {
  await resetDisposablePath(target)
}

await cp(E2E_WORKSPACE_SOURCE_DIR, E2E_WORKSPACE_DIR, { recursive: true })

truncateChildLog(CMS_LOG)
for (let attempt = 1; attempt <= VITE_BOOT_ATTEMPTS; attempt += 1) {
  truncateChildLog(viteLogFor(attempt))
}

// Shared by both children: the CMS port drives the Vite dev proxy target, so the
// admin UI talks to this disposable CMS instead of any regular dev server.
const sharedEnv = {
  ...process.env,
  PORT: E2E_CMS_PORT,
  DATABASE_URL: `sqlite:${DATABASE_PATH}`,
  UPLOADS_DIR,
  STUDIO_WORKSPACE_DIR: E2E_WORKSPACE_DIR,
}

const children: StackChild[] = []
let shuttingDown = false

function stopChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  shuttingDown = true
  for (const child of children) {
    child.stopTail()
    if (child.process.exitCode === null) child.process.kill(signal)
  }
}

/** Watches one child: if it dies on its own, the other half goes with it. */
function superviseExit(child: StackChild): void {
  void child.process.exited.then((code) => {
    if (shuttingDown) return
    // One half of the stack died on its own — bring the other down and exit so
    // Playwright sees the failure instead of half a stack.
    stopChildren()
    process.exit(code ?? 1)
  })
}

/**
 * True once Vite answers for a page it serves itself (never the proxied `/`).
 *
 * The `AbortSignal.timeout` is the load-bearing part, not a nicety. The failure
 * this whole supervisor exists for is a Vite that ACCEPTS the connection and
 * then never responds; an un-timed `fetch` against it never settles, so the
 * probe loop below would hang inside its own first await — no ceiling, no
 * retry, no message, just Playwright's timeout ten minutes later. Observed
 * exactly that before this argument existed.
 */
async function viteAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`${E2E_ADMIN_ORIGIN}/admin`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(VITE_PROBE_TIMEOUT_MS),
    })
    return res.status < 500
  } catch {
    return false
  }
}

/** True once something accepts a TCP connection on the Vite port — i.e. `listen()` has happened. */
function vitePortAccepts(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(E2E_VITE_PORT) })
    const settle = (accepted: boolean): void => {
      socket.destroy()
      resolve(accepted)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(1_000, () => settle(false))
  })
}

/** Why one boot attempt ended — each maps to a different line in the run's output. */
type ViteBootOutcome = 'ready' | 'exited' | 'silent-listener' | 'never-listened'

/**
 * Waits for Vite to serve `/admin`.
 *
 * The three failure outcomes are kept apart because they send you to different
 * places: `exited` means Vite refused to start and printed why (a port already
 * taken, a config error); `silent-listener` is the defect
 * `scripts/lib/stackChild.ts` documents; `never-listened` means it was still
 * working when the ceiling expired.
 */
async function waitForVite(child: StackChild, ceilingMs: number): Promise<ViteBootOutcome> {
  const ceiling = Date.now() + ceilingMs
  let listeningSince: number | null = null
  while (Date.now() < ceiling) {
    await Bun.sleep(VITE_PROBE_INTERVAL_MS)
    if (await viteAnswers()) return 'ready'
    if (child.process.exitCode !== null) return 'exited'
    if (!(await vitePortAccepts())) continue
    listeningSince ??= Date.now()
    if (Date.now() - listeningSince > VITE_ANSWER_GRACE_MS) return 'silent-listener'
  }
  return 'never-listened'
}

/** Waits until nothing is listening on the Vite port, so `--strictPort` can bind again. */
async function waitForVitePortFree(): Promise<void> {
  const deadline = Date.now() + VITE_PORT_RELEASE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!(await vitePortAccepts())) return
    await Bun.sleep(VITE_PROBE_INTERVAL_MS)
  }
}

// Registered BEFORE anything is spawned. The boot loop below can run for
// minutes, and a signal arriving inside it must still take the children down —
// an orphaned Vite holding the port is what makes the NEXT run fail with
// "5174 is already used", which reads like a boot bug and is not one.
process.on('SIGINT', () => stopChildren('SIGINT'))
process.on('SIGTERM', () => stopChildren('SIGTERM'))

const cms = spawnStackChild(bunCommand('server/index.ts'), sharedEnv, CMS_LOG)
children.push(cms)
superviseExit(cms)

// `E2E_VITE_MODE=preview` (see `e2eStack.ts`): the production bundle, built
// once here, then served by `vite preview`, which reuses `server.proxy`.
if (E2E_VITE_MODE === 'preview') {
  logSupervisor('[e2e-dev] E2E_VITE_MODE=preview: building the admin bundle (vite build)…')
  const build = Bun.spawnSync(viteCommand('build'), { env: sharedEnv, stdout: 'inherit', stderr: 'inherit' })
  if (build.exitCode !== 0) {
    logSupervisor(`[e2e-dev] vite build failed (exit ${build.exitCode}); not starting the stack.`)
    stopChildren()
    process.exit(1)
  }
}
const viteCmd =
  E2E_VITE_MODE === 'preview'
    ? viteCommand('preview', '--host', '127.0.0.1', '--port', E2E_VITE_PORT, '--strictPort')
    : viteCommand('--host', '127.0.0.1', '--port', E2E_VITE_PORT, '--strictPort')
let vite: StackChild | null = null

const BOOT_OUTCOME_REASON: Record<Exclude<ViteBootOutcome, 'ready'>, string> = {
  exited: 'it exited on its own — its output above says why',
  'silent-listener': `it bound ${E2E_VITE_PORT} and then answered nothing for ${VITE_ANSWER_GRACE_MS / 1000}s`,
  'never-listened': `it never bound ${E2E_VITE_PORT} within ${VITE_BOOT_CEILING_MS / 1000}s`,
}

for (let attempt = 1; attempt <= VITE_BOOT_ATTEMPTS; attempt += 1) {
  // A throw here is a failed ATTEMPT, not a failed run: spawning on Windows
  // can fail on a handle the previous attempt has not released yet, and dying
  // at that point would take down a supervisor whose whole job is to try again.
  let candidate: StackChild
  try {
    candidate = spawnStackChild(viteCmd, sharedEnv, viteLogFor(attempt))
  } catch (err) {
    logSupervisor(
      `[e2e-dev] Could not start Vite on attempt ${attempt}/${VITE_BOOT_ATTEMPTS}: ${String(err)}`,
    )
    continue
  }

  const outcome = await waitForVite(candidate, VITE_BOOT_CEILING_MS)
  if (outcome === 'ready') {
    vite = candidate
    break
  }
  candidate.stopTail()
  if (candidate.process.exitCode === null) candidate.process.kill('SIGKILL')
  await candidate.process.exited
  logSupervisor(
    `[e2e-dev] Vite did not come up on attempt ${attempt}/${VITE_BOOT_ATTEMPTS}: ` +
      `${BOOT_OUTCOME_REASON[outcome]}.` +
      (attempt < VITE_BOOT_ATTEMPTS ? ' Starting another.' : ''),
  )
  // `--strictPort` makes a respawn fail outright if the socket we just killed
  // has not been released yet, which would burn the next attempt on a race.
  if (attempt < VITE_BOOT_ATTEMPTS) await waitForVitePortFree()
}

if (!vite) {
  logSupervisor(
    `[e2e-dev] Vite never came up on ${E2E_ADMIN_ORIGIN} after ${VITE_BOOT_ATTEMPTS} attempts. ` +
      `Each attempt's own output is in ${viteLogFor(1)} (and .attemptN beside it); the CMS's is in ${CMS_LOG}.`,
  )
  stopChildren()
  process.exit(1)
}

children.push(vite)
superviseExit(vite)
