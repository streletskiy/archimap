const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRuntimeBaseTag, extractRuntimeBaseStage } = require('../../scripts/lib/runtime-base-tag');

test('runtime-base tag hashes only the runtime-base stage inputs', () => {
  const dockerfile = [
    'ARG NODE_IMAGE=node:24-bookworm-slim@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'ARG RUNTIME_BASE_IMAGE=runtime-base',
    'FROM node:24-bookworm-slim AS deps',
    'RUN echo deps',
    '',
    'FROM ${NODE_IMAGE} AS runtime-base',
    'RUN apt-get update',
    'RUN apt-get install -y aria2 ca-certificates',
    '',
    'FROM ${RUNTIME_BASE_IMAGE} AS runtime',
    'CMD ["node"]'
  ].join('\n');
  const changedNodeImage = dockerfile.replace(
    'ARG NODE_IMAGE=node:24-bookworm-slim@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2222222222222222222222222222222222222222222222222222222222222222'
  );
  const changedDeps = dockerfile.replace('RUN echo deps', 'RUN echo changed deps');
  const changedRuntimeBase = dockerfile.replace(
    'RUN apt-get install -y aria2 ca-certificates',
    'RUN apt-get install -y aria2 ca-certificates curl'
  );

  const baseTag = buildRuntimeBaseTag({ dockerfileText: dockerfile, planetilerVersion: '0.10.2' });
  const nodeImageTag = buildRuntimeBaseTag({
    dockerfileText: changedNodeImage,
    planetilerVersion: '0.10.2'
  });
  const depsTag = buildRuntimeBaseTag({ dockerfileText: changedDeps, planetilerVersion: '0.10.2' });
  const runtimeBaseTag = buildRuntimeBaseTag({
    dockerfileText: changedRuntimeBase,
    planetilerVersion: '0.10.2'
  });

  assert.match(baseTag, /^runtime-base-pl0\.10\.2-rb[a-f0-9]{12}$/);
  assert.notEqual(baseTag, nodeImageTag);
  assert.equal(baseTag, depsTag);
  assert.notEqual(baseTag, runtimeBaseTag);
  assert.match(extractRuntimeBaseStage(dockerfile), /aria2 ca-certificates/);
  assert.doesNotMatch(extractRuntimeBaseStage(dockerfile), /RUN echo deps/);
});

test('runtime-base tag includes transitive tool builder versions and dependencies', () => {
  const dockerfile = [
    'ARG NODE_IMAGE=node:24-alpine',
    'FROM ${NODE_IMAGE} AS tool-deps',
    'RUN apk add cmake libosmium-dev',
    'FROM tool-deps AS osmium-build',
    'ARG OSMIUM_VERSION=1.19.0',
    'ARG OSMIUM_SHA256=abc123',
    'RUN build-osmium',
    'FROM ${NODE_IMAGE} AS unrelated',
    'RUN build-frontend',
    'FROM ${NODE_IMAGE} AS runtime-base',
    'COPY --from=osmium-build /usr/local/bin/osmium /usr/local/bin/osmium',
    'FROM runtime-base AS runtime'
  ].join('\n');
  const hash = (source) => buildRuntimeBaseTag({ dockerfileText: source });
  const original = hash(dockerfile);
  for (const [before, after] of [
    ['1.19.0', '1.20.0'],
    ['abc123', 'def456'],
    ['libosmium-dev', 'libosmium-dev protozero-dev'],
    ['RUN build-osmium', 'RUN build-osmium --changed']
  ]) {
    assert.notEqual(hash(dockerfile.replace(before, after)), original);
  }
  assert.equal(hash(dockerfile.replace('build-frontend', 'build-unrelated')), original);
});
