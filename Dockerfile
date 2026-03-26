# syntax=docker/dockerfile:1.7

ARG TIPPECANOE_REF=2.79.0
ARG QUACKOSM_VERSION=0.17.0
ARG DUCKDB_VERSION=1.4.4
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:06e5c9f86bfa0aaa7163cf37a5eaa8805f16b9acb48e3f85645b09d459fc2a9f
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:74d56e3931e0d5a1dd51f8c8a2466d21de84a271cd3b5a733b803aa91abf4421
ARG PIP_VERSION=26.0.1
ARG RUNTIME_BASE_IMAGE=runtime-base

FROM ${DEBIAN_IMAGE} AS tippecanoe-builder
ARG TIPPECANOE_REF

WORKDIR /tmp/tippecanoe

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    build-essential \
    git \
    pkg-config \
    zlib1g-dev \
    libsqlite3-dev

RUN git clone --depth 1 --branch "${TIPPECANOE_REF}" https://github.com/felt/tippecanoe.git . \
  && make -j"$(nproc)" \
  && strip tippecanoe tile-join

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
ARG QUACKOSM_VERSION
ARG DUCKDB_VERSION
ARG PIP_VERSION

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    libsqlite3-0 \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tippecanoe-builder /tmp/tippecanoe/tippecanoe /usr/local/bin/tippecanoe
COPY --from=tippecanoe-builder /tmp/tippecanoe/tile-join /usr/local/bin/tile-join

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
  python3 -m venv /opt/pyosm \
  && /opt/pyosm/bin/pip install "pip==${PIP_VERSION}" \
  && /opt/pyosm/bin/pip install "quackosm==${QUACKOSM_VERSION}" "duckdb==${DUCKDB_VERSION}"

RUN mkdir -p /app/data/cache /app/data/quackosm

ENV PYTHON_BIN=/opt/pyosm/bin/python
ENV XDG_CACHE_HOME=/app/data/cache

FROM ${RUNTIME_BASE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/pyosm/bin/python

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
COPY --from=frontend-build /app/src/lib/version.generated.json ./src/lib/version.generated.json

EXPOSE 3252

CMD ["node", "--import", "tsx", "scripts/runtime-start.ts"]

