function createBootstrapDomain(context: LooseRecord = {}) {
  const {
    db,
    state,
    countRegions,
    listRegionRows,
    rowToRegion,
    readAppDataSettingsRow,
    normalizeNullableText
  } = context;

  async function getBootstrapState() {
    const settingsRow = await readAppDataSettingsRow();
    return {
      completed: Number(settingsRow?.env_bootstrap_completed || 0) > 0,
      source: settingsRow?.env_bootstrap_source ? String(settingsRow.env_bootstrap_source) : null,
      updatedBy: settingsRow?.updated_by ? String(settingsRow.updated_by) : null,
      updatedAt: settingsRow?.updated_at ? String(settingsRow.updated_at) : null
    };
  }

  async function writeBootstrapState(source, actor = 'system') {
    const updatedBy = normalizeNullableText(actor, 160);
    await db.prepare(`
      INSERT INTO app_data_settings (
        id,
        env_bootstrap_completed,
        env_bootstrap_source,
        updated_by,
        updated_at
      )
      VALUES (1, 1, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        env_bootstrap_completed = 1,
        env_bootstrap_source = excluded.env_bootstrap_source,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(String(source || 'legacy-env'), updatedBy);
  }

  async function bootstrapFromEnvIfNeeded(actor = 'system') {
    if (state.bootstrapPromise) return state.bootstrapPromise;

    state.bootstrapPromise = (async () => {
      const existingRegions = await countRegions();
      if (existingRegions > 0) {
        return {
          source: 'db',
          imported: false,
          regions: (await listRegionRows()).map(rowToRegion)
        };
      }

      const bootstrapState = await getBootstrapState();
      if (bootstrapState.completed) {
        return {
          source: 'db',
          imported: false,
          regions: (await listRegionRows()).map(rowToRegion)
        };
      }

      await writeBootstrapState('db-only', actor);
      return {
        source: 'db',
        imported: false,
        regions: (await listRegionRows()).map(rowToRegion)
      };
    })();

    try {
      return await state.bootstrapPromise;
    } finally {
      state.bootstrapPromise = null;
    }
  }

  async function ensureBootstrapped() {
    await bootstrapFromEnvIfNeeded('env-bootstrap');
  }

  return {
    getBootstrapState,
    bootstrapFromEnvIfNeeded,
    ensureBootstrapped
  };
}

module.exports = {
  createBootstrapDomain
};
