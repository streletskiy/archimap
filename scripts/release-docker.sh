#!/usr/bin/env bash
set -euo pipefail

VERSION=""
IMAGE="streletskiy/archimap"
PLATFORMS="linux/amd64,linux/arm64"
NO_CACHE=0
CACHE_REF=""
TIPPECANOE_REF="2.79.0"
QUACKOSM_VERSION="0.17.0"
DUCKDB_VERSION="1.4.4"
PIP_VERSION="26.0.1"
RUNTIME_BASE_TAG=""
BUILDER="archimap-multiarch"
SKIP_BINFMT_REPAIR=0
SKIP_RUNTIME_BASE=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-docker.sh --version 1.2.3 [options]

Options:
  --version <value>           Required release tag (example: 1.2.3)
  --image <value>             Image repository (default: streletskiy/archimap)
  --platforms <value>         Target platforms (default: linux/amd64,linux/arm64)
  --no-cache                  Disable build cache
  --cache-ref <value>         Cache image ref (default: <image>:buildcache)
  --tippecanoe-ref <value>    Tippecanoe git ref (default: 2.79.0)
  --quackosm-version <value>  QuackOSM version (default: 0.17.0)
  --duckdb-version <value>    DuckDB version (default: 1.4.4)
  --pip-version <value>       pip version in runtime base (default: 26.0.1)
  --runtime-base-tag <value>  Runtime base tag (default: derived from deps)
  --builder <value>           Buildx builder name (default: archimap-multiarch)
  --skip-binfmt-repair        Skip binfmt auto-install
  --skip-runtime-base         Skip runtime-base build/push (use existing tag)
  -h, --help                  Show help
EOF
}

log() {
  printf '%s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --platforms) PLATFORMS="${2:-}"; shift 2 ;;
    --no-cache) NO_CACHE=1; shift ;;
    --cache-ref) CACHE_REF="${2:-}"; shift 2 ;;
    --tippecanoe-ref) TIPPECANOE_REF="${2:-}"; shift 2 ;;
    --quackosm-version) QUACKOSM_VERSION="${2:-}"; shift 2 ;;
    --duckdb-version) DUCKDB_VERSION="${2:-}"; shift 2 ;;
    --pip-version) PIP_VERSION="${2:-}"; shift 2 ;;
    --runtime-base-tag) RUNTIME_BASE_TAG="${2:-}"; shift 2 ;;
    --builder) BUILDER="${2:-}"; shift 2 ;;
    --skip-binfmt-repair) SKIP_BINFMT_REPAIR=1; shift ;;
    --skip-runtime-base) SKIP_RUNTIME_BASE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${VERSION}" ]]; then
  echo "--version is required. Example: ./scripts/release-docker.sh --version 1.2.3" >&2
  exit 1
fi

if [[ -z "${CACHE_REF}" ]]; then
  CACHE_REF="${IMAGE}:buildcache"
fi

if [[ -z "${RUNTIME_BASE_TAG}" ]]; then
  raw_runtime_base_tag="runtime-base-t${TIPPECANOE_REF}-q${QUACKOSM_VERSION}-d${DUCKDB_VERSION}-p${PIP_VERSION}"
  RUNTIME_BASE_TAG="$(printf '%s' "${raw_runtime_base_tag}" | tr '/:@ ' '-' | tr -c 'A-Za-z0-9._-' '-')"
fi
RUNTIME_BASE_IMAGE="${IMAGE}:${RUNTIME_BASE_TAG}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

export DOCKER_BUILDKIT=1

BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null | tr '[:upper:]' '[:lower:]')"
BUILD_DESCRIBE="$(git describe --tags --always --dirty 2>/dev/null)"
BUILD_LATEST_TAG=""
while IFS= read -r tag; do
  if [[ "${tag}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
    BUILD_LATEST_TAG="${tag}"
    break
  fi
done < <(git tag --list --sort=-v:refname 2>/dev/null)
if [[ -z "${BUILD_SHA}" || -z "${BUILD_DESCRIBE}" ]]; then
  echo "Failed to resolve git metadata (BUILD_SHA/BUILD_DESCRIBE)." >&2
  exit 1
fi

ensure_builder() {
  local target_platforms_csv="$1"
  IFS=',' read -r -a target_platforms <<<"${target_platforms_csv}"
  if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
    docker buildx create --name "${BUILDER}" --driver docker-container --use >/dev/null
  else
    docker buildx use "${BUILDER}"
  fi

  docker buildx inspect --bootstrap >/dev/null

  local inspect_out
  inspect_out="$(docker buildx inspect "${BUILDER}")"
  local platforms_line
  platforms_line="$(printf '%s\n' "${inspect_out}" | awk -F': ' '/Platforms:/ {print $2; exit}')"
  local missing=()
  local p
  for p in "${target_platforms[@]}"; do
    p="$(echo "${p}" | xargs)"
    [[ -z "${p}" ]] && continue
    if [[ ",${platforms_line}," != *",${p},"* ]]; then
      missing+=("${p}")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return 0
  fi

  if [[ "${SKIP_BINFMT_REPAIR}" -eq 1 ]]; then
    echo "Builder '${BUILDER}' misses platforms: ${missing[*]}. Available: ${platforms_line}" >&2
    exit 1
  fi

  log "Missing platforms detected: ${missing[*]}. Installing binfmt..."
  docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null || true
  docker buildx rm "${BUILDER}" >/dev/null 2>&1 || true
  docker buildx create --name "${BUILDER}" --driver docker-container --use >/dev/null
  docker buildx inspect --bootstrap >/dev/null
}

ensure_builder "${PLATFORMS}"

PUBLISH_LATEST=1
if [[ "${VERSION,,}" == "dev" ]]; then
  PUBLISH_LATEST=0
fi

args=(
  buildx build
  --builder "${BUILDER}"
  --platform "${PLATFORMS}"
  --build-arg "TIPPECANOE_REF=${TIPPECANOE_REF}"
  --build-arg "QUACKOSM_VERSION=${QUACKOSM_VERSION}"
  --build-arg "DUCKDB_VERSION=${DUCKDB_VERSION}"
  --build-arg "PIP_VERSION=${PIP_VERSION}"
  --build-arg "RUNTIME_BASE_IMAGE=${RUNTIME_BASE_IMAGE}"
  --build-arg "BUILD_SHA=${BUILD_SHA}"
  --build-arg "BUILD_DESCRIBE=${BUILD_DESCRIBE}"
  --build-arg "BUILD_LATEST_TAG=${BUILD_LATEST_TAG}"
  -t "${IMAGE}:${VERSION}"
)

if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
  args+=( -t "${IMAGE}:latest" )
fi

if [[ "${NO_CACHE}" -eq 1 ]]; then
  args+=( --no-cache )
else
  args+=( --cache-from "type=registry,ref=${CACHE_REF}" )
  args+=( --cache-to "type=registry,ref=${CACHE_REF},mode=max" )
fi

args+=( --push . )

if [[ "${SKIP_RUNTIME_BASE}" -eq 0 ]]; then
  base_args=(
    buildx build
    --builder "${BUILDER}"
    --platform "${PLATFORMS}"
    --target runtime-base
    --build-arg "TIPPECANOE_REF=${TIPPECANOE_REF}"
    --build-arg "QUACKOSM_VERSION=${QUACKOSM_VERSION}"
    --build-arg "DUCKDB_VERSION=${DUCKDB_VERSION}"
    --build-arg "PIP_VERSION=${PIP_VERSION}"
    -t "${RUNTIME_BASE_IMAGE}"
  )
  if [[ "${NO_CACHE}" -eq 1 ]]; then
    base_args+=( --no-cache )
  else
    base_args+=( --cache-from "type=registry,ref=${CACHE_REF}" )
    base_args+=( --cache-to "type=registry,ref=${CACHE_REF},mode=max" )
  fi
  base_args+=( --push . )

  log "Publishing runtime-base image..."
  log "Runtime base tag: ${RUNTIME_BASE_IMAGE}"
  docker "${base_args[@]}"
fi

log "Publishing app image..."
log "Image: ${IMAGE}"
log "Version tag: ${VERSION}"
log "Runtime base image: ${RUNTIME_BASE_IMAGE}"
log "Platforms: ${PLATFORMS}"
log "Tippecanoe ref: ${TIPPECANOE_REF}"
log "QuackOSM version: ${QUACKOSM_VERSION}"
log "DuckDB version: ${DUCKDB_VERSION}"
log "pip version: ${PIP_VERSION}"
log "Build SHA: ${BUILD_SHA}"
log "Build describe: ${BUILD_DESCRIBE}"
if [[ -n "${BUILD_LATEST_TAG}" ]]; then
  log "Build latest tag: ${BUILD_LATEST_TAG}"
fi
if [[ "${NO_CACHE}" -eq 1 ]]; then
  log "Build cache: disabled (--no-cache)"
else
  log "Build cache ref: ${CACHE_REF}"
fi

docker "${args[@]}"

log "Done."
log "Published tags:"
log "  ${IMAGE}:${VERSION}"
if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
  log "  ${IMAGE}:latest"
fi
log "  ${RUNTIME_BASE_IMAGE}"
log "Server deploy (layer-based):"
log "  docker pull ${IMAGE}:${VERSION}"
log "  docker compose up -d"
