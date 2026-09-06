/**
 * deploySchema — the pure schema leaf for W5-4 preview deploys.
 *
 * `studioMeta.ts` persists a `lastDeploy` record in `.studio/meta.json`, and
 * `deployJobs.ts` (which writes that record) imports `mergeStudioMeta` from
 * `studioMeta.ts`. Declaring the shape in either of those files would close a
 * cycle, so it lives here instead — the same split, for the same reason, as
 * `projectProfileSchema.ts` (see its use in `studioMeta.ts`'s module doc).
 *
 * Nothing here imports anything but TypeBox. Keep it that way.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * The two providers Studio can hand a build to. Both are detected from a file
 * the project already owns (`vercel.json` / `netlify.toml`) and driven through
 * the provider's OWN CLI, using that CLI's OWN auth state on this machine.
 * **Studio stores no provider token and accepts none on any wire** — see
 * `deployRunner.ts`'s env allowlist.
 */
export const DeployProviderSchema = Type.Union([Type.Literal('vercel'), Type.Literal('netlify')])
export type DeployProvider = Static<typeof DeployProviderSchema>

/**
 * `'interrupted'` is the one status a live job never carries: it is the honest
 * outcome of "the server restarted while this deploy was running, so its result
 * could not be observed" — the same posture `installDeps.ts` takes for an
 * orphaned install job, and for the same reason (a phantom `'running'` is a
 * poll loop with no end).
 */
export const DeployJobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('timeout'),
  Type.Literal('interrupted'),
])
export type DeployJobStatus = Static<typeof DeployJobStatusSchema>

/**
 * Where a running job is. Two subprocesses run in sequence — the project's own
 * build, then the upload — and they fail for completely different reasons, so
 * the phase is reported rather than inferred from a log the user has to read.
 */
export const DeployPhaseSchema = Type.Union([
  Type.Literal('checking'),
  Type.Literal('building'),
  Type.Literal('deploying'),
  Type.Literal('finished'),
])
export type DeployPhase = Static<typeof DeployPhaseSchema>

/**
 * The record persisted to `.studio/meta.json` as `lastDeploy` — one per
 * project, overwritten by each deploy.
 *
 * It carries **no log**: `meta.json` is a small, hand-editable sidecar holding
 * the user's own project settings, and a capped 200 kB CLI transcript does not
 * belong in it. The log lives in the in-memory job for as long as this process
 * does; this record is what survives, and what the panel shows when you reopen
 * a project days later ("last preview: <url>, from <branch>").
 *
 * `dirty` records whether the working tree had uncommitted changes at the
 * moment the deploy started. Previews of work in progress are the point, so
 * this is not a refusal — but "which of my edits is that URL showing?" is a
 * question the record should be able to answer.
 */
export const LastDeploySchema = Type.Object({
  id: Type.String(),
  provider: DeployProviderSchema,
  status: DeployJobStatusSchema,
  /** The parsed preview URL, or `null` when the deploy never produced one. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** The branch HEAD was on, or `null` for a detached HEAD or a project with no repository. */
  branch: Type.Union([Type.String(), Type.Null()]),
  /** Uncommitted changes were present when this deploy started. */
  dirty: Type.Boolean(),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
  /** A one-line, client-safe summary — the failure reason, or the provider's own success line. */
  message: Type.String(),
})
export type LastDeploy = Static<typeof LastDeploySchema>
