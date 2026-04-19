require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');
const { loadRegion } = require('./region-sync/db-ingester');

const DEFAULT_PASSES = 1;
const DEFAULT_STAGE_LOG_TAIL = 200;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const BENCHMARK_DIR = path.join(process.cwd(), '.benchmarks');
const DEFAULT_REGION_CATALOG_PATH = path.join(process.cwd(), 'frontend', 'static', 'admin-regions.geojson');
const FALLBACK_REGION_CATALOG_PATH = path.join(process.cwd(), 'frontend', 'build', 'client', 'admin-regions.geojson');
type BenchmarkStageEvent = {
  stage: string;
  progress: number | null;
  detail: string | null;
  atMs: number;
};

type BenchmarkError = Error & {
  details?: LooseRecord;
  cause?: unknown;
};

function createRuntimeOptions() {
  return {
    dbProvider: getDbProvider(process.env),
    databaseUrl: getPostgresConnectionString(process.env),
    archimapDbPath:
      String(
        process.env.DATABASE_PATH ||
          process.env.ARCHIMAP_DB_PATH ||
          process.env.SQLITE_URL ||
          path.join(process.cwd(), 'data', 'archimap.db')
      ).trim() || path.join(process.cwd(), 'data', 'archimap.db'),
    osmDbPath:
      String(process.env.OSM_DB_PATH || path.join(process.cwd(), 'data', 'osm.db')).trim() ||
      path.join(process.cwd(), 'data', 'osm.db'),
    localEditsDbPath:
      String(process.env.LOCAL_EDITS_DB_PATH || path.join(process.cwd(), 'data', 'local-edits.db')).trim() ||
      path.join(process.cwd(), 'data', 'local-edits.db'),
    dataDir:
      String(process.env.ARCHIMAP_DATA_DIR || path.join(process.cwd(), 'data')).trim() ||
      path.join(process.cwd(), 'data')
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    regionId: null,
    label: null,
    output: null,
    passes: DEFAULT_PASSES,
    includePmtilesOnly: false,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;

    if (arg === '--no-pmtiles-only') {
      out.includePmtilesOnly = false;
      continue;
    }
    if (arg === '--pmtiles-only') {
      out.includePmtilesOnly = true;
      continue;
    }
    if (arg === '--region-id' && argv[index + 1]) {
      out.regionId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--region-id=')) {
      out.regionId = Number(arg.slice('--region-id='.length));
      continue;
    }
    if (arg === '--label' && argv[index + 1]) {
      out.label = String(argv[index + 1] || '').trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--label=')) {
      out.label = String(arg.slice('--label='.length)).trim() || null;
      continue;
    }
    if (arg === '--output' && argv[index + 1]) {
      out.output = String(argv[index + 1] || '').trim() || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      out.output = String(arg.slice('--output='.length)).trim() || null;
      continue;
    }
    if (arg === '--passes' && argv[index + 1]) {
      out.passes = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--passes=')) {
      out.passes = Number(arg.slice('--passes='.length));
      continue;
    }
    if (arg === '--sample-interval-ms' && argv[index + 1]) {
      out.sampleIntervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--sample-interval-ms=')) {
      out.sampleIntervalMs = Number(arg.slice('--sample-interval-ms='.length));
      continue;
    }
  }

  out.passes = Number.isInteger(out.passes) && out.passes > 0 ? out.passes : DEFAULT_PASSES;
  out.sampleIntervalMs =
    Number.isFinite(out.sampleIntervalMs) && out.sampleIntervalMs >= 50
      ? Math.round(out.sampleIntervalMs)
      : DEFAULT_SAMPLE_INTERVAL_MS;

  return out;
}

function slugify(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'region'
  );
}

function collectGeometryBounds(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && Number.isFinite(Number(node[0])) && Number.isFinite(Number(node[1]))) {
      const lon = Number(node[0]);
      const lat = Number(node[1]);
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
      return;
    }
    for (const child of node) {
      visit(child);
    }
  };

  visit(geometry?.coordinates);

  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }

  return {
    west,
    south,
    east,
    north
  };
}

function loadBenchmarkRegionFeature(regionCatalogPath, regionId) {
  const configuredPath = String(regionCatalogPath || DEFAULT_REGION_CATALOG_PATH).trim();
  const absolutePath = path.resolve(configuredPath);
  const fallbackPath = path.resolve(FALLBACK_REGION_CATALOG_PATH);
  const effectivePath = fs.existsSync(absolutePath) ? absolutePath : fallbackPath;
  if (!fs.existsSync(effectivePath)) {
    throw new Error(`Benchmark region catalog not found: ${absolutePath}`);
  }

  const catalog = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));
  const feature = Array.isArray(catalog?.features)
    ? catalog.features.find((item) => Number(item?.properties?.Id) === Number(regionId))
    : null;

  if (!feature) {
    throw new Error(`Benchmark region ${regionId} was not found in ${effectivePath}`);
  }

  return feature;
}

async function ensureBenchmarkRegion(runtimeOptions, regionId) {
  const catalogPath =
    String(process.env.BENCHMARK_REGION_CATALOG_PATH || DEFAULT_REGION_CATALOG_PATH).trim() ||
    DEFAULT_REGION_CATALOG_PATH;
  const feature = loadBenchmarkRegionFeature(catalogPath, regionId);
  const properties = feature?.properties || {};
  const bounds = collectGeometryBounds(feature?.geometry);
  const slug = String(properties.Slug || `region-${regionId}`).trim() || `region-${regionId}`;
  const name = String(properties.Name || slug).trim() || slug;
  const extractSource = String(properties.ExtractSource || '').trim();
  const extractId = String(properties.ExtractId || '').trim();
  const extractLabel = name;
  const sourceValue = name;

  if (!extractSource || !extractId) {
    throw new Error(`Benchmark region ${regionId} is missing canonical extract metadata`);
  }

  const client = new Client({ connectionString: runtimeOptions.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
      INSERT INTO public.data_sync_regions (
        id,
        slug,
        name,
        source_type,
        source_value,
        extract_source,
        extract_id,
        extract_label,
        extract_resolution_status,
        extract_resolution_error,
        enabled,
        auto_sync_enabled,
        auto_sync_on_start,
        auto_sync_interval_hours,
        pmtiles_min_zoom,
        pmtiles_max_zoom,
        source_layer,
        last_sync_status,
        next_sync_at,
        bounds_west,
        bounds_south,
        bounds_east,
        bounds_north,
        updated_by,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'extract',
        $4,
        $5,
        $6,
        $7,
        'resolved',
        NULL,
        1,
        1,
        0,
        168,
        13,
        16,
        'buildings',
        'idle',
        NULL,
        $8,
        $9,
        $10,
        $11,
        'benchmark',
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        name = EXCLUDED.name,
        source_type = EXCLUDED.source_type,
        source_value = EXCLUDED.source_value,
        extract_source = EXCLUDED.extract_source,
        extract_id = EXCLUDED.extract_id,
        extract_label = EXCLUDED.extract_label,
        extract_resolution_status = EXCLUDED.extract_resolution_status,
        extract_resolution_error = NULL,
        enabled = EXCLUDED.enabled,
        auto_sync_enabled = EXCLUDED.auto_sync_enabled,
        auto_sync_on_start = EXCLUDED.auto_sync_on_start,
        auto_sync_interval_hours = EXCLUDED.auto_sync_interval_hours,
        pmtiles_min_zoom = EXCLUDED.pmtiles_min_zoom,
        pmtiles_max_zoom = EXCLUDED.pmtiles_max_zoom,
        source_layer = EXCLUDED.source_layer,
        last_sync_status = EXCLUDED.last_sync_status,
        next_sync_at = EXCLUDED.next_sync_at,
        bounds_west = EXCLUDED.bounds_west,
        bounds_south = EXCLUDED.bounds_south,
        bounds_east = EXCLUDED.bounds_east,
        bounds_north = EXCLUDED.bounds_north,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `,
      [
        Number(regionId),
        slug,
        name,
        sourceValue,
        extractSource,
        extractId,
        extractLabel,
        bounds?.west ?? null,
        bounds?.south ?? null,
        bounds?.east ?? null,
        bounds?.north ?? null
      ]
    );
  } finally {
    await client.end();
  }
}

function toMs(startHrTime) {
  return Number(process.hrtime.bigint() - startHrTime) / 1e6;
}

function pushTail(buffer, line, limit = DEFAULT_STAGE_LOG_TAIL) {
  buffer.push(line);
  if (buffer.length > limit) {
    buffer.splice(0, buffer.length - limit);
  }
}

function createLineBufferConsumer(onLine) {
  let buffered = '';
  return (chunk) => {
    buffered += String(chunk || '');
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, '');
      buffered = buffered.slice(newlineIndex + 1);
      onLine(line);
      newlineIndex = buffered.indexOf('\n');
    }
  };
}

function readProcessInfo(pid) {
  const statusPath = `/proc/${pid}/status`;
  if (!fs.existsSync(statusPath)) return null;
  try {
    const text = fs.readFileSync(statusPath, 'utf8');
    const ppidMatch = text.match(/^PPid:\s+(\d+)/m);
    const rssMatch = text.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return {
      pid,
      ppid: ppidMatch ? Number(ppidMatch[1]) : 0,
      rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : 0
    };
  } catch {
    return null;
  }
}

function collectProcessTreeRssBytes(rootPid) {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    return null;
  }

  const childrenByParent = new Map();
  const rssByPid = new Map();

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readProcessInfo(Number(entry));
    if (!info) continue;
    rssByPid.set(info.pid, info.rssBytes);
    if (!childrenByParent.has(info.ppid)) {
      childrenByParent.set(info.ppid, []);
    }
    childrenByParent.get(info.ppid).push(info.pid);
  }

  const stack = [Number(rootPid)];
  const seen = new Set();
  let total = 0;

  while (stack.length > 0) {
    const pid = stack.pop();
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    total += Number(rssByPid.get(pid) || 0);
    const children = childrenByParent.get(pid);
    if (Array.isArray(children) && children.length > 0) {
      stack.push(...children);
    }
  }

  return total;
}

function normalizeStageName(stage) {
  const normalized = String(stage || '')
    .trim()
    .toLowerCase();
  if (normalized === 'publish') {
    return 'build';
  }
  return normalized;
}

function summarizeStageTimeline(events, endAtMs) {
  const spans = [];
  let current = null;

  for (const event of events) {
    if (!event.stage) continue;
    if (!current || current.stage !== event.stage) {
      if (current) {
        current.endAtMs = event.atMs;
        current.durationMs = Number((current.endAtMs - current.startAtMs).toFixed(2));
      }
      current = {
        stage: event.stage,
        startAtMs: event.atMs,
        endAtMs: null,
        durationMs: 0,
        eventCount: 0,
        firstProgress: event.progress ?? null,
        lastProgress: event.progress ?? null,
        firstDetail: event.detail || null,
        lastDetail: event.detail || null
      };
      spans.push(current);
    } else {
      current.lastProgress = event.progress ?? null;
      current.lastDetail = event.detail || null;
    }
    current.eventCount += 1;
  }

  if (current) {
    current.endAtMs = endAtMs;
    current.durationMs = Number((current.endAtMs - current.startAtMs).toFixed(2));
  }

  return spans.map((span) => ({
    stage: span.stage,
    startAtMs: Number(span.startAtMs.toFixed(2)),
    endAtMs: Number(span.endAtMs.toFixed(2)),
    durationMs: span.durationMs,
    eventCount: span.eventCount,
    firstProgress: span.firstProgress,
    lastProgress: span.lastProgress,
    firstDetail: span.firstDetail,
    lastDetail: span.lastDetail
  }));
}

function summarizePhases(stageTimeline) {
  const phaseOrder = ['download', 'extract', 'export', 'build', 'apply', 'followup'];
  const phaseMap = new Map();

  for (const span of stageTimeline) {
    const phase = normalizeStageName(span.stage);
    if (!phaseOrder.includes(phase)) continue;
    const existing = phaseMap.get(phase);
    if (!existing) {
      phaseMap.set(phase, {
        phase,
        startAtMs: span.startAtMs,
        endAtMs: span.endAtMs,
        durationMs: span.durationMs,
        stageCount: 1
      });
    } else {
      existing.endAtMs = span.endAtMs;
      existing.durationMs = Number((existing.endAtMs - existing.startAtMs).toFixed(2));
      existing.stageCount += 1;
    }
  }

  return phaseOrder
    .filter((phase) => phaseMap.has(phase))
    .map((phase) => {
      const item = phaseMap.get(phase);
      return {
        phase: item.phase,
        startAtMs: Number(item.startAtMs.toFixed(2)),
        endAtMs: Number(item.endAtMs.toFixed(2)),
        durationMs: item.durationMs,
        stageCount: item.stageCount
      };
    });
}

function inferShardStats(resultJson: LooseRecord = {}) {
  const engineFromResult = String(resultJson.pmtilesBuildEngine || '').trim() || null;
  const reusedFromResult = Number(resultJson.pmtilesShardReusedCount);
  const rebuiltFromResult = Number(resultJson.pmtilesShardRebuiltCount);
  const shardCountFromResult = Number(resultJson.pmtilesShardCount);
  const modeFromResult = String(resultJson.pmtilesBuildMode || '').trim() || null;

  return {
    pmtilesBuildEngine: engineFromResult,
    pmtilesBuildMode: modeFromResult,
    pmtilesShardCount: Number.isFinite(shardCountFromResult) && shardCountFromResult > 0 ? shardCountFromResult : null,
    pmtilesShardReusedCount: Number.isFinite(reusedFromResult) ? reusedFromResult : null,
    pmtilesShardRebuiltCount: Number.isFinite(rebuiltFromResult) ? rebuiltFromResult : null
  };
}

async function runSyncPass({ cwd, regionId, pmtilesOnly = false, dataDir, sampleIntervalMs, env }) {
  const args = ['--import', 'tsx', path.join('scripts', 'sync-osm-region.ts'), '--region-id', String(regionId)];
  if (pmtilesOnly) {
    args.push('--pmtiles-only');
  }

  const childEnv = {
    ...process.env,
    ...env,
    REGION_SYNC_EMIT_STAGE_JSON: 'true',
    REGION_SYNC_WORKDIR_CLEANUP: String(
      env?.REGION_SYNC_WORKDIR_CLEANUP || process.env.REGION_SYNC_WORKDIR_CLEANUP || 'warm'
    ),
    ARCHIMAP_DATA_DIR: dataDir
  };

  const startedAtHr = process.hrtime.bigint();
  const startedAtIso = new Date().toISOString();
  const events: BenchmarkStageEvent[] = [];
  const logTail: string[] = [];
  const resultLineTail: string[] = [];
  let resultJson: LooseRecord | null = null;

  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  const onStdoutLine = (line) => {
    if (!line) return;
    pushTail(logTail, `stdout: ${line}`);
    if (line.startsWith('SYNC_STAGE_JSON=')) {
      try {
        const payload = JSON.parse(line.slice('SYNC_STAGE_JSON='.length));
        const stage = String(payload?.stage || '').trim();
        if (stage) {
          events.push({
            stage,
            progress: Number.isFinite(Number(payload?.progress)) ? Number(payload.progress) : null,
            detail: String(payload?.detail || '').trim() || null,
            atMs: toMs(startedAtHr)
          });
        }
      } catch (error) {
        pushTail(logTail, `stdout-parse-error: ${String(error?.message || error)}`);
      }
      return;
    }
    if (line.startsWith('SYNC_RESULT_JSON=')) {
      try {
        resultJson = JSON.parse(line.slice('SYNC_RESULT_JSON='.length));
      } catch (error) {
        pushTail(resultLineTail, `result-parse-error: ${String(error?.message || error)}`);
      }
      return;
    }
  };

  const onStderrLine = (line) => {
    if (!line) return;
    pushTail(logTail, `stderr: ${line}`);
  };

  const consumeStdout = createLineBufferConsumer(onStdoutLine);
  const consumeStderr = createLineBufferConsumer(onStderrLine);

  child.stdout.on('data', (chunk) => consumeStdout(chunk));
  child.stderr.on('data', (chunk) => consumeStderr(chunk));

  let peakRssBytes = 0;
  const sampleTimer = setInterval(() => {
    const rssBytes = collectProcessTreeRssBytes(child.pid);
    if (Number.isFinite(rssBytes) && rssBytes > peakRssBytes) {
      peakRssBytes = rssBytes;
    }
  }, sampleIntervalMs);
  sampleTimer.unref?.();

  const exitInfo: {
    error: unknown;
    code: number | null;
    signal: NodeJS.Signals | null;
  } = await new Promise((resolve) => {
    child.once('error', (error) => {
      clearInterval(sampleTimer);
      resolve({
        error,
        code: null,
        signal: null
      });
    });
    child.once('exit', (code, signal) => {
      clearInterval(sampleTimer);
      resolve({
        error: null,
        code,
        signal
      });
    });
  });

  const finalRssBytes = collectProcessTreeRssBytes(child.pid);
  if (Number.isFinite(finalRssBytes) && finalRssBytes > peakRssBytes) {
    peakRssBytes = finalRssBytes;
  }

  const endedAtHr = process.hrtime.bigint();
  const endedAtIso = new Date().toISOString();
  const wallClockMs = Number(endedAtHr - startedAtHr) / 1e6;
  const stageTimeline = summarizeStageTimeline(events, Number(wallClockMs.toFixed(2)));
  const phaseDurations = summarizePhases(stageTimeline);
  const shardStats = inferShardStats(resultJson || {});

  if (exitInfo.error) {
    const error: BenchmarkError = new Error(
      `Benchmark child failed to start: ${String((exitInfo.error as Error)?.message || exitInfo.error)}`
    ) as BenchmarkError;
    error.cause = exitInfo.error;
    error.details = {
      startedAtIso,
      endedAtIso,
      logTail,
      resultLineTail
    };
    throw error;
  }

  if ((exitInfo.code ?? 0) !== 0) {
    const error: BenchmarkError = new Error(
      `Sync command failed with exit code ${exitInfo.code ?? 1}${exitInfo.signal ? ` (signal ${exitInfo.signal})` : ''}`
    ) as BenchmarkError;
    error.details = {
      startedAtIso,
      endedAtIso,
      logTail,
      resultLineTail,
      resultJson
    };
    throw error;
  }

  if (!resultJson) {
    const error: BenchmarkError = new Error('Sync command completed without SYNC_RESULT_JSON') as BenchmarkError;
    error.details = {
      startedAtIso,
      endedAtIso,
      logTail,
      resultLineTail,
      stageTimeline
    };
    throw error;
  }

  return {
    name: pmtilesOnly
      ? `pmtiles-only-${shardStats.pmtilesBuildEngine || resultJson?.pmtilesBuildEngine || 'unknown'}-${
          shardStats.pmtilesBuildMode || resultJson?.pmtilesBuildMode || 'unknown'
        }`
      : `full-sync-pass-${shardStats.pmtilesBuildEngine || resultJson?.pmtilesBuildEngine || 'unknown'}-${
          shardStats.pmtilesBuildMode || resultJson?.pmtilesBuildMode || 'unknown'
        }`,
    mode: pmtilesOnly ? 'pmtiles-only' : 'full-sync',
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    wallClockMs: Number(wallClockMs.toFixed(2)),
    peakRssBytes: peakRssBytes > 0 ? peakRssBytes : null,
    exitCode: exitInfo.code ?? 0,
    exitSignal: exitInfo.signal || null,
    result: resultJson,
    phaseDurations,
    stageTimeline,
    shardStats,
    logTail
  };
}

async function main() {
  const args = parseArgs();
  if (!Number.isInteger(args.regionId) || args.regionId <= 0) {
    throw new Error('Pass --region-id <id>');
  }

  const runtimeOptions = createRuntimeOptions();
  if (
    String(runtimeOptions.dbProvider || '')
      .trim()
      .toLowerCase() !== 'postgres'
  ) {
    throw new Error('benchmark-region-sync requires DB_PROVIDER=postgres');
  }

  await ensureBenchmarkRegion(runtimeOptions, args.regionId);
  const region = await loadRegion(runtimeOptions, args.regionId);
  const regionSlug = slugify(region?.slug || region?.name || `region-${region.id}`);
  const label = slugify(args.label || regionSlug);
  const outputPath = path.resolve(
    process.cwd(),
    args.output ||
      path.join(BENCHMARK_DIR, `region-sync-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const benchmarkDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `archimap-region-sync-${region.id}-`));
  const childEnv = {
    ...process.env,
    REGION_SYNC_WORKDIR_CLEANUP: String(process.env.REGION_SYNC_WORKDIR_CLEANUP || 'warm'),
    REGION_SYNC_WORKDIR_CLEANUP_TTL_DAYS: String(process.env.REGION_SYNC_WORKDIR_CLEANUP_TTL_DAYS || '14'),
    REGION_SYNC_RENDER_CACHE_REFRESH: String(process.env.REGION_SYNC_RENDER_CACHE_REFRESH || 'false')
  };

  const runs = [];
  try {
    for (let passIndex = 0; passIndex < args.passes; passIndex += 1) {
      runs.push(
        await runSyncPass({
          cwd: process.cwd(),
          regionId: region.id,
          pmtilesOnly: false,
          dataDir: benchmarkDataDir,
          sampleIntervalMs: args.sampleIntervalMs,
          env: childEnv
        })
      );
    }

    if (args.includePmtilesOnly) {
      runs.push(
        await runSyncPass({
          cwd: process.cwd(),
          regionId: region.id,
          pmtilesOnly: true,
          dataDir: benchmarkDataDir,
          sampleIntervalMs: args.sampleIntervalMs,
          env: childEnv
        })
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      region: {
        id: region.id,
        slug: region.slug || null,
        name: region.name || null,
        extractSource: region.extractSource || null,
        extractId: region.extractId || null,
        regionKind: region.regionKind || null
      },
      config: {
        passes: args.passes,
        includePmtilesOnly: args.includePmtilesOnly,
        sampleIntervalMs: args.sampleIntervalMs,
        dataDir: benchmarkDataDir,
        dbProvider: runtimeOptions.dbProvider,
        env: {
          PLANETILER_BIN: process.env.PLANETILER_BIN || null,
          PMTILES_PROGRESS_JSON: process.env.PMTILES_PROGRESS_JSON || 'true',
          PMTILES_PROGRESS_INTERVAL_SEC: process.env.PMTILES_PROGRESS_INTERVAL_SEC || '5',
          REGION_SYNC_WORKDIR_CLEANUP: process.env.REGION_SYNC_WORKDIR_CLEANUP || 'warm',
          REGION_SYNC_WORKDIR_CLEANUP_TTL_DAYS: process.env.REGION_SYNC_WORKDIR_CLEANUP_TTL_DAYS || '14',
          REGION_SYNC_WORKDIR_CLEANUP_MAX_BYTES: process.env.REGION_SYNC_WORKDIR_CLEANUP_MAX_BYTES || null,
          REGION_SYNC_EXPORT_BATCH_SIZE: process.env.REGION_SYNC_EXPORT_BATCH_SIZE || null,
          REGION_SYNC_IMPORT_APPLY_BATCH_SIZE: process.env.REGION_SYNC_IMPORT_APPLY_BATCH_SIZE || null,
          REGION_SYNC_RENDER_CACHE_REFRESH: process.env.REGION_SYNC_RENDER_CACHE_REFRESH || 'false'
        }
      },
      runs
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(
      JSON.stringify({
        outputPath,
        regionId: region.id,
        label,
        runs: runs.length
      })
    );
  } finally {
    fs.rmSync(benchmarkDataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    const details = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : '';
    console.error(`${String(error?.message || error)}${details}`);
    process.exit(1);
  });
}
