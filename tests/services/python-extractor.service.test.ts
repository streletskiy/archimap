const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  createPythonExtractResolver,
  ensurePythonImporterDeps
} = require('../../scripts/region-sync/python-extractor');

const resolver = createPythonExtractResolver({
  importerPath: path.resolve(__dirname, '..', '..', 'scripts', 'sync-osm-buildings.py')
});

let pythonDepsSkipReason = null;
let pythonCandidate = null;
try {
  pythonCandidate = ensurePythonImporterDeps();
} catch (error) {
  pythonDepsSkipReason = String(error?.message || error || 'Python extractor dependencies are unavailable');
}

const pythonExtractorTestOptions = pythonDepsSkipReason
  ? { skip: `python extractor deps unavailable: ${pythonDepsSkipReason}` }
  : {};

test('searchExtractCandidates returns canonical candidates for free-form query', pythonExtractorTestOptions, async () => {
  const result = await resolver.searchExtractCandidates('Antarctica', {
    source: 'any',
    limit: 10
  });

  assert.equal(result.query, 'Antarctica');
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.some((item) => item.extractId === 'geofabrik_antarctica'));
});

test('resolveExactExtract validates canonical extract id with source', pythonExtractorTestOptions, async () => {
  const result = await resolver.resolveExactExtract('geofabrik_antarctica', {
    source: 'geofabrik'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'geofabrik');
  assert.equal(result.candidate.extractId, 'geofabrik_antarctica');
});

test('resolveExactExtract accepts path-style osmfr region ids from admin map data', pythonExtractorTestOptions, async () => {
  const result = await resolver.resolveExactExtract('russia/central_federal_district/kostroma_oblast', {
    source: 'osmfr'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'osmfr');
  assert.equal(result.candidate.extractId, 'osmfr_russia_central_federal_district_kostroma_oblast');
});

test('resolveExactExtract accepts path-style geofabrik us state ids from admin map data', pythonExtractorTestOptions, async () => {
  const result = await resolver.resolveExactExtract('us/california', {
    source: 'geofabrik'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'geofabrik');
  assert.equal(result.candidate.extractId, 'geofabrik_north-america_us_us_california');
});

test('resolveExactExtract reports ambiguous exact-name matches instead of auto-selecting one', pythonExtractorTestOptions, async () => {
  const result = await resolver.resolveExactExtract('ceuta', {
    source: 'any'
  });

  assert.equal(result.candidate, null);
  assert.equal(result.errorCode, 'multiple');
  assert.match(String(result.message || ''), /Multiple extracts matched/i);
});

test('download_extract_with_progress emits managed stage markers for local HTTP downloads', pythonExtractorTestOptions, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-python-download-progress-'));
  const sourceBuffer = Buffer.alloc(3 * 1024 * 1024, 'a');
  const outputPath = path.join(workspace, 'downloaded.osm.pbf');
  const importerPath = path.resolve(__dirname, '..', '..', 'scripts', 'sync-osm-buildings.py');

  const server = http.createServer((request, response) => {
    if (request.url !== '/extract.osm.pbf') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(sourceBuffer.length)
    });
    response.end(sourceBuffer);
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) reject(error);
      else resolve(undefined);
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/extract.osm.pbf`;
  const pythonScript = [
    'import importlib.util',
    'import pathlib',
    'spec = importlib.util.spec_from_file_location("sync_osm_buildings", r"' + importerPath.replace(/\\/g, '\\\\') + '")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.download_extract_with_progress(',
    '    r"' + url + '",',
    '    pathlib.Path(r"' + outputPath.replace(/\\/g, '\\\\') + '"),',
    '    extract_query="geofabrik_test_region",',
    '    index=1,',
    '    total=1,',
    ')'
  ].join('\n');

  try {
    const result: { code: number | null; stdout: string; stderr: string } = await new Promise((resolve, reject) => {
      const child = spawn(pythonCandidate.exe, [
        ...pythonCandidate.prefixArgs,
        '-c',
        pythonScript
      ], {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          REGION_SYNC_EMIT_STAGE_JSON: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    assert.equal(result.code, 0, result.stderr || result.stdout || 'python helper failed');
    assert.equal(fs.existsSync(outputPath), true);
    assert.equal(fs.statSync(outputPath).size, sourceBuffer.length);

    const stagePayloads = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter((line) => line.startsWith('SYNC_STAGE_JSON='))
      .map((line) => JSON.parse(line.slice('SYNC_STAGE_JSON='.length)));

    assert.ok(stagePayloads.length >= 2, `expected multiple stage markers, got ${result.stdout}`);
    assert.ok(stagePayloads.some((payload) => String(payload?.stage || '') === 'download'));
    assert.ok(stagePayloads.some((payload) => Number(payload?.progress) > 0));
    assert.ok(stagePayloads.some((payload) => String(payload?.detail || '').includes('download complete')));
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
