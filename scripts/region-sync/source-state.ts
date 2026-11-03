const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  lockPostgresContourSummary,
  normalizeSourceSnapshotForInsert,
  recordPostgresRegionSourceSnapshot
} = require('./import-applier');

const IMPORT_CONTRACT_VERSION = 1;
const IMPORT_SOURCE_FILES = [
  'scripts/region-sync/osm2pgsql-flex.lua',
  'scripts/region-sync/osm2pgsql-import.ts',
  'scripts/region-sync/osmium-tool.ts',
  'scripts/region-sync/import-applier.ts'
];

function buildImportSignature(rootDir = path.resolve(__dirname, '..', '..')) {
  const hash = crypto.createHash('sha256');
  hash.update(`archimap-region-import:${IMPORT_CONTRACT_VERSION}\n`);
  for (const file of IMPORT_SOURCE_FILES) {
    hash.update(file);
    hash.update('\0');
    // Checkout line endings must not change the import contract.
    hash.update(fs.readFileSync(path.join(rootDir, file), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizeRegionId(regionId) {
  const id = Number(regionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Source state requires a positive region ID');
  return id;
}

function dateOrNull(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapRegionSourceState(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    regionId: Number(row.region_id),
    extractSource: row.extract_source || null,
    extractId: row.extract_id || null,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    sourceMtime: dateOrNull(row.replication_timestamp) || dateOrNull(row.source_mtime),
    localPath: row.local_path || null,
    importedFeatureCount: row.imported_feature_count == null ? null : Number(row.imported_feature_count),
    downloadUrl: row.download_url || null,
    sourceEtag: row.source_etag || null,
    sourceLastModified: row.source_last_modified || null,
    replicationBaseUrl: row.replication_base_url || null,
    replicationSequence: row.replication_sequence == null ? null : Number(row.replication_sequence),
    replicationTimestamp: dateOrNull(row.replication_timestamp),
    lastFullDownloadAt: dateOrNull(row.last_full_download_at),
    importSignature: row.import_signature || null,
    buildingInputSha256: row.building_input_sha256 || null,
    createdAt: dateOrNull(row.created_at),
    persistentSource: Boolean(row.local_path && row.download_url && row.import_signature)
  };
}

async function tryRecordUnchangedRegionSource({
  databaseUrl,
  region,
  previousSnapshotId,
  sourceSnapshot,
  importSignature,
  sourceInputUnchanged = false,
  ClientRef = Client
}: LooseRecord) {
  const regionId = normalizeRegionId(region?.id);
  const normalized = normalizeSourceSnapshotForInsert({ ...sourceSnapshot, importSignature });
  if (
    sourceSnapshot?.persistentSource !== true ||
    !importSignature ||
    (sourceInputUnchanged !== true && !normalized?.buildingInputSha256)
  )
    return null;
  const client = new ClientRef({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query('BEGIN');
    try {
      await lockPostgresContourSummary(client);
      const stateResult = await client.query(
        `SELECT * FROM public.data_region_source_snapshots
        WHERE region_id = $1 AND is_active = 1 FOR UPDATE`,
        [regionId]
      );
      const active = mapRegionSourceState(stateResult.rows[0]);
      if (
        !active ||
        String(active.id) !== String(previousSnapshotId) ||
        active.importSignature !== importSignature ||
        // Only the validated source-preparation caller can provide this proof:
        // identical source bytes or a verified incremental batch of empty diffs.
        (sourceInputUnchanged !== true && active.buildingInputSha256 !== normalized.buildingInputSha256) ||
        !active.createdAt ||
        !(active.importedFeatureCount > 0)
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const coverage = (
        await client.query(
          `SELECT count(*)::bigint AS memberships,
        count(bc.osm_id)::bigint AS contours,
        COALESCE(bool_or(bc.updated_at > $2::timestamptz), false) AS changed_since_import
        FROM public.data_region_memberships drm
        LEFT JOIN osm.building_contours bc USING (osm_type, osm_id)
        WHERE drm.region_id = $1`,
          [regionId, active.createdAt]
        )
      ).rows[0];
      if (
        Number(coverage.memberships) !== active.importedFeatureCount ||
        Number(coverage.contours) !== active.importedFeatureCount ||
        coverage.changed_since_import
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const metadataUnchanged = Object.entries(normalized).every(([key, value]) => active[key] === value);
      const sourceSnapshotId = metadataUnchanged
        ? active.id
        : await recordPostgresRegionSourceSnapshot(client, {
            region,
            sourceSnapshot: { ...sourceSnapshot, importSignature },
            importedFeatureCount: active.importedFeatureCount,
            pmtilesBytes: null
          });
      await client.query('COMMIT');
      return {
        importedFeatureCount: active.importedFeatureCount,
        activeFeatureCount: active.importedFeatureCount,
        changedFeatureCount: 0,
        insertedFeatureCount: 0,
        orphanDeletedCount: 0,
        renderCacheRows: 0,
        sourceSnapshotId,
        pmtilesBytes: null,
        pmtilesPath: null
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function readActiveRegionSourceState(
  databaseUrl,
  regionId,
  { ClientRef = Client, synchronizeImport = false }: LooseRecord = {}
) {
  const id = normalizeRegionId(regionId);
  const client = new ClientRef({ connectionString: databaseUrl });
  try {
    await client.connect();
    if (synchronizeImport) {
      await client.query('BEGIN');
      // Cleanup must resolve an ambiguous import COMMIT before deciding which
      // immutable source file is safe to remove. Callers retain the region lock.
      await lockPostgresContourSummary(client);
    }
    const result = await client.query(
      `SELECT * FROM public.data_region_source_snapshots
      WHERE region_id = $1 AND is_active = 1`,
      [id]
    );
    if (synchronizeImport) await client.query('COMMIT');
    return mapRegionSourceState(result.rows[0]);
  } catch (error) {
    if (synchronizeImport) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function acquireRegionSourceLock(databaseUrl, regionId, { ClientRef = Client, signal = null }: LooseRecord = {}) {
  const id = normalizeRegionId(regionId);
  const cancelled = () => Object.assign(new Error('Region source lock acquisition cancelled'), { name: 'AbortError' });
  if (signal?.aborted) throw cancelled();
  const client = new ClientRef({ connectionString: databaseUrl });
  const lockName = `archimap:region-source:${id}`;
  let closePromise = null;
  const close = () => (closePromise ||= Promise.resolve().then(() => client.end()));
  let rejectCancellation;
  const cancellation = new Promise<void>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => {
    rejectCancellation(cancelled());
    // pg closes the dedicated connection, cancelling a blocked advisory query;
    // the waiter must never acquire the lock later after its caller has stopped.
    void close().catch(() => {});
  };
  const acquire = async () => {
    await client.connect();
    if (signal?.aborted) throw cancelled();
    await client.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [lockName]);
    if (signal?.aborted) throw cancelled();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([acquire(), cancellation]);
  } catch (error) {
    await close().catch(() => {});
    throw signal?.aborted ? cancelled() : error;
  } finally {
    // Once acquired, keep the lock through the caller's cleanup even if the run
    // is cancelled. Its finally block releases it after outstanding work stops.
    signal?.removeEventListener('abort', onAbort);
  }
  let released = false;
  return async function releaseRegionSourceLock() {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [lockName]);
    } finally {
      await close();
    }
  };
}

module.exports = {
  acquireRegionSourceLock,
  buildImportSignature,
  readActiveRegionSourceState,
  tryRecordUnchangedRegionSource,
  _test_: { IMPORT_SOURCE_FILES, mapRegionSourceState }
};
