/**
 * githubPullRequest — "open a pull request for the branch I just pushed".
 *
 * The last step of Studio's publish sentence. Everything before it is git on
 * the user's own disk; this one call is the only place Studio asks GitHub to
 * create something on their behalf, so it is deliberately small and
 * deliberately separate from `gitOperations.ts` — no subprocess, no working
 * tree, one HTTP request.
 *
 * ## The rules
 *
 * - **The token arrives with the request's own session** —
 *   `getGithubTokenForRequest` (`githubToken.ts`, G2), never from the
 *   environment. With no token this module does not fail silently or
 *   half-open something: it answers `no-github-token` **with the compare
 *   URL**, so the panel can say "Sign in to GitHub to open a PR" and still
 *   hand the user a working link. A link is a worse product than a button and
 *   a much better one than a dead end.
 * - **The token is never logged and never echoed.** It appears in exactly one
 *   place, an `Authorization` header, and in no error message.
 * - **`owner`/`repo` come from `gitPaths.parseGithubRemoteUrl`**, the same
 *   allowlist `POST git/remote` validates a URL with. There is one definition
 *   of "is this a GitHub remote, and is the owner/repo sane" in this feature,
 *   not two that can drift.
 * - **GitHub's own refusal is passed through verbatim.** "A pull request
 *   already exists", "No commits between main and feat/x" — those are the
 *   whole answer, and they name a repository, never this server's filesystem.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import type { GithubRemote } from './gitPaths'

/** The subset of `GithubRemote` a pull request needs. `parseGithubRemoteUrl`'s result satisfies it structurally. */
export type GithubRepoTarget = Pick<GithubRemote, 'owner' | 'repo'>

/**
 * GitHub's "open a pull request" page, pre-filled — the fallback when there is
 * no token, and the link the panel offers beside the button.
 *
 * Branch names may legally contain `/`, which is a path separator GitHub wants
 * left alone, so each ref is percent-encoded and its slashes restored.
 */
export function githubCompareUrl(target: GithubRepoTarget, base: string, head: string): string {
  return `https://github.com/${target.owner}/${target.repo}/compare/${encodeRef(base)}...${encodeRef(head)}?expand=1`
}

function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/gi, '/')
}

/** The two fields of GitHub's response Studio uses. Everything else in that payload is ignored on purpose. */
const PullRequestResponseSchema = Type.Object({
  html_url: Type.String(),
  number: Type.Number(),
})

export interface OpenPullRequestInput {
  target: GithubRepoTarget
  title: string
  body: string
  /** The branch to merge INTO. */
  base: string
  /** The branch being proposed. */
  head: string
  /** The requesting user's own token. Absent is a named refusal, not a silent anonymous attempt. */
  token: string | null
}

export interface PullRequestSuccess {
  ok: true
  url: string
  number: number
  /** Always present, so the panel can offer the link alongside the opened PR. */
  compareUrl: string
}

export type PullRequestFailureCode =
  /** Nobody has connected a GitHub account, so there is no identity to open a PR as. */
  | 'no-github-token'
  /** GitHub answered, and said no. Its message is the answer. */
  | 'github-rejected'
  /** GitHub could not be reached, or answered 5xx. Not the user's fault and not a refusal. */
  | 'github-unreachable'

export interface PullRequestFailure {
  ok: false
  code: PullRequestFailureCode
  message: string
  /** Always present — the panel shows it as a link, so a refusal is still a way forward. */
  compareUrl: string
}

export interface PullRequestDeps {
  /** Test seam. Defaults to the global `fetch`; no test in this repo talks to github.com. */
  fetchImpl?: typeof fetch
}

/**
 * `POST /repos/{owner}/{repo}/pulls`.
 *
 * Never throws for an expected outcome — a missing token, a GitHub refusal and
 * an unreachable GitHub are all typed failures the route maps to a status,
 * because each one has a different next action for the user.
 */
export async function openGithubPullRequest(
  input: OpenPullRequestInput,
  deps: PullRequestDeps = {},
): Promise<PullRequestSuccess | PullRequestFailure> {
  const compareUrl = githubCompareUrl(input.target, input.base, input.head)
  if (!input.token) {
    return {
      ok: false,
      code: 'no-github-token',
      message: 'Sign in to GitHub to open a pull request from Studio. Until then, use the compare link.',
      compareUrl,
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const endpoint = `https://api.github.com/repos/${input.target.owner}/${input.target.repo}/pulls`

  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        // The ONLY place the token appears. Not logged, not echoed, not stored.
        authorization: `Bearer ${input.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'studio-pull-request',
      },
      body: JSON.stringify({ title: input.title, body: input.body, base: input.base, head: input.head }),
    })
  } catch (err) {
    return {
      ok: false,
      code: 'github-unreachable',
      message: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      compareUrl,
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      code: res.status >= 500 ? 'github-unreachable' : 'github-rejected',
      message: await githubErrorMessage(res),
      compareUrl,
    }
  }

  const parsed = await parseJsonResponse(res, PullRequestResponseSchema)
  return { ok: true, url: parsed.html_url, number: parsed.number, compareUrl }
}

/**
 * GitHub's own words, trimmed to something safe to show.
 *
 * Its error payload is `{ message, errors?: [{ message }] }`, and the nested
 * entry is usually the useful one ("No commits between main and feat/x").
 * Read defensively rather than through a schema: this is an error path, and
 * failing to parse an error would replace a real explanation with a generic
 * one. Nothing here can name this server's filesystem — the payload is
 * GitHub's.
 */
async function githubErrorMessage(res: Response): Promise<string> {
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return `GitHub refused the pull request (HTTP ${res.status}).`
  }
  const parts: string[] = []
  if (isRecord(payload) && typeof payload.message === 'string') parts.push(payload.message)
  if (isRecord(payload) && Array.isArray(payload.errors)) {
    for (const entry of payload.errors) {
      if (isRecord(entry) && typeof entry.message === 'string') parts.push(entry.message)
    }
  }
  const joined = parts.join(' — ').trim()
  return (joined || `GitHub refused the pull request (HTTP ${res.status}).`).slice(0, 2000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
