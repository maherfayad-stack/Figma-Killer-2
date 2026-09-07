/**
 * onboardingFacts — the five yes/no questions the launcher's `OnboardingPanel`
 * asks about the system, answered from live state rather than from a flag the
 * checklist set itself.
 *
 * ## Why this is one route and not five client calls
 *
 * Four of the five facts are reads of `studio-workspace/`; the fifth is two
 * database queries. Asking the browser to make five requests would put the
 * fan-out on the slowest link in the chain and expose four new endpoints whose
 * only consumer is one panel. One `GET /admin/api/studio/onboarding` runs the
 * probes concurrently HERE, close to the disk, and answers with five booleans.
 *
 * ## Each fact soft-fails to `false`
 *
 * `Promise.allSettled`, never `Promise.all`: one unreadable `.studio/` sidecar,
 * one project whose git binary is missing, one broken `ai_conversations` table
 * must not take the whole panel down — and must not be reported as a step the
 * user has completed, either. A probe that throws is logged and reads as "not
 * done", which is the safe direction to fail in: at worst the user is invited
 * to do something they have already done.
 *
 * ## Where each fact comes from
 *
 * | Step | Fact |
 * |---|---|
 * | 1. Create or import a project | at least one directory under `studio-workspace/` |
 * | 2. Open it on the board | any project's `.studio/meta.json` has `lastOpenedAt` |
 * | 3. Edit an element's style | see {@link anyProjectEdited} |
 * | 4. Set up the AI assistant | this user has an AI credential OR a conversation |
 * | 5. Try prototype mode | any project's `.studio/prototype.json` has ≥ 1 link |
 *
 * Facts 1, 2, 3 and 5 are about the INSTALL (the projects on this disk); fact 4
 * is about the signed-in USER, because credentials and conversations are
 * per-user rows. That asymmetry is deliberate and matches where each thing
 * actually lives — `lastOpenedAt` is a fact about a project (see its field doc
 * in `studioMeta.ts`), not about who opened it.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { listCredentialsForUser } from '../../ai/credentials/store'
import { listConversationsForUser } from '../../ai/conversations/store'
import { listStudioProjectDirs, projectsRootDir } from '../studioProjects'
import { readStudioMeta } from './studioMeta'
import { readPrototypeFile } from './prototypeStore'
import { PAGE_VERIFICATION_FILE_NAME } from './pageVerificationStore'
import { hasGitRepo } from './gitRunner'
import { isGitFailure, readGitStatus } from './gitOperations'

/**
 * One boolean per onboarding step, in the order the panel renders them.
 *
 * Schema-first so the route's answer and the browser's mirror of it
 * (`useOnboardingFacts.ts`) agree on one shape. The browser keeps its own copy
 * of this schema rather than importing this Node-only module — the same
 * posture `studioProjectTrust.ts` takes for `TrustTierSchema`.
 */
export const OnboardingFactsSchema = Type.Object({
  /** At least one project exists under `studio-workspace/`. */
  projectCreated: Type.Boolean(),
  /** Some project has been loaded on the board at least once. */
  projectOpened: Type.Boolean(),
  /** Some project's source has changed since it was checked out or scaffolded. */
  styleEdited: Type.Boolean(),
  /** This user has an AI credential or has held a conversation. */
  aiConfigured: Type.Boolean(),
  /** Some project has at least one authored prototype link. */
  prototypeLinked: Type.Boolean(),
})
export type OnboardingFacts = Static<typeof OnboardingFactsSchema>

/**
 * How many projects the "has anything been edited?" probe will spawn `git
 * status` for before it stops asking.
 *
 * A subprocess per project on a launcher render is not a cost this answer is
 * worth — and it does not need to be exhaustive: the question is "has the user
 * edited ANYTHING", so the first `true` wins and a run of five negatives is
 * already strong evidence of a fresh install. Ordered by whatever `readdir`
 * returns, because a fresh install has one or two projects and the ordering
 * only matters for a workspace big enough that the answer is almost certainly
 * `true` from the first repo anyway.
 */
const MAX_GIT_PROBES = 5

/** Answers all five questions concurrently. Never throws — see the module doc. */
export async function readOnboardingFacts(db: DbClient, userId: string): Promise<OnboardingFacts> {
  const dirs = listStudioProjectDirs(projectsRootDir())

  const [created, opened, edited, ai, prototyped] = await Promise.allSettled([
    (async () => dirs.length > 0)(),
    (async () => dirs.some((dir) => readStudioMeta(dir).lastOpenedAt !== undefined))(),
    anyProjectEdited(dirs),
    anyAiSetup(db, userId),
    (async () => dirs.some((dir) => readPrototypeFile(dir).links.length > 0))(),
  ])

  return {
    projectCreated: settledFact(created, 'projectCreated'),
    projectOpened: settledFact(opened, 'projectOpened'),
    styleEdited: settledFact(edited, 'styleEdited'),
    aiConfigured: settledFact(ai, 'aiConfigured'),
    prototypeLinked: settledFact(prototyped, 'prototypeLinked'),
  }
}

/** A settled probe's answer, or `false` for one that threw (logged, never rethrown). */
function settledFact(result: PromiseSettledResult<boolean>, label: string): boolean {
  if (result.status === 'fulfilled') return result.value
  console.error(`[studio:onboardingFacts] "${label}" could not be answered — reading it as not done:`, result.reason)
  return false
}

/**
 * "Has the user edited anything in a project yet?"
 *
 * This is step 3's fact, and it is a PROXY: Studio has no per-edit ledger, so
 * there is nothing on disk that says "an element's style was changed" as
 * opposed to "a file was written". The two candidates, cheapest first:
 *
 *   1. **A page-verification cache exists** — one `existsSync`, no subprocess.
 *      Written by `studio_compare` (`pageVerificationStore.ts`), so it proves a
 *      page was written AND visually checked. Narrow: it only ever appears when
 *      the agent has run a visual compare, so it can confirm an edit but never
 *      rule one out. That is why it is not the only signal. Both cache
 *      locations are checked — today's `.studio/cache/`, and the per-user
 *      `.studio/cache/agent/<userHash>/` that W10 moves it into.
 *   2. **A git working tree with changes** — a `git status` subprocess per
 *      repo, capped at {@link MAX_GIT_PROBES}. This is the honest general
 *      signal: every Studio write lands in the user's own source files, so an
 *      edited project is a dirty working tree. Its blind spot is the mirror
 *      image of (1)'s: a scaffolded project is not a git repository at all, so
 *      it can never be dirty.
 *
 * Both are checked, cheap first, and the step ticks on either. A project that
 * is neither a git repo nor has ever been visually compared contributes
 * nothing, and the step stays open — which is the honest answer, since nothing
 * on disk distinguishes that project from one nobody has touched.
 */
async function anyProjectEdited(dirs: string[]): Promise<boolean> {
  if (dirs.some(hasVerifiedPageWrite)) return true

  let probed = 0
  for (const dir of dirs) {
    if (probed >= MAX_GIT_PROBES) break
    // Sync, no subprocess: skipping a non-repo here is what keeps the cap
    // meaningful — otherwise five scaffolded projects would spend the whole
    // budget on `git status` calls that cannot succeed.
    if (!hasGitRepo(dir)) continue
    probed += 1
    const status = await readGitStatus(dir)
    if (!isGitFailure(status) && status.entries.length > 0) return true
  }
  return false
}

/** True when a page-verification cache exists at either the project-wide or a per-user path. */
function hasVerifiedPageWrite(dir: string): boolean {
  const cacheDir = join(dir, '.studio', 'cache')
  if (existsSync(join(cacheDir, PAGE_VERIFICATION_FILE_NAME))) return true
  const agentDir = join(cacheDir, 'agent')
  if (!existsSync(agentDir)) return false
  return readdirSync(agentDir, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(agentDir, entry.name, PAGE_VERIFICATION_FILE_NAME)),
  )
}

/**
 * "Is the AI assistant set up for this user?" — a credential OR a conversation.
 *
 * Either one alone is enough: a user signed in through the CLI has
 * conversations without a stored credential row, and a user who has just
 * pasted an API key has a credential with nothing said yet. Settled
 * independently so a failure on one query cannot hide a `true` from the other.
 */
async function anyAiSetup(db: DbClient, userId: string): Promise<boolean> {
  const [credentials, conversations] = await Promise.allSettled([
    listCredentialsForUser(db, userId),
    listConversationsForUser(db, userId),
  ])
  const hasCredential = credentials.status === 'fulfilled' && credentials.value.length > 0
  const hasConversation = conversations.status === 'fulfilled' && conversations.value.length > 0
  return hasCredential || hasConversation
}
