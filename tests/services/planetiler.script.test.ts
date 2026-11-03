const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPlanetilerBuild, toContainerPath } = require('../../scripts/region-sync/planetiler');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-planetiler-unit-'));
  const inputPath = path.join(dir, 'input.ndjson');
  const outputPath = path.join(dir, 'region.pmtiles');
  fs.writeFileSync(inputPath, '{}\n');
  fs.writeFileSync(outputPath, 'previous archive');
  return { dir, inputPath, outputPath, minZoom: 13, maxZoom: 16, layer: 'buildings', includeFeatureId: true };
}

test('native builds use unique temporary storage and publish only after a successful build', () => {
  const f = fixture();
  const tempPaths = [];
  try {
    const spawnSyncRef = (_exe, args, options) => {
      assert.equal(options.shell, false);
      const output = args.find((arg) => arg.startsWith('--output=')).slice(9);
      const temp = args.find((arg) => arg.startsWith('--tmpdir=')).slice(9);
      tempPaths.push(path.dirname(temp));
      assert.equal(path.dirname(path.dirname(temp)), os.tmpdir());
      assert.equal(fs.readFileSync(f.outputPath, 'utf8'), tempPaths.length === 1 ? 'previous archive' : 'new archive');
      assert.ok(args.includes('--minzoom=13'));
      assert.ok(args.includes('--maxzoom=16'));
      assert.ok(!args.some((arg) => /simplif|buffer|compression/.test(arg)));
      fs.writeFileSync(output, 'new archive');
      return { status: 0 };
    };
    for (let i = 0; i < 2; i++) runPlanetilerBuild({ ...f, planetilerExe: 'fake', env: {}, spawnSyncRef });
    assert.notEqual(tempPaths[0], tempPaths[1]);
    assert.ok(tempPaths.every((dir) => !fs.existsSync(dir)));
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'new archive');
    const schema = fs.readFileSync(path.join(f.dir, 'region.planetiler.yml'), 'utf8');
    assert.match(schema, /int\(feature\.tags\.osm_id\) \* 2/);
    assert.doesNotMatch(schema, /\$\{feature\.id\}/);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('native failure cleans partial output and preserves the previous archive', () => {
  const f = fixture();
  let workspace;
  try {
    assert.throws(
      () =>
        runPlanetilerBuild({
          ...f,
          planetilerExe: 'fake',
          env: {},
          spawnSyncRef(_exe, args) {
            const output = args.find((arg) => arg.startsWith('--output=')).slice(9);
            workspace = path.dirname(output);
            fs.writeFileSync(output, 'partial');
            return { status: 2 };
          }
        }),
      /failed with exit code 2/
    );
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'previous archive');
    assert.equal(fs.existsSync(workspace), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const failCopy of [false, true]) {
  test(`container staging copies input once and ${failCopy ? 'preserves output after copy failure' : 'cleans only its owned workspace'}`, () => {
    const f = fixture();
    const calls = [];
    const env = { PLANETILER_BIN: 'missing', PLANETILER_CONTAINER: 'test-engine', PLANETILER_HOST_DATA_ROOT: f.dir };
    let localWorkspace;
    let copyFd;
    try {
      const spawnSyncRef = (exe, args, options) => {
        calls.push({ exe, args });
        if (exe === 'missing') return { status: 1 };
        assert.equal(exe, 'docker');
        assert.deepEqual(args.slice(0, 2), ['exec', 'test-engine']);
        if (args[2] === 'mkdir') localWorkspace = args[4];
        if (args[2] === 'cat') {
          assert.equal(args[4], `${localWorkspace}/output.pmtiles`);
          assert.equal(options.stdio[0], 'ignore');
          assert.equal(options.stdio[2], 'inherit');
          copyFd = options.stdio[1];
          assert.ok(Number.isInteger(copyFd));
          assert.equal(fs.fstatSync(copyFd).size, 0);
          if (process.platform !== 'win32') {
            assert.equal(fs.fstatSync(copyFd).mode & 0o777, 0o666 & ~process.umask(), 'published tiles remain readable by the web container');
          }
          fs.writeSync(copyFd, failCopy ? 'partial copy' : 'complete archive');
          return { status: failCopy ? 1 : 0 };
        }
        return { status: 0 };
      };
      const build = () => runPlanetilerBuild({ ...f, env, spawnSyncRef });
      if (failCopy) assert.throws(build, /output staging failed/);
      else build();
      assert.match(localWorkspace, /^\/tmp\/archimap-planetiler-[0-9a-f-]{36}$/);
      assert.equal(calls.filter(({ args }) => args[2] === 'cp' && args[4] === '/data/input.ndjson').length, 1);
      assert.equal(calls.filter(({ args }) => args[2] === 'cat').length, 1);
      assert.throws(() => fs.fstatSync(copyFd), { code: 'EBADF' });
      assert.deepEqual(calls.at(-1).args, ['exec', 'test-engine', 'rm', '-rf', '--', localWorkspace]);
      assert.equal(fs.readFileSync(f.outputPath, 'utf8'), failCopy ? 'previous archive' : 'complete archive');
      assert.equal(
        fs.readdirSync(f.dir).some((name) => name.endsWith('.tmp')),
        false
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test('native output copy preserves binary data larger than the bounded copy buffer', () => {
  const f = fixture();
  const payload = Buffer.alloc(2 * 1024 * 1024 + 31);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  try {
    runPlanetilerBuild({
      ...f,
      planetilerExe: 'fake',
      env: {},
      spawnSyncRef(_exe, args) {
        const output = args.find(arg => arg.startsWith('--output=')).slice(9);
        fs.writeFileSync(output, payload);
        return { status: 0 };
      }
    });
    assert.deepEqual(fs.readFileSync(f.outputPath), payload);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('local I/O optout keeps an isolated shared workspace and validates optional bounds', () => {
  const f = fixture();
  let workspace;
  try {
    const env = { REGION_SYNC_PLANETILER_LOCAL_IO: 'false' };
    runPlanetilerBuild({
      ...f,
      planetilerExe: 'fake',
      env,
      buildBounds: [43, 55, 45, 57],
      spawnSyncRef(_exe, args) {
        const output = args.find((arg) => arg.startsWith('--output=')).slice(9);
        workspace = path.dirname(output);
        assert.equal(path.dirname(workspace), f.dir);
        assert.ok(args.includes('--bounds=43,55,45,57'));
        fs.writeFileSync(output, 'complete archive');
        return { status: 0 };
      }
    });
    assert.equal(fs.existsSync(workspace), false);
    assert.throws(
      () => runPlanetilerBuild({ ...f, planetilerExe: 'fake', env, buildBounds: [45, 55, 43, 57] }),
      /bounds/
    );
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'complete archive');
    assert.equal(
      toContainerPath('E:/test/input.ndjson', { PLANETILER_HOST_DATA_ROOT: 'E:/test' }),
      '/data/input.ndjson'
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('container-local temporary workspace is not remapped when the shared host root is /tmp', () => {
  const f = fixture();
  let createdWorkspace;
  try {
    assert.throws(
      () =>
        runPlanetilerBuild({
          ...f,
          env: { PLANETILER_BIN: 'missing', PLANETILER_CONTAINER: 'test-engine', PLANETILER_HOST_DATA_ROOT: '/tmp' },
          spawnSyncRef(exe, args) {
            if (exe === 'missing') return { status: 1 };
            if (args[2] === 'mkdir') createdWorkspace = args[4];
            if (args[2] === 'cp') return { status: 2 };
            return { status: 0 };
          }
        }),
      /input staging failed/
    );
    assert.match(createdWorkspace, /^\/tmp\/archimap-planetiler-[0-9a-f-]{36}$/);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'previous archive');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
