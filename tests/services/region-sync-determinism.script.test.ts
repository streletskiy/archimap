const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readExportSummary } = require('../../scripts/sync-osm-region');
const { normalizeSourceSnapshotForInsert } = require('../../scripts/region-sync/import-applier');

const PYTHON_IMPORTER_PATH = path.join(__dirname, '..', '..', 'scripts', 'sync-osm-buildings.py');

function readImporterSource() {
  return fs.readFileSync(PYTHON_IMPORTER_PATH, 'utf8');
}

function sliceFunctionBody(source, functionSignature) {
  const startIdx = source.indexOf(functionSignature);
  if (startIdx === -1) {
    throw new Error(`Signature not found: ${functionSignature}`);
  }
  // Every SQL builder ends with a return string and a blank line; take a
  // conservative 3000-char window so we cover the whole body without accidentally
  // matching ORDER BY in the next function.
  return source.slice(startIdx, startIdx + 3000);
}

test('sync-osm-buildings: _build_export_select_sql pins row order', () => {
  const body = sliceFunctionBody(
    readImporterSource(),
    'def _build_export_select_sql('
  );
  assert.ok(body.includes('ORDER BY'), '_build_export_select_sql must emit ORDER BY');
  assert.ok(body.includes("split_part(feature_id, '/', 1)"), 'must order by osm_type');
  assert.ok(body.includes("try_cast(split_part(feature_id, '/', 2) AS BIGINT)"), 'must order by osm_id');
  assert.ok(body.includes('feature_kind'), 'must order by feature_kind');
});

test('sync-osm-buildings: _build_db_export_select_sql pins row order', () => {
  const body = sliceFunctionBody(
    readImporterSource(),
    'def _build_db_export_select_sql('
  );
  assert.ok(body.includes('ORDER BY'), '_build_db_export_select_sql must emit ORDER BY');
  assert.ok(body.includes("split_part(feature_id, '/', 1)"), 'must order by osm_type');
  assert.ok(body.includes("try_cast(split_part(feature_id, '/', 2) AS BIGINT)"), 'must order by osm_id');
});

test('sync-osm-buildings: _build_dual_export_select_sql pins row order', () => {
  const body = sliceFunctionBody(
    readImporterSource(),
    'def _build_dual_export_select_sql('
  );
  assert.ok(body.includes('ORDER BY'), '_build_dual_export_select_sql must emit ORDER BY');
  assert.ok(body.includes("split_part(feature_id, '/', 1)"), 'must order by osm_type');
  assert.ok(body.includes("try_cast(split_part(feature_id, '/', 2) AS BIGINT)"), 'must order by osm_id');
  assert.ok(body.includes('feature_kind'), 'must order by feature_kind');
});

// _materialized_dual_export_select_sql is the SQL that the actual dual-output
// export path executes against the pre-materialized temp tables. It must pin
// row order too, otherwise the DB NDJSON and GeoJSON build NDJSON can differ
// byte-for-byte across reruns even though the CTE-based siblings are stable.
test('sync-osm-buildings: _materialized_dual_export_select_sql pins row order', () => {
  const body = sliceFunctionBody(
    readImporterSource(),
    'def _materialized_dual_export_select_sql('
  );
  assert.ok(body.includes('ORDER BY'), '_materialized_dual_export_select_sql must emit ORDER BY');
  assert.ok(body.includes('osm_type'), 'must order by osm_type');
  assert.ok(body.includes('osm_id'), 'must order by osm_id');
  assert.ok(body.includes('feature_kind'), 'must order by feature_kind');
});

test('sync-osm-buildings: resolve_quackosm_work_dir honors ARCHIMAP_DATA_DIR', () => {
  const source = readImporterSource();
  assert.ok(
    source.includes('def resolve_quackosm_work_dir'),
    'resolve_quackosm_work_dir helper must exist'
  );
  assert.ok(
    source.includes("os.environ.get('ARCHIMAP_DATA_DIR')") ||
      source.includes('ARCHIMAP_DATA_DIR'),
    'resolver must consult ARCHIMAP_DATA_DIR env var'
  );
});

test('normalizeSourceSnapshotForInsert returns null for unusable input', () => {
  assert.equal(normalizeSourceSnapshotForInsert(null), null);
  assert.equal(normalizeSourceSnapshotForInsert(undefined), null);
  assert.equal(normalizeSourceSnapshotForInsert({}), null);
  assert.equal(normalizeSourceSnapshotForInsert({ sha256: '   ' }), null);
  assert.equal(normalizeSourceSnapshotForInsert({ sha256: '' }), null);
});

test('normalizeSourceSnapshotForInsert trims strings and coerces size', () => {
  const out = normalizeSourceSnapshotForInsert({
    sha256: '  abc123  ',
    sizeBytes: 42.9,
    extractSource: '  geofabrik  ',
    extractId: ' ru/central ',
    sourceMtime: ' 2026-04-17T12:00:00Z ',
    localPath: ' /tmp/a.pbf '
  });
  assert.deepEqual(out, {
    extractSource: 'geofabrik',
    extractId: 'ru/central',
    sha256: 'abc123',
    sizeBytes: 42,
    sourceMtime: '2026-04-17T12:00:00Z',
    localPath: '/tmp/a.pbf'
  });
});

test('normalizeSourceSnapshotForInsert clamps negative or non-finite sizeBytes to 0', () => {
  assert.equal(
    normalizeSourceSnapshotForInsert({ sha256: 'abc', sizeBytes: -10 }).sizeBytes,
    0
  );
  assert.equal(
    normalizeSourceSnapshotForInsert({ sha256: 'abc', sizeBytes: 'not-a-number' }).sizeBytes,
    0
  );
});

test('readExportSummary parses sourceSnapshot from JSON payload', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'region-sync-test-'));
  try {
    const summaryPath = path.join(tmpDir, 'summary.json');
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        importedFeatureCount: 1234,
        bounds: { west: 0, south: 0, east: 1, north: 1 },
        sourceSnapshot: {
          extractSource: 'geofabrik',
          extractId: 'ru/central',
          sha256: 'deadbeef',
          sizeBytes: 512,
          sourceMtime: '2026-04-01T00:00:00Z',
          localPath: '/tmp/a.pbf'
        }
      })
    );
    const parsed = readExportSummary(summaryPath);
    assert.ok(parsed, 'summary should parse');
    assert.equal(parsed.importedFeatureCount, 1234);
    assert.deepEqual(parsed.sourceSnapshot, {
      extractSource: 'geofabrik',
      extractId: 'ru/central',
      sha256: 'deadbeef',
      sizeBytes: 512,
      sourceMtime: '2026-04-01T00:00:00Z',
      localPath: '/tmp/a.pbf'
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readExportSummary returns null sourceSnapshot when sha256 missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'region-sync-test-'));
  try {
    const summaryPath = path.join(tmpDir, 'summary.json');
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        importedFeatureCount: 0,
        sourceSnapshot: { extractSource: 'x' }
      })
    );
    const parsed = readExportSummary(summaryPath);
    assert.ok(parsed);
    assert.equal(parsed.sourceSnapshot, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
