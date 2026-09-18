/**
 * githubApi — the two GitHub REST reads Studio makes on a user's behalf, and
 * the one place a token becomes an `Authorization` header.
 *
 *   `GET /user`       → who this token belongs to (login + avatar), which is
 *                       also how a pasted PAT is VALIDATED: a token GitHub
 *                       will not identify is not stored.
 *   `GET /user/repos` → what the Connect picker offers instead of making the
 *                       user go and copy a URL out of a browser tab.
 *
 * ## The rules
 *
 * - **A token arrives as an argument.** Nothing here reads one from
 *   `process.env` or from the credential store; the caller decrypted exactly
 *   one for exactly this call.
 * - **Every response body goes through TypeBox.** `parseJsonResponse` is the
 *   sanctioned primitive for a server-side fetch of an external API — the
 *   schemas are deliberately narrow (`additionalProperties` left open, only
 *   the fields Studio uses declared) so a GitHub field addition is not a
 *   failure and a field *removal* is.
 * - **Failures never carry the token, and never carry GitHub's raw body.**
 *   A `GithubApiError` says what happened and what status came back; the
 *   route maps it to an envelope.
 * - **The result set is capped.** `listGithubRepositories` asks for one page
 *   of 100, sorted by most recently pushed. A picker is not an inventory, and
 *   an account with 3,000 repositories must not turn one click into thirty
 *   requests.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonResponse } from '@core/utils/jsonValidate'

const GITHUB_API_ORIGIN = 'https://api.github.com'
/** Identifies Studio to GitHub. Required — the API rejects a request with no user agent. */
const USER_AGENT = 'studio-git-integration'
/** GitHub's current REST version pin. Without it the API silently follows whatever the default becomes. */
const API_VERSION = '2022-11-28'
/** One page. See the module doc: a picker, not an inventory. */
const REPO_PAGE_SIZE = 100
/** A read Studio makes while a user watches a spinner. Longer than this and the honest answer is "GitHub did not respond". */
const REQUEST_TIMEOUT_MS = 15_000

/** A GitHub read that did not produce a usable answer. `status` is GitHub's, or 502 when the request never completed. */
export class GithubApiError extends Error {
  readonly status: number

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GithubApiError'
    this.status = status
  }
}

const GithubUserSchema = Type.Object(
  {
    login: Type.String(),
    avatar_url: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const GithubRepoSchema = Type.Object(
  {
    full_name: Type.String(),
    clone_url: Type.String(),
    private: Type.Boolean(),
    default_branch: Type.Optional(Type.String()),
    pushed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
)

const GithubRepoListSchema = Type.Array(GithubRepoSchema)

/** One repository as the Connect picker renders it — never GitHub's whole object. */
export const GithubRepositorySchema = Type.Object({
  /** `owner/repo`. */
  fullName: Type.String(),
  /** The HTTPS clone URL, which is also exactly what `POST git/remote` accepts. */
  cloneUrl: Type.String(),
  isPrivate: Type.Boolean(),
  defaultBranch: Type.Union([Type.String(), Type.Null()]),
  pushedAt: Type.Union([Type.String(), Type.Null()]),
})
export type GithubRepository = Static<typeof GithubRepositorySchema>

export interface GithubIdentity {
  login: string
  avatarUrl: string | null
  /** Scopes the token actually carries, read off the `x-oauth-scopes` response header. Empty for a fine-grained PAT, which does not report them. */
  scopes: string[]
}

export interface GithubApiDeps {
  /** Injected by tests so no case ever touches github.com. Production passes nothing. */
  fetchImpl?: typeof fetch
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  }
}

async function githubGet(path: string, token: string, deps: GithubApiDeps): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // The message is ours, not the exception's: a fetch failure can quote a
    // proxy URL, and this string is on its way to a browser.
    throw new GithubApiError('Could not reach GitHub.', 502, { cause: err })
  }
  if (!res.ok) {
    if (res.status === 401) throw new GithubApiError('GitHub rejected this token. Sign in again.', 401)
    if (res.status === 403) throw new GithubApiError('GitHub refused the request — the token may lack the repo scope.', 403)
    throw new GithubApiError(`GitHub answered with an unexpected status (${res.status}).`, 502)
  }
  return res
}

/**
 * Who the token belongs to. This doubles as validation: `POST github/token`
 * calls it before storing a pasted PAT, so a typo is rejected at the moment it
 * is pasted rather than at the moment a push fails.
 */
export async function readGithubIdentity(token: string, deps: GithubApiDeps = {}): Promise<GithubIdentity> {
  const res = await githubGet('/user', token, deps)
  const scopes = (res.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
  const user = await parseJsonResponse(res, GithubUserSchema)
  return { login: user.login, avatarUrl: user.avatar_url ?? null, scopes }
}

/**
 * The repositories this token can push to, most recently pushed first. One
 * page — see the module doc. `affiliation` includes repos the user
 * collaborates on but does not own, because those are the ones a designer is
 * most often handed.
 */
export async function listGithubRepositories(
  token: string,
  deps: GithubApiDeps = {},
): Promise<GithubRepository[]> {
  const res = await githubGet(
    `/user/repos?per_page=${REPO_PAGE_SIZE}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    token,
    deps,
  )
  const repos = await parseJsonResponse(res, GithubRepoListSchema)
  return repos.map((repo) => ({
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    isPrivate: repo.private,
    defaultBranch: repo.default_branch ?? null,
    pushedAt: repo.pushed_at ?? null,
  }))
}
