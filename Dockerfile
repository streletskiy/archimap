# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:06e5c9f86bfa0aaa7163cf37a5eaa8805f16b9acb48e3f85645b09d459fc2a9f
ARG RUNTIME_BASE_IMAGE=runtime-base

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
  && node -e "require('fs').writeFileSync('frontend/build/package.json', '{\"type\":\"module\"}\n')"

FROM ${NODE_IMAGE} AS runtime-base

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    libsqlite3-0 \
    zlib1g \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data/cache

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
