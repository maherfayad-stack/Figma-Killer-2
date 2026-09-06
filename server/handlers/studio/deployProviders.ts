/**
 * deployProviders — everything Studio KNOWS about Vercel and Netlify, with no
 * subprocess and no filesystem write anywhere in it.
 *
 * Three separable jobs, all pure enough to unit-test against real captured CLI
 * output (`server/handlers/__tests__/deploy.test.ts`):
 *
 *   1. **Detection** — which provider is this project already set up for?
 *      Read from files the project itself owns: `vercel.json` / `netlify.toml`
 *      declare intent, `.vercel/project.json` / `.netlify/state.json` prove the
 *      directory is actually LINKED to a remote project. Neither CLI can deploy
 *      an unlinked directory without prompting, and a prompt in a spawned
 *      process is a hang, so "linked" is reported as its own fact rather than
 *      being discovered at deploy time.
 *   2. **The allowed command set** — two argv arrays per provider (build, then
 *      deploy) plus a `whoami`-shaped auth probe. There is no template, no
 *      passthrough, and no request field that reaches an argv: the route
 *      surface IS the command set, exactly as `gitOperations.ts` states it for
 *      git. **No `--prod` appears anywhere in this file**, and there is no
 *      parameter that could add it — v1 deploys previews only.
 *   3. **Reading the answer back** — both CLIs print the deployment URL as
 *      labelled human output, not as a machine format we could ask for without
 *      also silencing the progress the user is watching. So the labels are
 *      matched explicitly (`Preview:`, `Website draft URL:`) rather than
 *      "first https:// in the output", which on both CLIs would return a
 *      dashboard link to the build log instead of the site.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DeployProvider } from './deploySchema'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** What one provider's files say about this project. */
export interface ProviderPresence {
  /** `vercel.json` / `netlify.toml` — the project declares this provider. */
  config: boolean
  /** `.vercel/project.json` / `.netlify/state.json` — the directory is linked to a remote project, so the CLI has somewhere to deploy to without prompting. */
  linked: boolean
}

export interface DeployDetection {
  /**
   * The single provider to offer by default, or `null` when the answer is not
   * unambiguous — nothing is configured (offer both, say so) or BOTH are
   * (offer both, let the user choose). Studio never guesses between two
   * configured providers: deploying to the wrong one publishes a preview
   * under a URL someone else's DNS points at.
   */
  detected: DeployProvider | null
  vercel: ProviderPresence
  netlify: ProviderPresence
}

/** `dir` is the project's APP ROOT (`resolveAppRoot`) — these config files sit beside `package.json`, which in a monorepo import is not the project directory. */
export function detectDeployProviders(dir: string): DeployDetection {
  const vercel: ProviderPresence = {
    config: existsSync(join(dir, 'vercel.json')),
    linked: existsSync(join(dir, '.vercel', 'project.json')),
  }
  const netlify: ProviderPresence = {
    config: existsSync(join(dir, 'netlify.toml')),
    linked: existsSync(join(dir, '.netlify', 'state.json')),
  }

  const vercelPresent = vercel.config || vercel.linked
  const netlifyPresent = netlify.config || netlify.linked
  const detected = vercelPresent === netlifyPresent ? null : vercelPresent ? 'vercel' : 'netlify'
  return { detected, vercel, netlify }
}

// ---------------------------------------------------------------------------
// The allowed command set
// ---------------------------------------------------------------------------

export interface ProviderCommands {
  /** The executable, for the "is this CLI installed?" message. */
  bin: string
  /** Human name, for UI copy the server writes. */
  label: string
  /** Cheap "is this machine signed in?" probe. Reads state; changes nothing. */
  probe: readonly string[]
  /**
   * The project's own build, run BY THE PROVIDER'S CLI rather than by a
   * package-manager script Studio picked. Both CLIs read the project's own
   * framework config to decide what "build" means and where the output goes;
   * a hand-rolled `npm run build` would produce a directory neither CLI knows
   * how to publish without Studio also guessing a publish path.
   */
  build: readonly string[]
  /**
   * Upload the already-built output as a PREVIEW. Never `--prod`, never
   * `--alias`, never a caller-supplied flag.
   */
  deploy: readonly string[]
  /** What to tell the user to run in their own terminal when the CLI is not signed in. Studio never collects the credential itself. */
  loginCommand: string
  /** What to run when the directory is not linked to a remote project yet — the other thing Studio deliberately does not do on the user's behalf, because it creates a remote resource. */
  linkCommand: string
}

/**
 * `vercel build` writes the Build Output API directory (`.vercel/output`), and
 * `vercel deploy --prebuilt` uploads exactly that — the pair is the documented
 * way to build locally and deploy what you built. `--prebuilt` without a prior
 * `vercel build` fails loudly rather than silently rebuilding in the cloud,
 * which is what makes the two-phase progress honest.
 *
 * `netlify build` runs the build command from `netlify.toml` (or the linked
 * site's settings) and `netlify deploy` uploads its publish directory as a
 * DRAFT deploy — Netlify's word for a preview. Neither carries `--prod`.
 */
export const PROVIDER_COMMANDS: Record<DeployProvider, ProviderCommands> = {
  vercel: {
    bin: 'vercel',
    label: 'Vercel',
    probe: ['vercel', 'whoami'],
    build: ['vercel', 'build'],
    deploy: ['vercel', 'deploy', '--prebuilt'],
    loginCommand: 'vercel login',
    linkCommand: 'vercel link',
  },
  netlify: {
    bin: 'netlify',
    label: 'Netlify',
    probe: ['netlify', 'status'],
    build: ['netlify', 'build'],
    deploy: ['netlify', 'deploy'],
    loginCommand: 'netlify login',
    linkCommand: 'netlify link',
  },
}

// ---------------------------------------------------------------------------
// Reading the CLIs' answers back
// ---------------------------------------------------------------------------

/** Same pattern, and the same reason, as `referenceRender.ts`'s: a CLI that colours a URL emits it as `https://` + escape + host + escape, which splits the link mid-match. */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g // eslint-disable-line no-control-regex -- strips terminal colour codes before URL matching

/** Both CLIs colour their output. `NO_COLOR` is forced in the subprocess env, but a wrapper or an older CLI version can still emit escapes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}

/**
 * The preview URL a finished deploy printed, or `null` when the output does
 * not contain one.
 *
 * Matched by LABEL, never by "the first URL in the output". Vercel prints an
 * `Inspect:` dashboard link one line above `Preview:`, and Netlify prints
 * `Build logs:` above `Website draft URL:` — a positional match returns the
 * build-log page on both, which looks like success and is not the site.
 *
 * Vercel's `Preview:` line carries a trailing `[3s]` timing annotation, and
 * both CLIs print progress to stderr and the bare URL to stdout, so both
 * streams are searched.
 */
export function parsePreviewUrl(provider: DeployProvider, stdout: string, stderr: string): string | null {
  const text = stripAnsi(`${stdout}\n${stderr}`)
  for (const pattern of PREVIEW_URL_PATTERNS[provider]) {
    const match = pattern.exec(text)
    const url = match?.[1]
    if (url) return url.replace(/[.,)]+$/, '')
  }
  return null
}

/**
 * Ordered most- to least-specific per provider. The final entry in each list is
 * the bare-URL fallback for the deployment host itself (`*.vercel.app`,
 * `*.netlify.app`) — deliberately host-scoped, so it can never match the
 * dashboard links (`vercel.com`, `app.netlify.com`) the labelled patterns exist
 * to avoid.
 */
const PREVIEW_URL_PATTERNS: Record<DeployProvider, readonly RegExp[]> = {
  vercel: [
    /^\s*Preview:\s*(https:\/\/\S+)/m,
    /^\s*(https:\/\/[^\s/]+\.vercel\.app\S*)\s*$/m,
  ],
  netlify: [
    /^\s*Website draft URL:\s*(https:\/\/\S+)/m,
    /^\s*Unique deploy URL:\s*(https:\/\/\S+)/m,
    /^\s*Website URL:\s*(https:\/\/\S+)/m,
    /^\s*(https:\/\/[^\s/]*\.netlify\.app\S*)\s*$/m,
  ],
}

/** What a `probe` invocation says about this machine's relationship with the provider. */
export interface ProviderAuthState {
  authenticated: boolean
  /** The account the CLI reports, when it names one. Shown so the user can tell WHICH account is about to publish. Never a token. */
  account: string | null
}

/**
 * Reads the auth probe's output. Exit code alone is not enough: `netlify
 * status` exits 0 whether or not anyone is signed in, and reports the fact in
 * prose instead.
 *
 * `stdout` may be empty on a signed-out `vercel whoami`, which puts its error
 * on stderr — both are examined.
 */
export function parseAuthProbe(
  provider: DeployProvider,
  result: { stdout: string; stderr: string; exitCode: number | null },
): ProviderAuthState {
  const stdout = stripAnsi(result.stdout)
  const combined = `${stdout}\n${stripAnsi(result.stderr)}`
  if (/not (currently )?logged in|no existing credentials|please log ?in|not authenticated/i.test(combined)) {
    return { authenticated: false, account: null }
  }

  if (provider === 'vercel') {
    if (result.exitCode !== 0) return { authenticated: false, account: null }
    // `vercel whoami` prints the username alone on stdout; the `> ` progress
    // lines it writes go to stderr.
    const account = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('>')) ?? null
    return { authenticated: account !== null, account }
  }

  // `netlify status` prints a "Current Netlify User" block with Name/Email rows.
  const email = /^\s*Email:\s*(\S+)/m.exec(stdout)?.[1] ?? null
  const name = /^\s*Name:\s*(.+?)\s*$/m.exec(stdout)?.[1] ?? null
  const authenticated = result.exitCode === 0 && (email !== null || name !== null)
  return { authenticated, account: email ?? name }
}

/**
 * True when the CLI's own output says the directory is not linked to a remote
 * project. Used to turn a deploy failure into the one instruction that fixes
 * it (`vercel link` / `netlify link`) rather than a wall of CLI text — and
 * checked on the PROBE too, so the panel can say so before the user waits out
 * a build.
 */
export function mentionsUnlinkedProject(output: string): boolean {
  return /isn'?t linked to a project|not linked to a site|run `?(vercel|netlify) link|link this (directory|folder)/i.test(
    stripAnsi(output),
  )
}
