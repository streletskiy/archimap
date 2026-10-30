# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ARG RUNTIME_BASE_IMAGE=runtime-base

FROM ${NODE_IMAGE} AS deps

RUN apk add --no-cache python3 make g++
WORKDIR /app
RUN npm install --global npm@12.2.1 \
  && npm install --prefix /tmp/npm-security --ignore-scripts --no-audit --no-fund undici@6.29.1 ip-address@10.7.4 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && mv /tmp/npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /tmp/npm-security/node_modules/ip-address /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && rm -rf /tmp/npm-security

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-deps

WORKDIR /app/frontend
RUN npm install --global npm@12.2.1 \
  && npm install --prefix /tmp/npm-security --ignore-scripts --no-audit --no-fund undici@6.29.1 ip-address@10.7.4 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && mv /tmp/npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /tmp/npm-security/node_modules/ip-address /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && rm -rf /tmp/npm-security

COPY frontend/package*.json ./
COPY frontend/vendor ./vendor
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
RUN npm install --global npm@12.2.1 \
  && npm install --prefix /tmp/npm-security --ignore-scripts --no-audit --no-fund undici@6.29.1 ip-address@10.7.4 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && mv /tmp/npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /tmp/npm-security/node_modules/ip-address /usr/local/lib/node_modules/npm/node_modules/ip-address \
  && rm -rf /tmp/npm-security

RUN apk add --no-cache aria2 ca-certificates docker-cli sqlite-libs zlib

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
