const fs = require('fs');
const path = require('path');
const { moveFileSync } = require('../utils/fs');
const {
  resolveLegacyRegionPmtilesPath,
  resolveRegionPmtilesPath
} = require('../services/data-settings.service');

function createRegionPmtilesBoot(options: LooseRecord = {}) {
  const {
    dataDir,
    logger = console
  } = options;

  function migrateRegionPmtilesFile(previousRegion, savedRegion) {
    if (!savedRegion?.slug || !savedRegion?.id) return;
    const targetPath = resolveRegionPmtilesPath(dataDir, savedRegion);
    if (fs.existsSync(targetPath)) return;

    const candidatePaths = [];
    if (previousRegion?.slug) {
      candidatePaths.push(resolveRegionPmtilesPath(dataDir, previousRegion));
    }
    candidatePaths.push(resolveLegacyRegionPmtilesPath(dataDir, savedRegion.id));

    const sourcePath = candidatePaths.find((candidate) => candidate && candidate !== targetPath && fs.existsSync(candidate));
    if (!sourcePath) return;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    moveFileSync(sourcePath, targetPath);
    logger.info('region_pmtiles_migrated', {
      regionId: savedRegion.id,
      slug: savedRegion.slug,
      from: path.basename(sourcePath),
      to: path.basename(targetPath)
    });
  }

  function removeRegionPmtilesFiles(region) {
    if (!region?.id) return;
    const candidates = [
      region?.slug ? resolveRegionPmtilesPath(dataDir, region) : null,
      resolveLegacyRegionPmtilesPath(dataDir, region.id)
    ].filter(Boolean);

    for (const filePath of candidates) {
      for (const candidate of [filePath, `${filePath}.bak`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.rmSync(candidate, { force: true });
          }
        } catch {
          // ignore file cleanup failures; region is already deleted from DB
        }
      }
    }
  }

  return {
    migrateRegionPmtilesFile,
    removeRegionPmtilesFiles
  };
}

module.exports = {
  createRegionPmtilesBoot
};
