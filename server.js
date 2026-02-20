require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 3252);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_ON_START = String(process.env.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
const AUTO_SYNC_INTERVAL_HOURS = Number(process.env.AUTO_SYNC_INTERVAL_HOURS || 168);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'archimap.db');
const db = new Database(dbPath);
const syncScriptPath = path.join(__dirname, 'scripts', 'sync-geofabrik-buildings.js');

let syncInProgress = false;
let currentSyncChild = null;
let httpServer = null;
let shuttingDown = false;
let scheduledSkipLogged = false;
let nextSyncTimer = null;

const MAX_NODE_TIMER_MS = 2_147_483_647;

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS architectural_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  name TEXT,
  style TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS building_contours (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS idx_building_contours_bbox
ON building_contours (min_lon, max_lon, min_lat, max_lat);
`);

const archiColumns = db.prepare(`PRAGMA table_info(architectural_info)`).all();
const archiColumnNames = new Set(archiColumns.map((c) => c.name));
if (!archiColumnNames.has('name')) {
  db.exec(`ALTER TABLE architectural_info ADD COLUMN name TEXT;`);
}
if (!archiColumnNames.has('levels')) {
  db.exec(`ALTER TABLE architectural_info ADD COLUMN levels INTEGER;`);
}

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

function rowToFeature(row) {
  let ring = [];
  let geometry = null;
  let tags = {};
  try {
    const parsed = JSON.parse(row.geometry_json);
    if (parsed && typeof parsed === 'object' && parsed.type && Array.isArray(parsed.coordinates)) {
      geometry = parsed;
    } else if (Array.isArray(parsed)) {
      ring = parsed;
      geometry = { type: 'Polygon', coordinates: [ring] };
    }
  } catch {
    ring = [];
    geometry = { type: 'Polygon', coordinates: [ring] };
  }
  try {
    tags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    tags = {};
  }

  return {
    type: 'Feature',
    id: `${row.osm_type}/${row.osm_id}`,
    properties: { ...tags, source_tags: tags },
    geometry: geometry || { type: 'Polygon', coordinates: [ring] }
  };
}

function attachInfoToFeatures(features) {
  const keys = features
    .map((f) => String(f.id || ''))
    .filter((id) => /^(way|relation)\/\d+$/.test(id));

  if (keys.length === 0) return features;

  const infoByKey = new Map();
  const CHUNK_SIZE = 300;
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    const clauses = chunk.map(() => '(osm_type = ? AND osm_id = ?)').join(' OR ');
    const params = [];
    for (const key of chunk) {
      const [type, id] = key.split('/');
      params.push(type, Number(id));
    }
    const rows = db.prepare(`
      SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, updated_at
      FROM architectural_info
      WHERE ${clauses}
    `).all(...params);
    for (const row of rows) {
      infoByKey.set(`${row.osm_type}/${row.osm_id}`, row);
    }
  }

  for (const feature of features) {
    const key = String(feature.id || '');
    feature.properties = feature.properties || {};
    if (!feature.properties.source_tags || typeof feature.properties.source_tags !== 'object') {
      const clone = { ...feature.properties };
      delete clone.osm_key;
      delete clone.archiInfo;
      delete clone.hasExtraInfo;
      feature.properties.source_tags = clone;
    }
    feature.properties.osm_key = key;
    feature.properties.archiInfo = infoByKey.get(key) || null;
    feature.properties.hasExtraInfo = infoByKey.has(key);
  }

  return features;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

function tileBbox(z, x, y) {
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  if (!Number.isInteger(zi) || !Number.isInteger(xi) || !Number.isInteger(yi)) return null;
  if (zi < 0 || zi > 22) return null;
  const n = 2 ** zi;
  if (xi < 0 || xi >= n || yi < 0 || yi >= n) return null;

  const lon1 = (xi / n) * 360 - 180;
  const lon2 = ((xi + 1) / n) * 360 - 180;
  const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yi) / n))) * 180) / Math.PI;
  const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (yi + 1)) / n))) * 180) / Math.PI;

  return {
    minLon: Math.min(lon1, lon2),
    minLat: Math.min(lat1, lat2),
    maxLon: Math.max(lon1, lon2),
    maxLat: Math.max(lat1, lat2)
  };
}

function getBuildingsFeatureCollectionByBbox(minLon, minLat, maxLon, maxLat, limit = 12000) {
  const rows = db.prepare(`
    SELECT osm_type, osm_id, tags_json, geometry_json
    FROM building_contours
    WHERE max_lon >= ? AND min_lon <= ?
      AND max_lat >= ? AND min_lat <= ?
    LIMIT ?
  `).all(minLon, maxLon, minLat, maxLat, limit);

  const features = rows.map(rowToFeature);
  attachInfoToFeatures(features);

  return {
    type: 'FeatureCollection',
    features
  };
}

app.get('/api/me', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.user), user: req.session?.user || null });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.user = { username };
    return res.json({ ok: true, user: req.session.user });
  }
  return res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/building-info/:osmType/:osmId', (req, res) => {
  const osmType = req.params.osmType;
  const osmId = Number(req.params.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const row = db.prepare(`
    SELECT osm_type, osm_id, name, style, levels, year_built, architect, address, description, updated_at
    FROM architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get(osmType, osmId);

  if (!row) {
    return res.status(404).json({ error: 'Информация не найдена' });
  }

  return res.json(row);
});

app.post('/api/building-info', requireAuth, (req, res) => {
  const body = req.body || {};
  const osmType = body.osmType;
  const osmId = Number(body.osmId);

  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const cleanText = (value, maxLen = 500) => {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLen);
  };

  const yearRaw = body.yearBuilt;
  let yearBuilt = null;
  if (yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 2100) {
      return res.status(400).json({ error: 'Год постройки должен быть целым числом от 1000 до 2100' });
    }
    yearBuilt = parsed;
  }

  const levelsRaw = body.levels;
  let levels = null;
  if (levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') {
    const parsed = Number(levelsRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) {
      return res.status(400).json({ error: 'Этажность должна быть целым числом от 0 до 300' });
    }
    levels = parsed;
  }

  const upsert = db.prepare(`
    INSERT INTO architectural_info (osm_type, osm_id, name, style, levels, year_built, architect, address, description, updated_at)
    VALUES (@osm_type, @osm_id, @name, @style, @levels, @year_built, @architect, @address, @description, datetime('now'))
    ON CONFLICT(osm_type, osm_id) DO UPDATE SET
      name = excluded.name,
      style = excluded.style,
      levels = excluded.levels,
      year_built = excluded.year_built,
      architect = excluded.architect,
      address = excluded.address,
      description = excluded.description,
      updated_at = datetime('now');
  `);

  upsert.run({
    osm_type: osmType,
    osm_id: osmId,
    name: cleanText(body.name, 250),
    style: cleanText(body.style, 200),
    levels,
    year_built: yearBuilt,
    architect: cleanText(body.architect, 200),
    address: cleanText(body.address, 300),
    description: cleanText(body.description, 1000)
  });

  return res.json({ ok: true });
});

app.get('/api/buildings-tile/:z/:x/:y', (req, res) => {
  const bbox = tileBbox(req.params.z, req.params.x, req.params.y);
  if (!bbox) {
    return res.status(400).json({ error: 'Некорректный tile z/x/y' });
  }

  const out = getBuildingsFeatureCollectionByBbox(
    bbox.minLon,
    bbox.minLat,
    bbox.maxLon,
    bbox.maxLat,
    12000
  );

  res.setHeader('Cache-Control', 'public, max-age=120');
  return res.json(out);
});

app.get('/api/building/:osmType/:osmId', (req, res) => {
  const osmType = req.params.osmType;
  const osmId = Number(req.params.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор здания' });
  }

  const row = db.prepare(`
    SELECT osm_type, osm_id, tags_json, geometry_json
    FROM building_contours
    WHERE osm_type = ? AND osm_id = ?
  `).get(osmType, osmId);

  if (!row) {
    return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
  }

  const feature = rowToFeature(row);
  attachInfoToFeatures([feature]);
  return res.json(feature);
});

app.get('/api/contours-status', (req, res) => {
  const summary = db.prepare(`
    SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated
    FROM building_contours
  `).get();

  res.json({
    total: Number(summary.total || 0),
    lastUpdated: summary.last_updated || null
  });
});

function runCitySync(reason = 'interval') {
  if (syncInProgress) {
    if (reason !== 'scheduled' || !scheduledSkipLogged) {
      console.log(`[auto-sync] skipped (${reason}): previous sync still running`);
      if (reason === 'scheduled') scheduledSkipLogged = true;
    }
    return;
  }

  scheduledSkipLogged = false;
  syncInProgress = true;
  console.log(`[auto-sync] started (${reason})`);

  const child = spawn(process.execPath, [syncScriptPath], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
  });
  currentSyncChild = child;

  child.on('error', (error) => {
    syncInProgress = false;
    scheduledSkipLogged = false;
    currentSyncChild = null;
    console.error(`[auto-sync] failed to start: ${String(error.message || error)}`);
  });

  child.on('close', (code, signal) => {
    syncInProgress = false;
    scheduledSkipLogged = false;
    currentSyncChild = null;
    if (shuttingDown && (signal === 'SIGTERM' || signal === 'SIGINT')) {
      console.log('[auto-sync] stopped due to shutdown');
      return;
    }
    if (code === 0) {
      console.log('[auto-sync] finished successfully');
    } else {
      console.error(`[auto-sync] failed with code ${code}`);
    }
  });
}

function initAutoSync() {
  if (!AUTO_SYNC_ENABLED) {
    console.log('[auto-sync] disabled by AUTO_SYNC_ENABLED=false');
    return;
  }

  if (AUTO_SYNC_ON_START) {
    runCitySync('startup');
  }

  if (Number.isFinite(AUTO_SYNC_INTERVAL_HOURS) && AUTO_SYNC_INTERVAL_HOURS > 0) {
    const intervalMs = Math.max(60_000, Math.round(AUTO_SYNC_INTERVAL_HOURS * 60 * 60 * 1000));
    const scheduleNext = (targetTs) => {
      const now = Date.now();
      const remaining = Math.max(0, targetTs - now);
      const delay = Math.min(remaining, MAX_NODE_TIMER_MS);

      nextSyncTimer = setTimeout(() => {
        if (Date.now() >= targetTs) {
          runCitySync('scheduled');
          scheduleNext(Date.now() + intervalMs);
          return;
        }
        scheduleNext(targetTs);
      }, delay);

      if (typeof nextSyncTimer.unref === 'function') {
        nextSyncTimer.unref();
      }
    };

    scheduleNext(Date.now() + intervalMs);
    console.log(`[auto-sync] scheduled every ${AUTO_SYNC_INTERVAL_HOURS}h`);
  } else {
    console.log('[auto-sync] periodic updates disabled (AUTO_SYNC_INTERVAL_HOURS <= 0)');
  }
}

async function initSessionStore() {
  const sessionConfig = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  };

  try {
    const redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (error) => {
      console.error(`[session] Redis error: ${String(error.message || error)}`);
    });
    await redisClient.connect();

    app.use(session({
      ...sessionConfig,
      store: new RedisStore({
        client: redisClient,
        prefix: 'archimap:sess:'
      })
    }));
    console.log(`[session] Redis store connected: ${REDIS_URL}`);
  } catch (error) {
    console.error(`[session] Redis unavailable, fallback to MemoryStore: ${String(error.message || error)}`);
    app.use(session(sessionConfig));
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down...`);

  if (currentSyncChild && !currentSyncChild.killed) {
    try {
      currentSyncChild.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  if (nextSyncTimer) {
    clearTimeout(nextSyncTimer);
    nextSyncTimer = null;
  }

  if (httpServer) {
    httpServer.close(() => {
      console.log('[server] shutdown complete');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  setTimeout(() => {
    console.error('[server] forced shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

initSessionStore()
  .then(() => {
    httpServer = app.listen(PORT, HOST, () => {
      console.log('[server] ArchiMap started successfully');
      console.log(`[server] Local:   http://localhost:${PORT}`);
      console.log(`[server] Network: http://${HOST}:${PORT}`);
      initAutoSync();
    });
  })
  .catch((error) => {
    console.error(`[server] Failed to initialize session store: ${String(error.message || error)}`);
    process.exit(1);
  });
