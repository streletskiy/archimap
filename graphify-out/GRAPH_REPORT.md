# Graph Report - src  (2026-10-30)

## Corpus Check
- 112 files · ~83,660 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1322 nodes · 2966 edges · 66 communities
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 476 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e2f7e94e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- osm-repair.service.ts
- building-filters.service.ts
- shell.ts
- server-runtime.routes.ts
- building-edits.ts
- admin-edits.service.ts
- basemap-proxy.service.ts
- db-runtime.infra.ts
- createSearchIndexBoot
- server-runtime.middleware.ts
- server-runtime.boot.ts
- presets.ts
- mini-app.infra.ts
- data-settings.ts
- edits.service.ts
- data-settings.service.ts
- createDataSettingsService
- .initializeSubsystems
- ServerRuntime
- regions.ts
- version.ts
- region-pmtiles.boot.ts
- .constructor
- style-region-overrides.service.ts
- data-settings/shared.ts
- region-sync-pipeline.ts
- session-store.infra.ts
- createAuthService
- createBuildingEditsContext
- createDataSettingsContext
- buildings.route.ts
- initManagedSyncWorkers
- osm-candidate-resolver.ts
- createOsmOauthController
- createAdminError
- createRegionsDomain
- runtime-settings.boot.ts
- app.route.ts
- createAppSettingsService
- filter-sql-builder.ts
- admin-settings.service.ts
- db-bootstrap.infra.ts
- building-filter-query.service.ts
- osm-changeset-builder.ts
- building-edits/shared.ts
- osm-sync.shared.ts
- search.route.ts
- createAdminEditsService
- createUpstreamDomain
- admin.route.ts
- createRuntimeSettingsBoot
- buildFilterMatchResultForRules
- server-runtime.config.ts
- csp.infra.ts
- osm-api-client.ts
- createMiniApp
- postgres-migrations.infra.ts
- logger.service.ts
- createFilterTagKeysBoot
- createRuntimeSettingsCache
- createSearchService
- createAuthMiddlewareSupport
- auth/index.ts
- createDesignRefSuggestionsBoot
- osm-sync.service.ts
- getRuleValue

## God Nodes (most connected - your core abstractions)
1. `createAuthService()` - 39 edges
2. `createOsmCandidateResolver()` - 31 edges
3. `createAdminError()` - 27 edges
4. `createOsmOauthController()` - 27 edges
5. `createAdminSettingsService()` - 26 edges
6. `createDataSettingsContext()` - 26 edges
7. `createBuildingEditsContext()` - 25 edges
8. `initManagedSyncWorkers()` - 23 edges
9. `createDataSettingsService()` - 23 edges
10. `createRegionsDomain()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `getLatestUserEditRow()` --indirect_call--> `normalizeUserEditStatus()`  [INFERRED]
  src/lib/server/services/building-edits/shared.ts → src/lib/server/services/edits.service.ts
- `registerAuthRoutes()` --indirect_call--> `requireCsrfSession()`  [INFERRED]
  src/lib/server/auth/auth.route.ts → src/lib/server/services/csrf.service.ts
- `registerServerRuntimeRoutes()` --indirect_call--> `requireCsrfSession()`  [INFERRED]
  src/lib/server/boot/server-runtime.routes.ts → src/lib/server/services/csrf.service.ts
- `withdrawPendingUserEdit()` --calls--> `assertMutableSyncStatus()`  [EXTRACTED]
  src/lib/server/services/building-edits/moderation.ts → src/lib/server/services/building-edits/shared.ts
- `selectTagOnlyPostgresMatchRowsByBbox()` --calls--> `compilePostgresFilterRulesPredicate()`  [EXTRACTED]
  src/lib/server/services/building-filter-query.service.ts → src/lib/server/utils/filter-sql-builder.ts

## Import Cycles
- None detected.

## Communities (66 total, 0 thin omitted)

### Community 0 - "osm-repair.service.ts"
Cohesion: 0.26
Nodes (20): assertEmptyRelation(), assertExpectedElement(), { closeChangeset, createChangeset, deleteOsmElement, updateOsmElement }, createOsmRepairService(), prepareMigration(), prepareRestore(), repairDamagedRelations(), currentId() (+12 more)

### Community 1 - "building-filters.service.ts"
Cohesion: 0.14
Nodes (28): isFilterTagAllowed(), getBuildingDataRevision(), applyPersonalEditsToFilterItems(), normalizeRenderMode(), shouldAggregateMarkerMatches(), applyPersonalEditsToRows(), {
  ARCHI_RULE_KEYS,
  FILTER_RULE_OPS,
  NUMERIC_FILTER_RULE_OPS,
  parseNumericFilterValue,
  splitPostgresPushdownRules
}, buildBboxHash() (+20 more)

### Community 2 - "shell.ts"
Cohesion: 0.08
Nodes (60): registerServerRuntimeRoutes(), { passwordResetHtmlTemplate, passwordResetTextTemplate }, { registrationCodeHtmlTemplate, registrationCodeTextTemplate }, { smtpTestHtmlTemplate, smtpTestTextTemplate }, appendLocaleParam(), buildEmailCopy(), EMAIL_CATALOG, EMAIL_SUPPORTED_LOCALES (+52 more)

### Community 3 - "server-runtime.routes.ts"
Cohesion: 0.05
Nodes (54): { appendLocaleParam, getEmailCopy, resolveEmailLocale }, crypto, {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
}, { sendMailWithFallback }, { registerAccountRoutes }, { registerAdminRoutes }, { registerAppRoutes }, { registerAuthRoutes } (+46 more)

### Community 4 - "building-edits.ts"
Cohesion: 0.12
Nodes (22): BuildingEdit, BuildingEditKnownStatus, BuildingEditListQuery, BuildingEditMergeCandidate, BuildingEditMergeValues, BuildingEditPageResult, BuildingEditSummary, BuildingEditSyncStatus (+14 more)

### Community 5 - "admin-edits.service.ts"
Cohesion: 0.15
Nodes (14): { assertMutableSyncStatus }, { createAdminError, isLikelyEmail, parseLimit, parseOsmTarget, parsePositiveId }, { hasSearchIndexRelevantFieldChange }, { splitBuildingMaterialSelection, sanitizeProjectYear }, parseOsmTarget(), hasSearchIndexRelevantFieldChange(), isSearchIndexRelevantField(), normalizeSearchIndexFieldKey() (+6 more)

### Community 6 - "basemap-proxy.service.ts"
Cohesion: 0.13
Nodes (22): sendLocalBasemapGlyph(), appendQueryParamToTemplateUrl(), buildCustomBasemapTileProxyUrl(), buildFetchCandidates(), cloneJson(), copyProxyHeaders(), {
  CUSTOM_BASEMAP_TILE_PROXY_URL,
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  buildBasemapSourceUrl,
  normalizeBasemapApiKey,
  normalizeCustomBasemapUrl
}, decodeGlyphPathSegment() (+14 more)

### Community 7 - "db-runtime.infra.ts"
Cohesion: 0.15
Nodes (18): { AsyncLocalStorage }, convertNamedParams(), convertPositionalParams(), createDbRuntime(), createPostgresCompatDb(), getQueryable(), runQuery(), createSqliteCompatDb() (+10 more)

### Community 8 - "createSearchIndexBoot"
Cohesion: 0.09
Nodes (40): createSearchIndexBoot(), enqueueSearchIndexRefresh(), flushDeferredSearchRefreshes(), flushQueuedSearchIndexRefreshes(), getSearchIndexCountsSnapshot(), getSearchRebuildDecision(), maybeRunQueuedSearchRebuild(), normalizeSearchRefreshTarget() (+32 more)

### Community 9 - "server-runtime.middleware.ts"
Cohesion: 0.15
Nodes (14): { advanceBuildingDataRevision }, { applySecurityHeadersMiddleware }, applyServerRuntimeMiddleware(), { initObservabilityInfra }, { jsonMiddleware }, advanceBuildingDataRevision(), lib_server_infra_lru_cache_infra_getcachemetrics, jsonMiddleware() (+6 more)

### Community 10 - "server-runtime.boot.ts"
Cohesion: 0.06
Nodes (34): createRateLimiters(), { applyServerRuntimeMiddleware }, { createAppSettingsService }, { createAuthMiddlewareSupport }, { createBuildingEditsService }, { createDataSettingsService }, { createDbRuntimeBoot }, { createDesignRefSuggestionsBoot } (+26 more)

### Community 11 - "presets.ts"
Cohesion: 0.09
Nodes (42): clonePresetLayers(), createPresetsDomain(), deleteFilterPresetById(), ensureDefaultFilterPresets(), getFilterPresetById(), getFilterPresetsForAdmin(), getFilterPresetsForRuntime(), listFilterPresets() (+34 more)

### Community 12 - "mini-app.infra.ts"
Cohesion: 0.13
Nodes (22): applyRequestHelpers(), cloneRegex(), createParamMatcher(), createRegexMatcher(), createStringMatcher(), escapeRegExp(), fs, http (+14 more)

### Community 13 - "data-settings.ts"
Cohesion: 0.11
Nodes (20): AdminDataSettings, AdminDataSettingsPayload, DataSettingsBootstrapState, FilterPresetSaveInput, FilterTagAllowlistState, RegionDraft, RegionExtractCandidate, RegionExtractSearchResult (+12 more)

### Community 14 - "edits.service.ts"
Cohesion: 0.20
Nodes (17): sanitizeMergeValues(), ARCHI_EDITED_FIELD_ALIASES, CONCRETE_BUILDING_MATERIAL_VARIANTS, normalizeBuildingMaterialSelectionKey(), normalizeConcreteBuildingMaterialVariant(), normalizeEditedFieldKey(), ROOF_SHAPE_CANONICAL_VALUES, ROOF_SHAPE_NORMALIZED_ALIASES (+9 more)

### Community 15 - "data-settings.service.ts"
Cohesion: 0.13
Nodes (17): createBootstrapDomain(), bootstrapFromEnvIfNeeded(), ensureBootstrapped(), getBootstrapState(), writeBootstrapState(), buildRegionPmtilesFileName(), { createBootstrapDomain }, { createDataSettingsContext } (+9 more)

### Community 16 - "createDataSettingsService"
Cohesion: 0.08
Nodes (38): createCountrySubregionsCatalog(), getCountry(), { createRegionCatalog }, SKIP_COUNTRY_IDS, createExtractsDomain(), hasExtractResolver(), hasRegionCatalog(), normalizeCatalogEntry() (+30 more)

### Community 17 - ".initializeSubsystems"
Cohesion: 0.24
Nodes (6): DEFAULT_FILTER_TAG_ALLOWLIST, normalizeFilterTagKey(), normalizeFilterTagKeyList(), { createClient }, createRateLimiterFactory(), ref_redis

### Community 18 - "ServerRuntime"
Cohesion: 0.24
Nodes (3): createServerRuntime(), runPostDbStartupTasks(), ServerRuntime

### Community 19 - "regions.ts"
Cohesion: 0.25
Nodes (7): DELETE_REGION_SQL, Region, RegionInput, RegionUpstreamStatus, lib_shared_types_index_region, lib_shared_types_index_regioninput, lib_shared_types_index_regionupstreamstatus

### Community 20 - "version.ts"
Cohesion: 0.31
Nodes (9): fallbackVersionPayload(), fs, getAppVersion(), getBuildInfo(), normalizeVersion(), PACKAGE_JSON_PATH, path, readJson() (+1 more)

### Community 21 - "region-pmtiles.boot.ts"
Cohesion: 0.19
Nodes (13): createRegionPmtilesBoot(), migrateRegionPmtilesFile(), removeRegionPmtilesFiles(), fs, { moveFileSync }, path, { resolveLegacyRegionPmtilesPath, resolveRegionPmtilesPath }, buildLegacyRegionPmtilesFileName() (+5 more)

### Community 22 - ".constructor"
Cohesion: 0.18
Nodes (6): runPostSyncTasks(), registerErrorHandlers(), { createHmac, timingSafeEqual }, createSyncWorkerClient(), workerToken(), ref_node_crypto

### Community 23 - "style-region-overrides.service.ts"
Cohesion: 0.31
Nodes (12): createStyleRegionOverrideError(), createStyleRegionOverridesService(), deleteOverride(), listOverridesForAdmin(), listPublicOverrides(), saveOverride(), LooseStyleOverrideError, mapOverrideRow() (+4 more)

### Community 24 - "data-settings/shared.ts"
Cohesion: 0.22
Nodes (8): ensureCompatDb(), lib_server_services_data_settings_shared_run_select_fields, wrapRawSqliteDb(), { RUN_SELECT_FIELDS }, RegionBounds, RegionResolutionStatus, lib_shared_types_index_regionbounds, lib_shared_types_index_regionresolutionstatus

### Community 25 - "region-sync-pipeline.ts"
Cohesion: 0.29
Nodes (4): REGION_SYNC_PHASE_ORDER, REGION_SYNC_PHASE_SET, REGION_SYNC_PIPELINE_STAGE_SET, REGION_SYNC_PIPELINE_STAGES

### Community 26 - "session-store.infra.ts"
Cohesion: 0.17
Nodes (13): { createDbRuntime }, createDbRuntimeBoot(), createDeferredDb(), { createReadinessProbe }, createReadinessProbe(), { createClient }, { createReadinessProbe }, initSessionStore() (+5 more)

### Community 27 - "createAuthService"
Cohesion: 0.09
Nodes (45): applyResultHeaders(), { createAuthService }, { createUserProfileService }, registerAuthRoutes(), { requireCsrfSession }, { sendCachedJson }, sendJsonResult(), createAuthService() (+37 more)

### Community 28 - "createBuildingEditsContext"
Cohesion: 0.08
Nodes (43): createBuildingEditHistoryService(), buildFilteredUserEditsSql(), buildUserEditsWhereParts(), getUserEditsPage(), getUserEditsPageRaw(), listFilteredUserEditAuthors(), normalizeDateInput(), { assertMutableSyncStatus } (+35 more)

### Community 29 - "createDataSettingsContext"
Cohesion: 0.12
Nodes (36): listRegionTree(), createDataSettingsContext(), addHours(), boundsFromRow(), computeNextSyncAt(), hasResolvedExtract(), normalizeBoolean(), normalizeBounds() (+28 more)

### Community 30 - "buildings.route.ts"
Cohesion: 0.09
Nodes (34): { buildFilterMatchBatchResults, createBuildingFiltersService }, buildSourceSnapshot(), {
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
}, { createBuildingsRepository }, { getFeatureKindFromTagsJson }, normalizeJsonText(), registerBuildingsRoutes(), { sendCachedJson, sendCompressedJson } (+26 more)

### Community 31 - "initManagedSyncWorkers"
Cohesion: 0.13
Nodes (28): initManagedSyncWorkers(), buildFailureMessage(), clearRegionTimers(), clearRunMaintenanceTimers(), drainQueue(), ensureRunMaintenanceTimers(), finalizeRun(), flushDeferredSyncSuccess() (+20 more)

### Community 32 - "osm-candidate-resolver.ts"
Cohesion: 0.17
Nodes (29): CandidateResolverDeps, createOsmCandidateResolver(), buildCandidateGroupCtes(), buildCandidateRecord(), buildSyncModeWhereClause(), cleanupSyncedLocalOverwritesAfterImport(), getSyncCandidate(), listSyncCandidates() (+21 more)

### Community 33 - "createOsmOauthController"
Cohesion: 0.21
Nodes (26): exchangeCodeForToken(), createOsmOauthController(), consumeOauthState(), createOauthState(), decrypt(), encrypt(), getCredentials(), getSettingsForAdmin() (+18 more)

### Community 34 - "createAdminError"
Cohesion: 0.20
Nodes (26): createAdminSettingsService(), createCountryAggregate(), deleteFilterPreset(), deleteRegion(), ensureAppSettingsService(), ensureDataSettingsService(), getDataSettingsItem(), getGeneralSettingsItem() (+18 more)

### Community 35 - "createRegionsDomain"
Cohesion: 0.22
Nodes (20): createRegionsDomain(), assertCountryAggregateUpgradeAllowed(), buildCountryAggregateRegionInput(), buildDeleteResult(), buildRegionExtractKey(), countActiveRuns(), createCountryAggregate(), deleteRegion() (+12 more)

### Community 36 - "runtime-settings.boot.ts"
Cohesion: 0.19
Nodes (16): { createRuntimeSettingsCache }, {
  DEFAULT_CUSTOM_BASEMAP_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
}, getEffectiveBasemapSettings(), normalizeBasemapConfig(), crypto, {
  DEFAULT_CUSTOM_BASEMAP_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
}, buildBasemapSourceUrl(), buildProtomapsSpriteProxyUrl() (+8 more)

### Community 37 - "app.route.ts"
Cohesion: 0.14
Nodes (16): createSvelteNodeHandlerInvoker(), {
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  CUSTOM_BASEMAP_TILE_PROXY_URL,
  DEFAULT_CUSTOM_BASEMAP_URL,
  buildBasemapSourceUrl,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
}, {
  fetchRemoteJson,
  resolveLocalBasemapGlyphPath,
  rewriteCustomBasemapTileJson,
  sendProxiedBinaryResponse
}, fs, path, { pathToFileURL }, registerAppRoutes(), getAvailableRegionPmtiles() (+8 more)

### Community 38 - "createAppSettingsService"
Cohesion: 0.25
Nodes (18): createAppSettingsService(), buildSmtpConfigFromInput(), decryptSecret(), encryptSecret(), getEffectiveGeneralConfig(), getEffectiveSmtpConfig(), getGeneralSettingsForAdmin(), getGeneralSettingsSchema() (+10 more)

### Community 39 - "filter-sql-builder.ts"
Cohesion: 0.25
Nodes (17): selectGuardedPostgresCandidateRowsByBbox(), ARCHI_RULE_COLUMN_ORDER, buildPostgresNumericValueSql(), buildPostgresRuleValueSql(), buildPostgresTagValueSql(), collectRequiredArchiColumns(), compilePostgresFilterRuleGuardPredicate(), compilePostgresFilterRulePredicate() (+9 more)

### Community 40 - "admin-settings.service.ts"
Cohesion: 0.16
Nodes (15): lib_server_email_templates_index_smtptesthtmltemplate, lib_server_email_templates_index_smtptesttexttemplate, getUserByEmail(), getUserEditsByEmail(), { appendLocaleParam, getEmailCopy, resolveEmailLocale }, {
  createAdminError,
  isLikelyEmail,
  parseRegionId,
  parseLimit,
  resolveAppDisplayName,
  resolveAppBaseUrl
}, buildEmailPreviewPayload(), normalizeRegionIdList() (+7 more)

### Community 41 - "db-bootstrap.infra.ts"
Cohesion: 0.16
Nodes (12): ensureParentDir(), fs, initDbBootstrapInfra(), rebuildBuildingContoursRtreeInBackground(), scheduleBuildingContoursRtreeRebuild(), path, { runPendingMigrations }, ensureMigrationsTable() (+4 more)

### Community 42 - "building-filter-query.service.ts"
Cohesion: 0.20
Nodes (15): buildRender3dPropertiesFromSourceTags(), {
  collectRequiredArchiColumns,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
}, createBuildingFilterQueryService(), getBboxQueryMode(), selectBatchFilterRowsByBbox(), selectFilterRowsByBbox(), selectTagOnlyPostgresMatchRowsByBbox(), deriveLevelsTextFromSourceTags() (+7 more)

### Community 43 - "osm-changeset-builder.ts"
Cohesion: 0.24
Nodes (16): assertElementStructurePreserved(), buildChangesetComment(), buildChangesetTags(), buildElementStructureLines(), buildElementXml(), deleteOsmElement(), normalizeElementRef(), normalizeElementStructure() (+8 more)

### Community 44 - "building-edits/shared.ts"
Cohesion: 0.18
Nodes (14): AddressRowLike, AddressTagMap, normalizeText(), osmAddressFromTags(), parseTags(), pickTagValue(), resolveDisplayAddressForRow(), {
  osmAddressFromTags: sharedOsmAddressFromTags,
  resolveDisplayAddressForRow: sharedResolveDisplayAddressForRow
} (+6 more)

### Community 45 - "osm-sync.shared.ts"
Cohesion: 0.21
Nodes (14): RFC-7636, normalizeRoofShapeSelection(), applyFieldToTagMap(), cloneTagMap(), controlledKeysForField(), crypto, isMasterOsmAuthBaseUrl(), LooseOsmError (+6 more)

### Community 46 - "search.route.ts"
Cohesion: 0.20
Nodes (10): { createLruCache }, { getBuildingDataRevision }, parseSearchBbox(), parseStyleKeys(), registerSearchRoutes(), { sendCachedJson }, createLruCache(), get() (+2 more)

### Community 47 - "createAdminEditsService"
Cohesion: 0.36
Nodes (14): createAdminEditsService(), buildMergedCandidate(), bulkMergeBuildingEdits(), deleteBuildingEdit(), getBuildingEditDetails(), listBuildingEdits(), mergeBuildingEdit(), queueDesignRefSuggestionsRefresh() (+6 more)

### Community 48 - "createUpstreamDomain"
Cohesion: 0.34
Nodes (14): createUpstreamDomain(), compareSourceTimestamps(), createRegionUpstreamState(), enrichRegionsWithUpstreamState(), fetchHeadTimestamp(), fetchLatestSourceMetadata(), fetchOsmfrStateTimestamp(), fetchWithTimeout() (+6 more)

### Community 49 - "admin.route.ts"
Cohesion: 0.22
Nodes (12): { createAdminEditsService }, { createAdminSettingsService }, { createOsmSyncService }, registerAdminRoutes(), { requireMasterAdmin }, { resolveEmailLocale }, sendAdminError(), { sendCachedJson } (+4 more)

### Community 50 - "createRuntimeSettingsBoot"
Cohesion: 0.23
Nodes (6): createRuntimeSettingsBoot(), getAppBaseUrl(), getAppDisplayName(), getEffectiveGeneralConfig(), getRegistrationEnabled(), getUserEditRequiresPermission()

### Community 51 - "buildFilterMatchResultForRules"
Cohesion: 0.26
Nodes (11): buildMarkerAggregationCellId(), buildMarkerAggregationCellKey(), buildStableHash32(), getMarkerAggregationGridColumns(), getMarkerAggregationGridShape(), getMarkerAggregationLegacyCellSize(), normalizeMarkerAggregationBbox(), buildFilterMatchResultForRules() (+3 more)

### Community 52 - "server-runtime.config.ts"
Cohesion: 0.24
Nodes (9): { collectInlineScriptHashesFromFile }, createServerRuntimeConfig(), { parseRuntimeEnv }, path, collectInlineScriptHashesFromFile(), envSchema, parseRuntimeEnv(), { z } (+1 more)

### Community 53 - "csp.infra.ts"
Cohesion: 0.31
Nodes (8): buildCspDirectives(), crypto, extractInlineScriptHashesFromHtml(), fs, normalizeOrigins(), serializeCspDirectives(), applySecurityHeadersMiddleware(), { buildCspDirectives, serializeCspDirectives }

### Community 54 - "osm-api-client.ts"
Cohesion: 0.44
Nodes (8): fetchOsmElement(), fetchOsmElementVersion(), fetchOsmUserDetails(), fetchText(), LooseOsmClientDeps, attrsToObject(), parseElementXml(), parseOsmElementResponse()

### Community 55 - "createMiniApp"
Cohesion: 0.39
Nodes (8): applyResponseHelpers(), createMiniApp(), addRoute(), executeHandler(), flattenHandlers(), registerLayer(), setDefaultContentType(), writePayload()

### Community 56 - "postgres-migrations.infra.ts"
Cohesion: 0.32
Nodes (7): { Client }, ensurePostgresMigrationsTable(), fs, listPostgresMigrationFiles(), path, runPendingPostgresMigrations(), ref_pg

### Community 57 - "logger.service.ts"
Cohesion: 0.32
Nodes (7): createLogger(), write(), crypto, LEVEL_PRIORITY, { maskSensitive }, normalizeLevel(), maskSensitive()

### Community 58 - "createFilterTagKeysBoot"
Cohesion: 0.38
Nodes (4): createFilterTagKeysBoot(), getAllFilterTagKeysCached(), getFilterTagKeysCached(), scheduleFilterTagKeysCacheRebuild()

### Community 59 - "createRuntimeSettingsCache"
Cohesion: 0.52
Nodes (6): createRuntimeSettingsCache(), applySnapshot(), getValue(), refresh(), updateCache(), isPlainObject()

### Community 60 - "createSearchService"
Cohesion: 0.52
Nodes (6): createSearchService(), buildFtsMatchQuery(), getBuildingSearchResults(), getLocalEditsSearchResults(), normalizeSearchBbox(), normalizeSearchTokens()

### Community 61 - "createAuthMiddlewareSupport"
Cohesion: 0.47
Nodes (4): createAuthMiddlewareSupport(), isAdminRequest(), requireAdmin(), requireBuildingEditPermission()

### Community 62 - "auth/index.ts"
Cohesion: 0.50
Nodes (3): { ensureAuthSchema }, { registerAuthRoutes }, ensureAuthSchema()

### Community 63 - "createDesignRefSuggestionsBoot"
Cohesion: 0.50
Nodes (3): createDesignRefSuggestionsBoot(), getDesignRefSuggestionsCached(), refreshDesignRefSuggestionsCache()

### Community 64 - "osm-sync.service.ts"
Cohesion: 0.40
Nodes (4): { createOsmCandidateResolver }, { createOsmOauthController }, { createOsmRepairService }, OsmSyncServiceDeps

### Community 65 - "getRuleValue"
Cohesion: 0.67
Nodes (4): getRuleValue(), hasMeaningfulValue(), matchesFilterRule(), normalizeTagValue()

## Knowledge Gaps
- **265 isolated node(s):** `{ requireCsrfSession }`, `{ sendCachedJson }`, `{ createAuthService }`, `{ createUserProfileService }`, `crypto` (+260 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 365 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createDataSettingsService()` connect `createDataSettingsService` to `createRegionsDomain`, `server-runtime.boot.ts`, `presets.ts`, `data-settings.service.ts`, `createUpstreamDomain`, `.initializeSubsystems`, `createDataSettingsContext`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `registerServerRuntimeRoutes()` connect `shell.ts` to `server-runtime.routes.ts`, `app.route.ts`, `server-runtime.boot.ts`, `search.route.ts`, `admin.route.ts`, `.constructor`, `buildings.route.ts`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `createRegionsDomain()` connect `createRegionsDomain` to `createDataSettingsService`, `regions.ts`, `createDataSettingsContext`, `data-settings.service.ts`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `createAuthService()` (e.g. with `auth.service.ts` and `changePassword()`) actually correct?**
  _`createAuthService()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Are the 5 inferred relationships involving `createOsmCandidateResolver()` (e.g. with `cleanupSyncedLocalOverwritesAfterImport()` and `getSyncCandidate()`) actually correct?**
  _`createOsmCandidateResolver()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 5 inferred relationships involving `createOsmOauthController()` (e.g. with `getCredentials()` and `getSettingsForAdmin()`) actually correct?**
  _`createOsmOauthController()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 22 inferred relationships involving `createAdminSettingsService()` (e.g. with `admin-settings.service.ts` and `buildEmailPreviewPayload()`) actually correct?**
  _`createAdminSettingsService()` has 22 INFERRED edges - model-reasoned connections that need verification._