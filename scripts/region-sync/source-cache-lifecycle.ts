const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { acquireRegionSourceLock, readActiveRegionSourceState } = require('./source-state');
const { pruneRegionSourceCache } = require('./source-cache');

// Scan managed IDs rather than only the deleted parent: the hierarchy's FK
// cascade has already removed child regions when the route callback runs.
async function cleanupDeletedRegionSourceCaches({ databaseUrl, dataDir, ClientRef = Client,
  acquireLock = acquireRegionSourceLock, readSourceState = readActiveRegionSourceState }: LooseRecord) {
  const root = path.resolve(dataDir, 'source-cache');
  const summary = { scanned: 0, removedFiles: 0, removedRegions: 0, failures: [] };
  if (!fs.existsSync(root)) return summary;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Source cache root must not be a symlink');
  const relative = path.relative(fs.realpathSync(dataDir), fs.realpathSync(root));
  if (relative !== 'source-cache') throw new Error('Source cache root escapes the data directory');
  const regionIds = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^r[1-9]\d*$/.test(entry.name))
    .map(entry => Number(entry.name.slice(1))).filter(id => Number.isSafeInteger(id));
  summary.scanned = regionIds.length;
  if (!regionIds.length) return summary;
  const client = new ClientRef({ connectionString: databaseUrl });
  try {
    await client.connect();
    // Do not wait for locks of unrelated live regions that may be importing.
    const existing = await client.query('SELECT id FROM public.data_sync_regions WHERE id = ANY($1::bigint[])', [regionIds]);
    const liveIds = new Set(existing.rows.map(row => Number(row.id)));
    for (const regionId of regionIds.filter(id => !liveIds.has(id))) {
      let release = null;
      try {
        release = await acquireLock(databaseUrl, regionId);
        // Resolves an ambiguous canonical COMMIT before filesystem cleanup.
        const active = await readSourceState(databaseUrl, regionId, { synchronizeImport: true });
        const exists = await client.query('SELECT EXISTS (SELECT 1 FROM public.data_sync_regions WHERE id = $1) AS present', [regionId]);
        if (active || exists.rows[0]?.present !== false) continue;
        summary.removedFiles += pruneRegionSourceCache({ dataDir, regionId, activePath: null, noActiveSnapshot: true });
        const directory = path.join(root, `r${regionId}`);
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
        summary.removedRegions++;
      } catch (error) {
        summary.failures.push({ regionId, error: String(error?.message || error) });
      } finally {
        if (release) await release();
      }
    }
    return summary;
  } finally { await client.end(); }
}

module.exports = { cleanupDeletedRegionSourceCaches };
