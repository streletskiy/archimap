require('dotenv').config({ quiet: true });

const { ensureAdminRegionsPmtiles } = require('./ensure-admin-regions-pmtiles');

async function main() {
  await ensureAdminRegionsPmtiles({
    mode: process.env.ADMIN_REGIONS_PMTILES_ON_START || 'auto',
    logger: console
  });
  require('../server.sveltekit.ts');
}

main().catch((error) => {
  console.error('[runtime-start] startup failed:', String(error?.message || error));
  process.exit(1);
});
