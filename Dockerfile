# syntax=docker/dockerfile:1.7

ARG TIPPECANOE_REF=2.79.0
ARG QUACKOSM_VERSION=0.17.0
ARG DUCKDB_VERSION=1.4.4

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

FROM node:20-bookworm-slim
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
    git \
    ca-certificates \
    libsqlite3-0 \
    zlib1g

COPY --from=tippecanoe-builder /tmp/tippecanoe/tippecanoe /usr/local/bin/tippecanoe
COPY --from=tippecanoe-builder /tmp/tippecanoe/tile-join /usr/local/bin/tile-join

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
  python3 -m venv /opt/pyosm \
  && /opt/pyosm/bin/pip install --upgrade pip \
  && /opt/pyosm/bin/pip install "quackosm==${QUACKOSM_VERSION}" "duckdb==${DUCKDB_VERSION}"

COPY . .
RUN mkdir -p /app/data/quackosm
RUN set -eux; \
  SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"; \
  VER="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"; \
  if [ -z "$SHA" ]; then SHA="unknown"; fi; \
  if [ -z "$VER" ]; then VER="dev"; fi; \
  printf '{"shortSha":"%s","version":"%s"}\n' "$SHA" "$VER" > /app/build-info.json; \
  rm -rf /app/.git

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/pyosm/bin/python
EXPOSE 3252

CMD ["node", "server.js"]

