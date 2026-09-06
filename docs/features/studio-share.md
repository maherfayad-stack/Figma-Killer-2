# Studio share links

**Status:** v1 (W5-2). Needs human dogfooding — open a created link in a
private window, on a machine that is not signed in.

Until this landed, Studio had exactly one way to show work to somebody who is
not an editor: "Download code", which hands a reviewer a zip of a React
project. Share links are the other end of that spectrum. One URL, no account,
read-only, revocable.

---

## The shape

| Layer | Module | Owns |
|---|---|---|
| Wire contract | `src/core/studio-share/shareWire.ts` | Both payload shapes, the token/filename grammars, the route constants |
| Registry | `server/handlers/studio/shareStore.ts` | `.studio/shares.json`, token minting + constant-time matching, revocation, cross-project lookup, path containment |
| Snapshot writer | `server/handlers/studio/shareSnapshot.ts` | Driving the headless capture and writing `.studio/shares/<token>/` |
| Public routes | `server/handlers/studio/sharePublic.ts` | `/share/<token>` and its two sub-paths. No auth, no database |
| Management routes | `server/handlers/studio/shareRoutes.ts` | `/admin/api/studio/shares` — session-gated create / list / update / revoke |
| Viewer | `share.html` + `src/admin/shareViewer/` | The third Vite HTML entry. Pan/zoom over PNGs; no editor code |
| Client | `src/admin/pages/site/studio/shareLinks.ts` | The four `apiRequest` calls |
| Dialog | `src/admin/pages/site/toolbar/ShareBoardButton.tsx` + `ShareDialog.tsx` | The Share button and its list |

---

## The model

A share is four facts, persisted in `<project>/.studio/shares.json`:

```json
{
  "version": 1,
  "shares": [
    {
      "token": "shr_<43 base64url chars>",
      "boardId": "board-1",
      "boardName": "Board 1",
      "createdAt": "2026-09-05T09:00:00.000Z",
      "snapshotAt": "2026-09-05T09:00:00.000Z",
      "frameCount": 7
    }
  ]
}
```

On disk, not in the database — Studio state belongs on disk, so a project you
copy, zip or `git clone` carries its shares with it and deleting the project
deletes them.

`createdAt` is the link's age; `snapshotAt` is the picture's. They diverge the
first time somebody presses **Update**, and the dialog shows the second one.

The bytes live beside the registry, one directory per share:

```
.studio/shares/<token>/board.json      the manifest a viewer reads
.studio/shares/<token>/<id>-<n>.png    one frame, opaque filename
```

---

## v1 is a snapshot, on purpose

Creating a share photographs the board *once*. It is not a live view, and the
UI says so on every row ("shared \<time\>", with **Update** as the action).

A live share would have to keep the parser (and a browser) on the request path
for an anonymous visitor, and it would silently change under a reviewer
mid-review. Neither is a v1 problem worth taking on. "Update" re-captures in
place: the link is unchanged, the pictures are new.

Capture reuses **W4-2A's machinery verbatim** — `captureFrames`, headless
first, with the owner's open editor tab as the fallback. A second rasteriser
would be a second thing to keep in step with the canvas, and the first time
the two disagreed a share would stop looking like the board it claims to show.

---

## Routes

### Public — no auth, no cookies, no database

| Method | Path | Returns |
|---|---|---|
| GET | `/share/<token>` | The viewer HTML. `no-store`, `X-Robots-Tag: noindex, nofollow` |
| GET | `/share/<token>/board.json` | The manifest. `no-store` — this request *is* the revocation check |
| GET | `/share/<token>/frames/<id>-<n>.png` | One frame. `private, max-age=31536000, immutable` |

Mounted in `server/router.ts` alongside the other unauthenticated `/_studio/*`
namespaces and **before** the static-asset and published-page resolvers, whose
fallbacks would otherwise answer a share URL with something else. The namespace
is absorbed: an unknown sub-path or method 404s here rather than falling
through.

The images can be cached hard because their filenames embed a per-snapshot id,
so an update produces names no cache has seen. The manifest never is.

### Management — session required on every verb

| Method | Path | Does |
|---|---|---|
| GET | `/admin/api/studio/shares?dir=` | Lists this project's shares, newest first, revoked included |
| POST | `/admin/api/studio/shares` | `{ dir?, boardId?, token? }` — captures. With `token`, updates that share in place |
| DELETE | `/admin/api/studio/shares?dir=&token=` | Revokes |

Called outside `STUDIO_SUB_ROUTERS` for the same reason `commentsRoutes.ts`
is: it needs the `DbClient` the uniform `(req, url, pathname)` signature does
not carry. Any authenticated role may manage shares — sharing is the
reviewer-facing half of the product, so gating it above the role that does the
design work would defeat the point.

---

## What a viewer can see, and what it cannot

`board.json` carries a project name, a board name, a timestamp, and per frame
a **display title, a rectangle, and an image filename**. That is the entire
payload.

It carries no page id, no source path, no node id, no style rule, no class
name, no framework settings, and no workspace directory — and the image
filenames are `<snapshotId>-<index>.png`, so even the *names* say nothing
about the repository. `shareSnapshot.test.ts` asserts this directly by
grepping the written manifest for each of those strings.

The viewer is Vite's third HTML entry rather than a route inside the admin
SPA, which makes "contains no editor code" structural rather than a promise: a
route would still boot the admin router, the session probe, the toast
provider, the plugin runtime and the shell preload. The entry's whole module
graph is React, `@core/http`, the wire schemas, the `Button` primitive and the
viewer.

---

## Security posture

- **The token is the entire credential.** 32 bytes (256 bits) from the CSPRNG,
  base64url. There is no rate limit in front of a share link, so the only
  thing between a stranger and a board is that the space is not searchable.
- **Constant-time matching.** Tokens are compared as SHA-256 digests, so the
  comparison is fixed-width regardless of input length and the scan does not
  exit early on the matching record.
- **Revocation is immediate.** Every public request re-reads `shares.json`;
  nothing is ever served from static hosting. Revoking also *deletes* the
  snapshot bytes, so a future bug in the serving path has nothing to leak.
  (Frames already fetched by a viewer's browser stay in that browser's cache —
  which is a viewer who had already seen them.)
- **One 404 for everything.** Malformed token, unknown token, revoked share,
  deleted project, missing file, wrong method: identical response. Telling a
  stranger *which* would tell them whether a token was ever real.
- **Path containment, twice.** The token and the image filename are each
  matched against a fixed grammar *before* becoming a path segment, and the
  resolved path is then real-path containment-checked against the share's own
  directory — so a symlink planted inside `.studio/` gets caught too. `dir`
  never appears in a URL at all; it is derived from the token.
- **Unlisted, not public.** The viewer HTML carries `noindex, nofollow`, and
  frame images are `private`-cached so a shared proxy never holds them.

---

## Dev mode

Vite serves the admin app on 5173 and would answer `/share/<token>` with the
*admin* entry via its SPA fallback. So the Bun handler redirects to Vite's own
`/share.html?token=…` when there is no build on disk — the same two-mode dance
`captureRoute.ts` does. `vite.config.ts` proxies `^/share/` (a regex, so it
does not swallow `/share.html` itself) back to Bun, which is why the viewer's
`board.json` and PNG fetches resolve in dev.

---

## Not in v1

- **Comments on a share.** The reviewer model already exists
  (`commentsRoutes.ts`), and a share is the surface it wants — but comments
  carry a byline, and an anonymous viewer has no honest one. That is a real
  design question (invite links? a name box? a magic-link identity?), not a
  wiring task, so v1.5 owns it. The seam is the token: a share already
  resolves to `(dir, record)`, which is everything a comment write would need
  besides an author.
- **Expiry.** A share lives until revoked.
- **Per-share passwords or allowlists.**
- **A live (non-snapshot) view.**
