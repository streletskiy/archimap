# syntax=docker/dockerfile:1.7

ARG TIPPECANOE_REF=2.79.0
ARG QUACKOSM_VERSION=0.17.0
ARG DUCKDB_VERSION=1.4.4
ARG NODE_IMAGE=node:20-bookworm-slim

FROM debian:bookworm-slim AS tippecanoe-builder
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

COPY package.json ./
COPY scripts ./scripts
COPY src/lib ./src/lib
COPY legal ./legal
COPY frontend ./frontend
RUN BUILD_SHA="${BUILD_SHA}" BUILD_DESCRIBE="${BUILD_DESCRIBE}" BUILD_LATEST_TAG="${BUILD_LATEST_TAG}" node scripts/generate-version.js \
  && npm --prefix frontend run build \
  && node -e "require('fs').writeFileSync('frontend/build/package.json', '{\"type\":\"module\"}\\n')"

FROM ${NODE_IMAGE} AS runtime
ARG QUACKOSM_VERSION
ARG DUCKDB_VERSION

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
  && /opt/pyosm/bin/pip install --upgrade pip \
  && /opt/pyosm/bin/pip install "quackosm==${QUACKOSM_VERSION}" "duckdb==${DUCKDB_VERSION}"

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY server.js ./server.js
COPY server.sveltekit.js ./server.sveltekit.js
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY workers ./workers
COPY --from=frontend-build /app/frontend/build ./frontend/build
COPY --from=frontend-runtime-deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=frontend-build /app/src/lib/version.generated.json ./src/lib/version.generated.json

RUN mkdir -p /app/data/quackosm

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/pyosm/bin/python
EXPOSE 3252

CMD ["node", "server.sveltekit.js"]

