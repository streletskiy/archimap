const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(REPO_ROOT, 'frontend', 'build', 'client', 'admin-regions.geojson');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'frontend', 'build', 'client', 'admin-regions.pmtiles');
const DEFAULT_METADATA_OUTPUT = `${DEFAULT_OUTPUT}.meta.json`;
const DEFAULT_MODE = String(process.env.ADMIN_REGIONS_PMTILES_ON_START || 'auto').trim().toLowerCase() || 'auto';
const DEFAULT_TIPPECANOE_BIN = String(process.env.TIPPECANOE_BIN || 'tippecanoe').trim() || 'tippecanoe';
const VALID_MODES = new Set(['auto', 'always', 'never']);

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase() || DEFAULT_MODE;
  if (!VALID_MODES.has(normalized)) {
    throw new Error(`Invalid ADMIN_REGIONS_PMTILES_ON_START mode: ${normalized}`);
  }
  return normalized;
}

function toRepoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function hashFile(filePath) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
}

function readMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    return {
      invalid: true,
      error: String(error?.message || error)
    };
  }
}

function buildRebuildReason({ mode, outputExists, metadata, inputSha256 }) {
  if (mode === 'always') return 'forced';
  if (!outputExists) return 'missing_output';
  if (!metadata) return 'missing_metadata';
  if (metadata.invalid) return 'invalid_metadata';
  if (String(metadata.inputSha256 || '').trim().toLowerCase() !== inputSha256.toLowerCase()) {
    return 'geojson_changed';
  }
  return '';
}

function runPmtilesBuild({ inputPath, outputPath, metadataPath, tippecanoeBin }) {
  const args = [
    'scripts/build-admin-regions-pmtiles.js',
    '--tippecanoe-bin',
    tippecanoeBin,
    '--input',
    inputPath,
    '--output',
    outputPath,
    '--metadata-output',
    metadataPath
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`build-admin-regions-pmtiles.js exited with code ${result.status ?? 1}`);
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function ensureAdminRegionsPmtiles(options = {}) {
  const logger = options.logger || console;
  const mode = normalizeMode(options.mode || DEFAULT_MODE);
  const inputPath = path.resolve(REPO_ROOT, String(options.inputPath || DEFAULT_INPUT));
  const outputPath = path.resolve(REPO_ROOT, String(options.outputPath || DEFAULT_OUTPUT));
  const metadataPath = path.resolve(REPO_ROOT, String(options.metadataPath || DEFAULT_METADATA_OUTPUT));
  const tippecanoeBin = String(options.tippecanoeBin || DEFAULT_TIPPECANOE_BIN).trim() || DEFAULT_TIPPECANOE_BIN;

  if (mode === 'never') {
    logger.log('[admin-regions] pmtiles startup refresh disabled');
    return { status: 'skipped', reason: 'disabled' };
  }

  if (!fs.existsSync(inputPath)) {
    logger.warn(`[admin-regions] startup refresh skipped: missing input ${toRepoRelative(inputPath)}`);
    return { status: 'skipped', reason: 'missing_input' };
  }

  const outputExists = fs.existsSync(outputPath);
  const inputSha256 = hashFile(inputPath);
  const metadata = readMetadata(metadataPath);
  const rebuildReason = buildRebuildReason({
    mode,
    outputExists,
    metadata,
    inputSha256
  });

  if (!rebuildReason) {
    logger.log(`[admin-regions] pmtiles up to date: ${toRepoRelative(outputPath)}`);
    return { status: 'up_to_date', reason: 'metadata_match' };
  }

  logger.log(
    `[admin-regions] rebuilding pmtiles on startup (${rebuildReason}): ${toRepoRelative(outputPath)}`
  );

  ensureParentDir(outputPath);
  ensureParentDir(metadataPath);

  try {
    runPmtilesBuild({
      inputPath,
      outputPath,
      metadataPath,
      tippecanoeBin
    });
    return { status: outputExists ? 'rebuilt' : 'created', reason: rebuildReason };
  } catch (error) {
    const message = String(error?.message || error);
    if (outputExists && fs.existsSync(outputPath)) {
      logger.warn(`[admin-regions] rebuild failed, using existing pmtiles: ${message}`);
      return { status: 'failed_kept_existing', reason: rebuildReason, error: message };
    }
    throw error;
  }
}

module.exports = {
  ensureAdminRegionsPmtiles
};

if (require.main === module) {
  ensureAdminRegionsPmtiles()
    .catch((error) => {
      console.error(`[admin-regions] startup refresh failed: ${String(error?.message || error)}`);
      process.exit(1);
    });
}
