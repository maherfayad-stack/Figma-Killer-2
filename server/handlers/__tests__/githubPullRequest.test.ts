/**
 * githubPullRequest — the one call Studio makes to GitHub on a user's behalf.
 *
 * Nothing here touches the network: `fetchImpl` is injected, so every
 * assertion is about what Studio SENDS and how it reads what comes back. The
 * rules worth a test are the ones that would be invisible failures in
 * production:
 *
 *   - no token ⇒ a NAMED refusal carrying the compare URL, never an anonymous
 *     attempt and never a dead end;
 *   - the token appears in the `Authorization` header and nowhere else —
 *     not in the body, not in the URL, not in any message;
 *   - GitHub's own refusal is passed through, because "No commits between
 *     main and feat/x" is the entire answer;
 *   - a 5xx is `github-unreachable` (retry), a 4xx is `github-rejected`
 *     (the user has to do something) — two different next actions.
 */
import { describe, expect, it } from 'bun:test'
import { githubCompareUrl, openGithubPullRequest } from '../studio/githubPullRequest'

const TARGET = { owner: 'acme', repo: 'storefront' }

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** Records exactly one call so the request can be asserted field by field. */
function recordingFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('githubCompareUrl', () => {
  it('builds GitHub\'s pre-filled compare page', () => {
    expect(githubCompareUrl(TARGET, 'main', 'feat/sidebar')).toBe(
      'https://github.com/acme/storefront/compare/main...feat/sidebar?expand=1',
    )
  })

  it('keeps the slashes in a branch name rather than percent-encoding them into nonsense', () => {
    const url = githubCompareUrl(TARGET, 'release/2026', 'feat/a/b')
    expect(url).toContain('release/2026...feat/a/b')
    expect(url).not.toContain('%2F')
  })

  it('still escapes a character that would break the URL', () => {
    expect(githubCompareUrl(TARGET, 'main', 'feat/a b')).toContain('feat/a%20b')
  })
})

describe('openGithubPullRequest', () => {
  it('sends title, body, base and head, and reads the URL and number back', async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(201, { html_url: 'https://github.com/acme/storefront/pull/7', number: 7, ignored: 'field' }),
    )

    const result = await openGithubPullRequest(
      { target: TARGET, title: 'Add the sidebar', body: '- Add the sidebar', base: 'main', head: 'feat/sidebar', token: 'ghp_secret' },
      { fetchImpl },
    )

    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/acme/storefront/pull/7',
      number: 7,
      compareUrl: 'https://github.com/acme/storefront/compare/main...feat/sidebar?expand=1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/storefront/pulls')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      title: 'Add the sidebar',
      body: '- Add the sidebar',
      base: 'main',
      head: 'feat/sidebar',
    })
  })

  it('puts the token in the Authorization header and NOWHERE else', async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(201, { html_url: 'https://github.com/acme/storefront/pull/1', number: 1 }),
    )
    await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_do_not_leak' },
      { fetchImpl },
    )

    const { url, init } = calls[0]!
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ghp_do_not_leak')
    expect(url).not.toContain('ghp_do_not_leak')
    expect(String(init.body)).not.toContain('ghp_do_not_leak')
  })

  it('refuses by name with the compare URL when there is no token — and never calls GitHub', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse(201, {}))

    const result = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: null },
      { fetchImpl },
    )

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({
      code: 'no-github-token',
      compareUrl: 'https://github.com/acme/storefront/compare/main...feat/x?expand=1',
    })
    // The whole point: a missing token is answered, not attempted.
    expect(calls).toHaveLength(0)
  })

  it('passes GitHub\'s own refusal through — that message IS the answer', async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(422, {
        message: 'Validation Failed',
        errors: [{ message: 'No commits between main and feat/x' }],
      }),
    )

    const result = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_x' },
      { fetchImpl },
    )

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'github-rejected' })
    expect((result as { message: string }).message).toContain('No commits between main and feat/x')
  })

  it('distinguishes "GitHub said no" from "GitHub was not there"', async () => {
    const rejected = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_x' },
      { fetchImpl: recordingFetch(jsonResponse(403, { message: 'Resource not accessible' })).fetchImpl },
    )
    expect(rejected).toMatchObject({ ok: false, code: 'github-rejected' })

    const unreachable = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_x' },
      { fetchImpl: recordingFetch(jsonResponse(503, { message: 'Service unavailable' })).fetchImpl },
    )
    expect(unreachable).toMatchObject({ ok: false, code: 'github-unreachable' })
  })

  it('answers unreachable — with the compare URL — when the fetch itself throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }) as unknown as typeof fetch

    const result = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_x' },
      { fetchImpl },
    )
    expect(result).toMatchObject({ ok: false, code: 'github-unreachable' })
    expect((result as { compareUrl: string }).compareUrl).toContain('/compare/main...feat/x')
  })

  it('degrades to a status-only message when GitHub\'s error body is not JSON', async () => {
    const fetchImpl = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    const result = await openGithubPullRequest(
      { target: TARGET, title: 't', body: 'b', base: 'main', head: 'feat/x', token: 'ghp_x' },
      { fetchImpl },
    )
    expect((result as { message: string }).message).toContain('502')
  })
})
