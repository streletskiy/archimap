const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { buildPmtilesSwap } = require('./common');

// Include the source of the export contract so a code upgrade cannot reuse an
// archive generated with older filter properties, height rules or geometry SQL.
const EXPORT_SOURCE_FILES = [
  'scripts/region-sync/common.ts',
  'scripts/region-sync/region-db.ts',
  'scripts/region-sync/pmtiles-builder.ts',
  'scripts/region-sync/planetiler.ts',
  'src/lib/server/services/building-filter-query.service.ts',
  'src/lib/server/utils/filter-sql-builder.ts'
];

function buildRegionTileSignature(region, rootDir = path.resolve(__dirname, '..', '..')) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({
    contract: 1,
    sourceLayer: String(region?.sourceLayer || 'buildings'),
    minZoom: Number(region?.pmtilesMinZoom || 13),
    maxZoom: Number(region?.pmtilesMaxZoom || 16),
    schemaName: String(region?.slug || region?.name || 'region').trim() || 'region'
  }));
  for (const source of EXPORT_SOURCE_FILES) {
    hash.update(source);
    hash.update(fs.readFileSync(path.join(rootDir, source)));
  }
  return hash.digest('hex');
}

async function withClient(databaseUrl, callback) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function readRegionTileState(databaseUrl, regionId) {
  return withClient(databaseUrl, async (client) => {
    await client.query(`
      INSERT INTO public.data_region_tile_state (region_id) VALUES ($1)
      ON CONFLICT (region_id) DO NOTHING
    `, [regionId]);
    const result = await client.query('SELECT * FROM public.data_region_tile_state WHERE region_id = $1', [regionId]);
    return result.rows[0];
  });
}

function canReuseRegionArchive({ state, signature, archivePath }) {
  if (!state || String(state.data_revision) !== String(state.published_revision)) return false;
  if (state.published_signature !== signature) return false;
  try {
    const stat = fs.statSync(archivePath);
    return stat.isFile() && stat.size > 0 &&
      stat.size === Number(state.published_archive_bytes) &&
      stat.mtimeMs === Number(state.published_archive_mtime_ms);
  } catch {
    return false;
  }
}

async function publishRegionTiles({ databaseUrl, regionId, revision, signature, archivePath, builtArchivePath, afterCommit = null }: LooseRecord) {
  if (path.resolve(archivePath) === path.resolve(builtArchivePath)) {
    throw new Error('PMTiles publication requires a separate built archive');
  }
  const stat = fs.statSync(builtArchivePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Cannot publish an empty PMTiles archive');
  return withClient(databaseUrl, async (client) => {
    let swap = null;
    let commitAttempted = false;
    const publicationLock = `archimap:region-pmtiles:${regionId}`;
    // A session lock extends past COMMIT until the shared backup is cleaned up.
    // The row lock alone would let the next publisher create a new .bak while
    // this publisher is still removing its own backup.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [publicationLock]);
    try {
      await client.query('BEGIN');
      // Only publication holds this lock. Imports can run during the expensive
      // export/build, but a stale builder cannot replace a newer archive.
      const state = await client.query(`
        SELECT data_revision FROM public.data_region_tile_state WHERE region_id = $1 FOR UPDATE
      `, [regionId]);
      if (!state.rows[0] || String(state.rows[0].data_revision) !== String(revision)) {
        throw new Error('Region data changed during PMTiles build; refusing to publish a stale archive');
      }
      swap = buildPmtilesSwap(archivePath, builtArchivePath);
      const published = fs.statSync(archivePath);
      await client.query(`
        UPDATE public.data_region_tile_state
        SET published_revision = $2, published_signature = $3,
          published_archive_bytes = $4, published_archive_mtime_ms = $5
        WHERE region_id = $1
      `, [regionId, revision, signature, published.size, published.mtimeMs]);
      commitAttempted = true;
      await client.query('COMMIT');
      // Lifecycle observer for deterministic publication concurrency tests.
      if (typeof afterCommit === 'function') await afterCommit();
      swap.commit();
      return archivePath;
    } catch (error) {
      // Restore while still holding the row lock, before another publisher can
      // touch the archive. An ambiguous COMMIT must leave the file untouched:
      // either its state committed too, or its metadata mismatch keeps it dirty.
      try {
        if (swap && !commitAttempted) swap.rollback();
      } finally {
        await client.query('ROLLBACK').catch(() => {});
      }
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [publicationLock]).catch(() => {});
    }
  });
}

module.exports = { buildRegionTileSignature, canReuseRegionArchive, publishRegionTiles, readRegionTileState };
