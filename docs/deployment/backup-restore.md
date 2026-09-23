# Backup And Restore
> **Purpose:** what to back up and how to restore it: the workspace, the database, uploads · **Read when:** backing up, restoring or migrating an install · **Trust:** current · **Owner:** server-engineer · **Verified:** 2026-09-23

A complete backup has three parts: **the Studio workspace** (`studio-workspace/`, the user's React projects: Studio's actual documents), the database, and the uploaded media. The database procedure depends on whether you're using Postgres or SQLite; pick the matching section below. The workspace and uploads are plain directories.

---

## TL;DR

| Deployment | Workspace backup | Database backup | Upload backup |
|---|---|---|---|
| VPS SQLite Compose | Archive the `workspace` volume | Copy `/app/data/cms.db` from the `data` volume | Archive the `uploads` volume |
| VPS Postgres Compose | Archive the `workspace` volume | `pg_dump` from the `postgres` service | Archive the `uploads` volume |
| Railway / Render SQLite | Same app volume, under `/app/storage/studio-workspace` | Back up the app volume mounted at `/app/storage` | Same app volume, under `/app/storage/uploads` |
| Railway / Render Postgres | Same app volume, under `/app/storage/studio-workspace` | Back up the Postgres service volume/database | Back up the app volume mounted at `/app/storage` |

- **The workspace is the user's work.** Every project a user opened, imported or created lives under the workspace root (`STUDIO_WORKSPACE_DIR`, default `<cwd>/studio-workspace`), one folder per project: its `.tsx`/`.css` source (edited in place by Studio), its `.git`, and its `.studio/` sidecar (boards, comments, prototype links, the trust tier). A backup without it loses every design.
- **Every shipped image and template now persists it.** The image sets `STUDIO_WORKSPACE_DIR=/app/studio-workspace`; `compose.prod.yml` mounts the `workspace` named volume there; the Railway and Render templates point it at `/app/storage/studio-workspace` on their one app disk. **Installs created before this change kept it in the container's writable layer** and must move it once, before their next recreate: see "Moving the workspace onto a volume" below. The server logs a `[studio:workspace]` warning at boot when it finds the root on a container's writable layer.
- **`.data/` holds per-server private state** (`<cwd>/.data/`: MCP server secrets, the Claude CLI's config directory, the project seed, idempotency records). It is not user content, but losing it signs agent connectors and the CLI out. Back it up with the workspace if those matter to you; each location has its own `*_DIR` override.

## The Studio workspace

The workspace is a directory tree; archive it while no one is editing (Studio writes source files in place).

VPS Compose installs keep it in the `workspace` named volume:

```sh
docker run --rm \
  -v studio-prod_workspace:/workspace:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf "/backup/studio-workspace-$(date +%F).tgz" -C /workspace .
```

Restore it into the volume with the app stopped. Extracting as root keeps the archived owner (the image's `bun` user), so Studio can still write the files:

```sh
docker compose -f compose.prod.yml stop app
docker run --rm \
  -v studio-prod_workspace:/workspace \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -lc "find /workspace -mindepth 1 -delete && tar xzf /backup/studio-workspace-YYYY-MM-DD.tgz -C /workspace"
docker compose -f compose.prod.yml up -d
```

If your Compose project name is not `studio-prod`, find the volume with `docker volume ls | grep workspace`. Add `-f compose.sqlite.yml` to the `docker compose` commands on SQLite installs.

Without Docker, archive the directory directly:

```sh
# default location, from the Studio checkout
tar czf "backups/studio-workspace-$(date +%F).tgz" studio-workspace

# or, when STUDIO_WORKSPACE_DIR is set
tar czf "backups/studio-workspace-$(date +%F).tgz" -C "$STUDIO_WORKSPACE_DIR" .
```

On Railway and Render the workspace is under `/app/storage/studio-workspace`, on the same app volume as the SQLite file and uploads, so the platform's volume or disk backup covers it. Projects that are git repositories can also be pushed to their remotes from Studio's Version control panel, which is an independent copy of their source but not of `.studio/`.

## Moving the workspace onto a volume

**Do this once, if your install was created before the image set `STUDIO_WORKSPACE_DIR` (every install before this change).** Those installs kept the workspace in the container's writable layer. Recreating the container (`docker compose up -d` after a pull or a Compose-file change, a platform redeploy, a variable change) deletes that layer. So copy the projects out of the **running, old** container **before** you pull, update the Compose files, or redeploy. A new container cannot recover them afterwards.

A running server that has this problem says so at boot, in a `[studio:workspace]` warning line (from releases that include the check). Check whether there is anything to move:

```sh
docker compose -f compose.prod.yml exec app ls /app/studio-workspace
```

### VPS Compose

Use the same `-f` files you normally run with. The example below is SQLite; drop `-f compose.sqlite.yml` for Postgres, and add `-f compose.tls.yml` if you use it.

```sh
COMPOSE="docker compose -f compose.prod.yml -f compose.sqlite.yml"

# 1. With the OLD container still running, copy the workspace out to the host.
$COMPOSE cp app:/app/studio-workspace ./studio-workspace-migrate
ls ./studio-workspace-migrate            # every project folder should be here

# 2. Update the Compose files (git pull, or unpack the new release bundle), then recreate.
#    The new compose.prod.yml adds the `workspace` volume at /app/studio-workspace.
$COMPOSE pull app                        # image-pull installs; source builds run `up -d --build` instead
$COMPOSE up -d

# 3. Copy the projects into the new volume and hand them to the image's non-root user.
#    `docker cp` writes files as root and Studio runs as `bun`, so the chown is required.
$COMPOSE cp ./studio-workspace-migrate/. app:/app/studio-workspace/
$COMPOSE exec -u root app chown -R bun:bun /app/studio-workspace
```

Studio lists no projects between steps 2 and 3. Keep `./studio-workspace-migrate` until you have opened the projects in Studio and confirmed they are all there.

### Generic `docker run`

If the container already mounts a volume at `/app/storage`, copy inside the running container, then recreate it with `-e STUDIO_WORKSPACE_DIR=/app/storage/studio-workspace` (see [docker-image.md](docker-image.md)):

```sh
docker exec studio sh -c 'mkdir -p /app/storage/studio-workspace && cp -a /app/studio-workspace/. /app/storage/studio-workspace/'
```

### Railway and Render

The running service already has its volume or disk at `/app/storage`, so copy inside it, then set the variable:

1. **Turn off automatic image updates** (Railway Image Auto Updates) until you have finished, because an update recreates the container.
2. Open a shell on the **running** service (`railway ssh`, or the Render dashboard's **Shell** tab) and run:
   ```sh
   mkdir -p /app/storage/studio-workspace && cp -a /app/studio-workspace/. /app/storage/studio-workspace/
   ls /app/storage/studio-workspace
   ```
3. Add the variable `STUDIO_WORKSPACE_DIR=/app/storage/studio-workspace` to the service. Saving it redeploys the service, and the new container reads the projects from the volume.

### Ownership, and bind mounts

The image runs as the non-root `bun` user, and the workspace root must be writable by it:

- A **named volume** (the shipped `workspace` volume) starts as a copy of the image's own `/app/studio-workspace`, which is created `bun`-owned, so it needs nothing. Anything you later copy in with `docker cp` is root-owned and needs the `chown` above.
- A **bind mount** of a host directory keeps the host's ownership. Make it writable by the container's `bun` user (UID 1000 in the `oven/bun` base image; confirm with `docker compose exec app id`), for example `sudo chown -R 1000:1000 /srv/studio-workspace`. Do not make it world-writable.
- Railway runs the container as root (`RAILWAY_RUN_UID=0`), so its volume needs nothing.

## Postgres mode — backup

Create a local backup directory:

```sh
mkdir -p backups
```

Load environment values from `.env`:

```sh
set -a
. ./.env
set +a
```

Dump Postgres:

```sh
docker compose -f compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "backups/studio-$(date +%F).sql"
```

Archive uploads:

```sh
docker run --rm \
  -v studio-prod_uploads:/uploads:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf "/backup/studio-uploads-$(date +%F).tgz" -C /uploads .
```

If your Compose project name is not `studio-prod`, find the actual uploads volume name with `docker volume ls | grep uploads`.

## Postgres mode — restore

Start Postgres before restoring:

```sh
docker compose -f compose.prod.yml up -d postgres
```

Restore the database:

```sh
set -a
. ./.env
set +a

cat backups/studio-YYYY-MM-DD.sql | docker compose -f compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

Restore uploads:

```sh
docker run --rm \
  -v studio-prod_uploads:/uploads \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -lc "rm -rf /uploads/* && tar xzf /backup/studio-uploads-YYYY-MM-DD.tgz -C /uploads"
```

Then start the full stack:

```sh
docker compose -f compose.prod.yml up -d
```

## SQLite mode — backup

The `compose.sqlite.yml` override stores the SQLite database in the `data` named volume at `/app/data/cms.db`. Both ad-hoc and continuous strategies are documented below.

### Ad-hoc snapshot (transactional, safe while the app is running)

Use Bun (already in the app container) and SQLite's online backup API to capture a consistent snapshot without stopping the CMS:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml exec app \
  bun -e "import { Database } from 'bun:sqlite'; const src = new Database('/app/data/cms.db', { readonly: true }); src.exec(\"VACUUM INTO '/app/data/snapshot.db'\");"

docker compose -f compose.prod.yml -f compose.sqlite.yml cp \
  app:/app/data/snapshot.db "./backups/studio-$(date +%F).db"

docker compose -f compose.prod.yml -f compose.sqlite.yml exec app \
  rm /app/data/snapshot.db
```

`VACUUM INTO` writes a fully consistent copy of the database to a new file — safe to run live, no locking required. Then `docker compose cp` exports it to the host.

Archive uploads exactly the same way as the Postgres mode (the `uploads` volume is shared between the two modes).

### Continuous replication with Litestream (recommended for production)

[Litestream](https://litestream.io) replicates a SQLite database to S3-compatible object storage with second-level RPO. Add a sidecar to the SQLite stack:

```yaml
# Append to compose.sqlite.yml under `services:`
  litestream:
    image: litestream/litestream:latest
    command: replicate
    volumes:
      - data:/data:ro
      - ./litestream.yml:/etc/litestream.yml:ro
    environment:
      LITESTREAM_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?Set S3 access key in .env}
      LITESTREAM_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?Set S3 secret key in .env}
    depends_on:
      - app
    restart: unless-stopped
```

`litestream.yml`:

```yaml
dbs:
  - path: /data/cms.db
    replicas:
      - type: s3
        bucket: my-cms-backups
        path: cms.db
        region: us-east-1
```

With Litestream running, every write to `cms.db` is shipped to S3 within seconds. To restore, point Litestream at the S3 backup before starting the app:

```sh
docker run --rm \
  -v studio-prod_data:/data \
  -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY \
  -v "$PWD/litestream.yml:/etc/litestream.yml:ro" \
  litestream/litestream:latest \
  restore -o /data/cms.db /data/cms.db

docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

## SQLite mode — restore (ad-hoc snapshots)

If you took a `VACUUM INTO` snapshot rather than running Litestream:

```sh
# Stop the app first — restoring overwrites the live DB.
docker compose -f compose.prod.yml -f compose.sqlite.yml stop app

# Copy the backup file into the data volume (replacing the existing DB).
docker compose -f compose.prod.yml -f compose.sqlite.yml run --rm --no-deps \
  --entrypoint "" app sh -lc "rm -f /app/data/cms.db /app/data/cms.db-wal /app/data/cms.db-shm"

docker compose -f compose.prod.yml -f compose.sqlite.yml cp \
  "./backups/studio-YYYY-MM-DD.db" app:/app/data/cms.db

# Start the app — the WAL/SHM sidecar files will be regenerated on next open.
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Restore uploads exactly as in Postgres mode.

## Hosted Provider Backups

When Studio runs on a provider that offers managed Postgres (Railway Postgres, RDS, Supabase, Render Postgres, Fly Postgres, etc.), the provider's snapshot, volume backup, or point-in-time tooling is the recommended first backup path. Keep an independent `pg_dump` schedule when you need provider-independent recovery.

Railway-specific paths:

| Template | Database path | Upload path |
|---|---|---|
| SQLite | `/app/storage/data/cms.db` | `/app/storage/uploads` |
| Postgres | Railway Postgres service | `/app/storage/uploads` |

The workspace is at `/app/storage/studio-workspace` in both templates.

For uploads, back up whatever disk or volume is mounted at `UPLOADS_DIR`. For the workspace, back up the directory `STUDIO_WORKSPACE_DIR` points at. The Railway and Render templates set it to `/app/storage/studio-workspace`, on the same volume. A service created before that variable was added still has the workspace in its container's writable layer: move it first ("Moving the workspace onto a volume").

## Related

- [deployment/README.md](README.md) — deployment overview
- [railway.md](railway.md) — Railway volume paths
- [vps.md](vps.md) — VPS Compose volume names
- `compose.prod.yml` — Postgres, uploads and workspace volume names
- `server/handlers/studioProjects.ts` — `projectsRootDir()`, where the workspace lives and the `STUDIO_WORKSPACE_DIR` override
- `server/handlers/studio/workspacePersistence.ts` — the boot-time `[studio:workspace]` warning
- `compose.sqlite.yml` — SQLite data volume
