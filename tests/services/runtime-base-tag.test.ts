const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRuntimeBaseTag,
  extractRuntimeBaseStage
} = require('../../scripts/lib/runtime-base-tag');

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
