# syntax=docker/dockerfile:1

FROM oven/bun:1.3.11 AS build
WORKDIR /app
# vendor/pixel-art-icons is a `file:` dep — `bun install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.11 AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11 AS runtime
WORKDIR /app

ARG STUDIO_VERSION=dev
ARG STUDIO_REVISION=unknown
ARG STUDIO_CREATED=unknown

LABEL org.opencontainers.image.title="Studio"
LABEL org.opencontainers.image.description="Studio — a design tool whose source of truth is a real React repository on disk."
LABEL org.opencontainers.image.source="https://github.com/corebunch/studio"
LABEL org.opencontainers.image.url="https://github.com/corebunch/studio"
LABEL org.opencontainers.image.documentation="https://github.com/corebunch/studio/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${STUDIO_VERSION}"
LABEL org.opencontainers.image.revision="${STUDIO_REVISION}"
LABEL org.opencontainers.image.created="${STUDIO_CREATED}"

ENV NODE_ENV=production
ENV PORT=3001
ENV STATIC_DIR=/app/dist
ENV UPLOADS_DIR=/app/uploads
# The Studio workspace: every user's real React projects, Studio's source of
# truth, with no other copy. It MUST be on a mounted volume (compose.prod.yml
# mounts the `workspace` volume here; the Railway/Render templates point this
# variable into their /app/storage disk). The directory is created below and
# owned by `bun` so an empty named volume mounted here inherits that owner.
ENV STUDIO_WORKSPACE_DIR=/app/studio-workspace
# Studio's private runtime state: encrypted MCP server secrets, the Claude
# CLI's per-user config and login, idempotency records. Persisted the same way
# (compose.prod.yml's `private` volume; /app/storage/.data on the platforms).
ENV STUDIO_DATA_DIR=/app/.data
# Both are gated by src/__tests__/architecture/workspace-volume-persistence.test.ts.

# Studio's own code stays ROOT-owned: the server runs as `bun`, and so does a
# Tier 2 project's dev server (arbitrary code from an imported repo), which
# must not be able to rewrite /app/dist (the admin app the owner loads),
# /app/server or /app/node_modules.
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json bun.lock ./
COPY tsconfig*.json ./
COPY server ./server
COPY src ./src

# Only the directories the server writes are `bun`-owned (not recursive over
# /app): uploads, the SQLite dir, the workspace, private data, and .tmp (the
# dev-server process records). An empty named volume mounted on one of them
# inherits that owner.
RUN mkdir -p /app/uploads /app/data /app/studio-workspace /app/.data /app/.tmp && chown bun:bun /app/uploads /app/data /app/studio-workspace /app/.data /app/.tmp

USER bun
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "run", "server/healthcheck.ts"]

CMD ["bun", "run", "server/index.ts"]
