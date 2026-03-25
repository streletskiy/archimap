const { createOsmOauthController } = require('./osm-oauth');
const { createOsmCandidateResolver } = require('./osm-candidate-resolver');

type OsmSyncServiceDeps = {
  db?: any;
  settingsSecret?: string;
  appSettingsService?: {
    getGeneralSettingsForAdmin?: () => Promise<any>;
  } | null;
  enqueueSearchIndexRefresh?: (osmType: string, osmId: number) => void;
  refreshDesignRefSuggestionsCache?: (reason?: string) => Promise<any> | any;
};

function createOsmSyncService(options: OsmSyncServiceDeps = {}) {
  const {
    db,
    settingsSecret,
    appSettingsService,
    enqueueSearchIndexRefresh,
    refreshDesignRefSuggestionsCache
  } = options;

  const oauth = createOsmOauthController({
    db,
    settingsSecret,
    appSettingsService
  });

  const candidateResolver = createOsmCandidateResolver({
    db,
    getCredentials: oauth.getCredentials,
    enqueueSearchIndexRefresh,
    refreshDesignRefSuggestionsCache
  });

  return {
    getSettingsForAdmin: oauth.getSettingsForAdmin,
    saveSettings: oauth.saveSettings,
    startOAuth: oauth.startOAuth,
    handleOauthCallback: oauth.handleOauthCallback,
    listSyncCandidates: candidateResolver.listSyncCandidates,
    getSyncCandidate: candidateResolver.getSyncCandidate,
    syncCandidatesToOsm: candidateResolver.syncCandidatesToOsm,
    syncCandidateToOsm: candidateResolver.syncCandidateToOsm,
    cleanupSyncedLocalOverwritesAfterImport: candidateResolver.cleanupSyncedLocalOverwritesAfterImport
  };
}

module.exports = {
  createOsmSyncService
};
