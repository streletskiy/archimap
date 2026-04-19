# syntax=docker/dockerfile:1.7

ARG PLANETILER_VERSION=0.10.2
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:06e5c9f86bfa0aaa7163cf37a5eaa8805f16b9acb48e3f85645b09d459fc2a9f
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:74d56e3931e0d5a1dd51f8c8a2466d21de84a271cd3b5a733b803aa91abf4421
ARG RUNTIME_BASE_IMAGE=runtime-base

FROM ghcr.io/onthegomap/planetiler:${PLANETILER_VERSION} AS planetiler-dist

FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-deps

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci

FROM --platform=$BUILDPLATFORM frontend-deps AS frontend-runtime-deps

WORKDIR /app/frontend
RUN npm prune --omit=dev

FROM --platform=$BUILDPLATFORM frontend-deps AS frontend-build

WORKDIR /app
ARG BUILD_SHA
ARG BUILD_DESCRIBE
ARG BUILD_LATEST_TAG

# Install the backend production tree in the build-platform stage so tsx/esbuild
# always matches the architecture that runs the version-generation step.
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev --ignore-scripts

COPY scripts ./scripts
COPY src/lib ./src/lib
COPY legal ./legal
COPY frontend ./frontend
RUN BUILD_SHA="${BUILD_SHA}" BUILD_DESCRIBE="${BUILD_DESCRIBE}" BUILD_LATEST_TAG="${BUILD_LATEST_TAG}" node --import tsx scripts/generate-version.ts \
  && npm --prefix frontend run build \
  && node -e "require('fs').writeFileSync('frontend/build/package.json', '{\"type\":\"module\"}\\n')"

FROM ${NODE_IMAGE} AS runtime-base
ARG PLANETILER_VERSION

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libsqlite3-0 \
    osm2pgsql \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=planetiler-dist /opt/java/openjdk /opt/java/openjdk
COPY --from=planetiler-dist /app /opt/planetiler

RUN mkdir -p /app/data/cache

RUN <<'EOF'
set -eu
cat > /usr/local/bin/planetiler <<'INNER'
#!/bin/sh
set -eu
exec "${JAVA_HOME:-/opt/java/openjdk}/bin/java" \
  -cp "/opt/planetiler/resources:/opt/planetiler/classes:/opt/planetiler/libs/*" \
  com.onthegomap.planetiler.Main \
  "$@"
INNER
chmod +x /usr/local/bin/planetiler
EOF

ENV XDG_CACHE_HOME=/app/data/cache
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:${PATH}
ENV PLANETILER_BIN=/usr/local/bin/planetiler
ENV PLANETILER_HOME=/opt/planetiler
ENV PLANETILER_VERSION=${PLANETILER_VERSION}

FROM ${RUNTIME_BASE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=frontend-runtime-deps /app/frontend/node_modules ./frontend/node_modules
COPY server.ts ./server.ts
COPY server.sveltekit.ts ./server.sveltekit.ts
COPY db ./db
COPY scripts ./scripts
COPY workers ./workers
COPY src ./src
COPY --from=frontend-build /app/frontend/build ./frontend/build
COPY frontend/static ./frontend/static
COPY --from=frontend-build /app/src/lib/version.generated.json ./src/lib/version.generated.json

EXPOSE 3252

CMD ["node", "--import", "tsx", "scripts/runtime-start.ts"]

