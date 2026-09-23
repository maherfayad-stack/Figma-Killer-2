# Deployment
> **Purpose:** the deployment targets, their variables and what must persist · **Read when:** deploying or operating a Studio server · **Trust:** current · **Owner:** server-engineer · **Verified:** 2026-09-23

This index maps supported deployment targets to the files, variables, and persistence rules they need.

Studio is one Bun process packaged by the root `Dockerfile`, but it opens TWO listeners: the admin `Bun.serve` on `PORT`, and a second, independent, cookie-free `Bun.serve` on `LIVE_PORT` (`server/liveOrigin.ts`) that proxies a Tier 2 project's own dev server for the live canvas. The server reads runtime configuration from `server/config.ts`: `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, `STATIC_DIR`, `PUBLIC_ORIGIN`, `TRUSTED_PROXY_CIDRS`, `LIVE_PORT`, and `LIVE_ORIGIN`. The workspace root (every user's projects) comes from `STUDIO_WORKSPACE_DIR`, read by `projectsRootDir()` in `server/handlers/studioProjects.ts`. Reversible server secrets, including AI provider credentials, plugin secret settings, and MFA TOTP seeds, are encrypted with `STUDIO_SECRET_KEY` when configured. Database migrations run automatically on boot in `server/index.ts`.

---

## TL;DR

| Target | Use when | Database | Persistent storage | Docs |
|---|---|---|---|---|
| Railway SQLite template | Fastest managed install for a single site | SQLite file | One Railway app volume mounted at `/app/storage` (DB, uploads, workspace) | [railway.md](railway.md) |
| Railway Postgres template | Managed install for teams or horizontal scale later | Railway Postgres | App volume for uploads and workspace, Postgres service volume for DB | [railway.md](railway.md) |
| Render SQLite template | Managed Docker install outside Railway | SQLite file | One Render disk mounted at `/app/storage` (DB, uploads, workspace) | [render.md](render.md) |
| Render Postgres template | Managed Postgres install outside Railway | Render Postgres | Render disk for uploads and workspace, Render Postgres storage for DB | [render.md](render.md) |
| VPS Docker Compose | Self-hosted server, full control | SQLite or bundled Postgres | Docker named volumes (`workspace`, `uploads`, and `data` or `postgres_data`) | [vps.md](vps.md) |
| Generic Docker host | Any platform that runs the Dockerfile/image | SQLite or external Postgres | A mounted directory/volume for DB, uploads and workspace | [docker-image.md](docker-image.md) |
| VPS HTTPS | Public domain on a VPS | Unchanged | Caddy cert volume plus app volumes | [tls-caddy.md](tls-caddy.md) |

Back up the workspace, the database and uploaded media. See [backup-restore.md](backup-restore.md).

**Upgrading an install created before the workspace volume existed?** Its projects are in the container's writable layer and the next recreate deletes them. Copy them out of the running container first: [backup-restore.md](backup-restore.md) → "Moving the workspace onto a volume".

## Runtime Contract

Every deployment target configures the same process:

```txt
PORT          HTTP port the Bun server listens on
DATABASE_URL  sqlite:/path/to/cms.db, file:/path/to/cms.db, postgres://..., or postgresql://...
UPLOADS_DIR   directory for media, plugin packs, fonts, and published disk artefacts
STATIC_DIR    built admin SPA directory; /app/dist in the Docker image
STUDIO_WORKSPACE_DIR  the workspace root: every user's projects, Studio's documents; MUST be on persistent storage
STUDIO_SECRET_KEY  base64 32-byte key for encrypted server secrets
PUBLIC_ORIGIN        comma-separated public origin(s) the CSRF check trusts; auto-detected from RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN on those platforms
TRUSTED_PROXY_CIDRS  optional; trusts proxy socket peers for forwarded client-IP attribution only (audit logs, rate-limit keys) — NOT used for CSRF
LIVE_PORT     port for the second, cookie-free Bun.serve listener that proxies live Tier 2 dev servers; defaults to PORT + 1
LIVE_ORIGIN   public origin of that second listener; defaults to http://localhost:${LIVE_PORT} for local dev — self-hosted/tunneled deployments must set it explicitly
```

Generate `STUDIO_SECRET_KEY` with `bun run scripts/generate-secret-key.ts` before adding Anthropic, OpenAI, or OpenRouter credentials or enabling TOTP MFA in production. Without it, the admin can load but saving reversible secrets fails because there is no stable encryption key.

### The live origin needs its own reachable URL

A Tier 2 project (one promoted to run its own dev server for the live canvas) also needs `LIVE_ORIGIN` reachable at whatever URL you set it to — behind a tunnel or reverse proxy this means tunneling/proxying **two** ports/services, not one, and `LIVE_ORIGIN` must match that second public URL exactly the same way `PUBLIC_ORIGIN` must match the first. Getting `LIVE_ORIGIN` wrong does not open a security hole (no cookies ever flow on this origin, correctly configured or not) — it fails closed, as a blank iframe (CSP framing error) or a silently dropped `postMessage` from a target-origin mismatch. If a live frame won't load, check `LIVE_ORIGIN` and the second tunnel/proxy leg before assuming a product bug.

The Docker image sets:

```txt
PORT=3001
STATIC_DIR=/app/dist
UPLOADS_DIR=/app/uploads
STUDIO_WORKSPACE_DIR=/app/studio-workspace
```

The image creates `/app/studio-workspace` owned by its non-root `bun` user, so an empty named volume mounted there is writable. At boot the server creates the workspace root if it is missing, and logs a `[studio:workspace]` warning if it finds the root on the container's writable layer or a `tmpfs` (`server/handlers/studio/workspacePersistence.ts`).

Managed platforms often override `PORT`. That is fine; the server uses `process.env.PORT`. When a managed platform terminates HTTPS before forwarding HTTP to the container, the CSRF origin check derives the site's public origin from `PUBLIC_ORIGIN` — auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on Render and Railway, so one-click deploys need no manual value. Set `PUBLIC_ORIGIN` explicitly (a comma-separated list) when adding a custom domain. `TRUSTED_PROXY_CIDRS` is independent of CSRF and only attributes the real client IP for audit logs and rate-limit keys.

## Image Availability

Release bundles plus the published GHCR image are the default portable install path:

```sh
STUDIO_IMAGE=ghcr.io/corebunch/studio:latest docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Pin a semver tag for predictable upgrades:

```sh
STUDIO_IMAGE=ghcr.io/corebunch/studio:0.0.11 docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Source builds remain supported for contributors and release-candidate testing:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
```

The maintainer release target is `ghcr.io/corebunch/studio`, documented in [release-workflow.md](release-workflow.md).

## Database Choice

The database engine is selected only by `DATABASE_URL`:

| URL shape | Engine |
|---|---|
| `sqlite:/path/to/cms.db` | SQLite |
| `file:/path/to/cms.db` | SQLite |
| `/path/to/cms.db` | SQLite |
| `postgres://...` | Postgres |
| `postgresql://...` | Postgres |

SQLite is the default for single-site installs. Postgres is for multiple simultaneous admin writers, more than one app container, or operators who already want managed Postgres.

## Persistence Rules

`UPLOADS_DIR` is required for durable media regardless of the database engine. It stores:

- uploaded media originals and variants
- uploaded fonts
- plugin packages and module packs
- published static artefacts under `published/current`

SQLite installs also need the SQLite database file on persistent storage. On platforms with only one app volume, put both the SQLite file and uploads under the same mounted root.

**The Studio workspace needs persistent storage, and every shipped template provides it.** Every project a user edits lives under the workspace root (`STUDIO_WORKSPACE_DIR`; `<cwd>/studio-workspace` when unset). It is Studio's source of truth and has no other copy.

| Target | Workspace root | Persisted by |
|---|---|---|
| VPS Compose (`compose.prod.yml`) | `/app/studio-workspace` | the `workspace` named volume |
| Railway, Render, `docker run` with one volume | `/app/storage/studio-workspace` | the app volume/disk at `/app/storage` |
| Direct Bun install | `<checkout>/studio-workspace` | the host filesystem |

If you mount your own storage, `STUDIO_WORKSPACE_DIR` must point at or inside it. The layout is gated by `src/__tests__/architecture/workspace-volume-persistence.test.ts`, which parses the Dockerfile, every Compose stack, and both Render Blueprints. Installs created before this change must move the workspace once: [backup-restore.md](backup-restore.md) → "Moving the workspace onto a volume". Backup and restore: [backup-restore.md](backup-restore.md) → "The Studio workspace".

## Docs Inventory

| File | Role |
|---|---|
| [railway.md](railway.md) | Railway templates for SQLite and Postgres |
| [render.md](render.md) | Render Blueprint templates for SQLite and Postgres |
| [vps.md](vps.md) | Docker Compose on a VPS, both SQLite and Postgres |
| [docker-image.md](docker-image.md) | Generic Docker image contract and `docker run` examples |
| [tls-caddy.md](tls-caddy.md) | Caddy TLS overlay for VPS Compose installs |
| [backup-restore.md](backup-restore.md) | Workspace, database and uploads backup/restore, and the one-time move of the workspace onto a volume |
| [release-workflow.md](release-workflow.md) | Maintainer image publishing workflow |

## Related

- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `server/index.ts` — migrations, media storage, and server boot
- `Dockerfile` — production image contract
- `compose.prod.yml`, `compose.sqlite.yml`, `compose.tls.yml`, `compose.build.yml` — VPS Compose files
- `server/handlers/studio/workspacePersistence.ts` — creates the workspace root at boot and warns when it is not on persistent storage
- `docs/deployment/render/sqlite/render.yaml`, `docs/deployment/render/postgres/render.yaml` — Render Blueprint templates
