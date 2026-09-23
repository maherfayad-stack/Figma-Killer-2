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
# Gated by src/__tests__/architecture/workspace-volume-persistence.test.ts.
ENV STUDIO_WORKSPACE_DIR=/app/studio-workspace

COPY --from=production-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun tsconfig*.json ./
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun src ./src

RUN mkdir -p /app/uploads /app/data /app/studio-workspace && chown -R bun:bun /app

USER bun
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "run", "server/healthcheck.ts"]

CMD ["bun", "run", "server/index.ts"]
