# Graph Report - src  (2026-08-06)

## Corpus Check
- 109 files · ~81,753 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 830 nodes · 1746 edges · 28 communities (27 shown, 1 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 216 edges (avg confidence: 0.52)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1d62776d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- osm-sync.shared.ts
- building-filters.service.ts
- shell.ts
- server-runtime.routes.ts
- shared.ts
- admin-edits.service.ts
- app.route.ts
- db-runtime.infra.ts
- search-index-source.service.ts
- server-runtime.middleware.ts
- server-runtime.boot.ts
- presets.ts
- mini-app.infra.ts
- data-settings.ts
- edits.service.ts
- data-settings.service.ts
- region-catalog.ts
- .initializeSubsystems
- ServerRuntime
- createDataSettingsService
- version.ts
- region-pmtiles.boot.ts
- .constructor
- style-region-overrides.service.ts
- shared.ts
- region-sync-pipeline.ts
- session-store.infra.ts
- rate-limiter.service.ts

## God Nodes (most connected - your core abstractions)
1. `sendCachedJson()` - 21 edges
2. `emailShell()` - 19 edges
3. `createOsmCandidateResolver()` - 19 edges
4. `normalizeEmailLocale()` - 18 edges
5. `registerServerRuntimeRoutes()` - 16 edges
6. `ServerRuntime` - 15 edges
7. `getEmailCopy()` - 15 edges
8. `registrationCodeHtmlTemplate()` - 15 edges
9. `smtpTestHtmlTemplate()` - 14 edges
10. `createOsmOauthController()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `registerServerRuntimeRoutes()` --indirect_call--> `requireCsrfSession()`  [INFERRED]
  src/lib/server/boot/server-runtime.routes.ts → src/lib/server/services/csrf.service.ts
- `registerAuthRoutes()` --indirect_call--> `requireCsrfSession()`  [INFERRED]
  src/lib/server/auth/auth.route.ts → src/lib/server/services/csrf.service.ts
- `registerServerRuntimeRoutes()` --indirect_call--> `passwordResetHtmlTemplate()`  [INFERRED]
  src/lib/server/boot/server-runtime.routes.ts → src/lib/server/email-templates/password-reset.ts
- `registerServerRuntimeRoutes()` --indirect_call--> `passwordResetTextTemplate()`  [INFERRED]
  src/lib/server/boot/server-runtime.routes.ts → src/lib/server/email-templates/password-reset.ts
- `registerServerRuntimeRoutes()` --indirect_call--> `registrationCodeHtmlTemplate()`  [INFERRED]
  src/lib/server/boot/server-runtime.routes.ts → src/lib/server/email-templates/registration.ts

## Import Cycles
- None detected.

## Communities (28 total, 1 thin omitted)

### Community 0 - "osm-sync.shared.ts"
Cohesion: 0.06
Nodes (82): RFC-7636, { URL }, exchangeCodeForToken(), fetchOsmElement(), fetchOsmElementVersion(), fetchOsmUserDetails(), fetchText(), LooseOsmClientDeps (+74 more)

### Community 1 - "building-filters.service.ts"
Cohesion: 0.06
Nodes (66): { buildFilterMatchBatchResults, createBuildingFiltersService }, buildSourceSnapshot(), {
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
}, { createBuildingsRepository }, { getFeatureKindFromTagsJson }, normalizeJsonText(), registerBuildingsRoutes(), { sendCachedJson } (+58 more)

### Community 2 - "shell.ts"
Cohesion: 0.08
Nodes (63): { appendLocaleParam, getEmailCopy, resolveEmailLocale }, crypto, {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
}, { sendMailWithFallback }, registerServerRuntimeRoutes(), { passwordResetHtmlTemplate, passwordResetTextTemplate }, { registrationCodeHtmlTemplate, registrationCodeTextTemplate }, { smtpTestHtmlTemplate, smtpTestTextTemplate } (+55 more)

### Community 3 - "server-runtime.routes.ts"
Cohesion: 0.06
Nodes (47): applyResultHeaders(), { createAuthService }, { createUserProfileService }, registerAuthRoutes(), { requireCsrfSession }, { sendCachedJson }, sendJsonResult(), createAuthService() (+39 more)

### Community 4 - "shared.ts"
Cohesion: 0.06
Nodes (44): AddressRowLike, AddressTagMap, normalizeText(), osmAddressFromTags(), parseTags(), pickTagValue(), resolveDisplayAddressForRow(), createBuildingEditHistoryService() (+36 more)

### Community 5 - "admin-edits.service.ts"
Cohesion: 0.06
Nodes (45): { createAdminEditsService }, { createAdminSettingsService }, { createOsmSyncService }, registerAdminRoutes(), { requireMasterAdmin }, { resolveEmailLocale }, sendAdminError(), { sendCachedJson } (+37 more)

### Community 6 - "app.route.ts"
Cohesion: 0.08
Nodes (43): createRuntimeSettingsBoot(), { createRuntimeSettingsCache }, {
  DEFAULT_CUSTOM_BASEMAP_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
}, createSvelteNodeHandlerInvoker(), {
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
}, fs, path (+35 more)

### Community 7 - "db-runtime.infra.ts"
Cohesion: 0.08
Nodes (30): { createDbRuntime }, createDbRuntimeBoot(), createDeferredDb(), ensureParentDir(), fs, initDbBootstrapInfra(), path, { runPendingMigrations } (+22 more)

### Community 8 - "search-index-source.service.ts"
Cohesion: 0.09
Nodes (31): createSearchIndexBoot(), { createSearchIndexRefreshDispatcher }, { createSearchIndexRefreshService }, createSearchIndexRefreshDispatcher(), buildRender3dPropertiesFromTags(), { createBuildingsRepository }, createFeatureInfoSupport(), { getFeatureKindFromTagsJson } (+23 more)

### Community 9 - "server-runtime.middleware.ts"
Cohesion: 0.08
Nodes (30): { collectInlineScriptHashesFromFile }, createServerRuntimeConfig(), { parseRuntimeEnv }, path, { applySecurityHeadersMiddleware }, applyServerRuntimeMiddleware(), { initObservabilityInfra }, { jsonMiddleware } (+22 more)

### Community 10 - "server-runtime.boot.ts"
Cohesion: 0.06
Nodes (33): createRateLimiters(), { applyServerRuntimeMiddleware }, { createAppSettingsService }, { createAuthMiddlewareSupport }, { createBuildingEditsService }, { createDataSettingsService }, { createDbRuntimeBoot }, { createDesignRefSuggestionsBoot } (+25 more)

### Community 11 - "presets.ts"
Cohesion: 0.11
Nodes (24): { DEFAULT_FILTER_PRESETS }, FILTER_PRESET_LAYER_MODES, FILTER_PRESET_NUMERIC_OPS, FILTER_PRESET_RULE_OPS, mapPresetRow(), normalizeLayerColor(), normalizeLayerMode(), normalizeLayers() (+16 more)

### Community 12 - "mini-app.infra.ts"
Cohesion: 0.14
Nodes (26): applyRequestHelpers(), applyResponseHelpers(), cloneRegex(), createMiniApp(), createParamMatcher(), createRegexMatcher(), createStringMatcher(), escapeRegExp() (+18 more)

### Community 13 - "data-settings.ts"
Cohesion: 0.12
Nodes (18): createExtractsDomain(), AdminDataSettings, AdminDataSettingsPayload, DataSettingsBootstrapState, FilterPresetSaveInput, FilterTagAllowlistState, RegionDraft, RegionExtractCandidate (+10 more)

### Community 14 - "edits.service.ts"
Cohesion: 0.22
Nodes (18): ARCHI_EDITED_FIELD_ALIASES, CONCRETE_BUILDING_MATERIAL_VARIANTS, normalizeBuildingMaterialSelectionKey(), normalizeConcreteBuildingMaterialVariant(), normalizeEditedFieldKey(), normalizeRoofShapeSelection(), normalizeUserEditStatus(), ROOF_SHAPE_CANONICAL_VALUES (+10 more)

### Community 15 - "data-settings.service.ts"
Cohesion: 0.15
Nodes (16): createBootstrapDomain(), buildLegacyRegionPmtilesFileName(), buildRegionPmtilesFileName(), { createBootstrapDomain }, { createDataSettingsContext }, { createExtractsDomain }, { createPresetsDomain }, { createRegionCatalog } (+8 more)

### Community 16 - "region-catalog.ts"
Cohesion: 0.20
Nodes (11): createCountrySubregionsCatalog(), { createRegionCatalog }, SKIP_COUNTRY_IDS, createRegionCatalog(), DEFAULT_REGION_CATALOG_PATH, fs, normalizeBoolean(), normalizeNullableText() (+3 more)

### Community 17 - ".initializeSubsystems"
Cohesion: 0.18
Nodes (7): createDesignRefSuggestionsBoot(), createFilterTagKeysBoot(), createAppSettingsService(), DEFAULT_FILTER_TAG_ALLOWLIST, normalizeFilterTagKey(), normalizeFilterTagKeyList(), createSearchService()

### Community 18 - "ServerRuntime"
Cohesion: 0.26
Nodes (3): createServerRuntime(), runPostDbStartupTasks(), ServerRuntime

### Community 19 - "createDataSettingsService"
Cohesion: 0.22
Nodes (8): createPresetsDomain(), createRegionsDomain(), DELETE_REGION_SQL, createDataSettingsService(), createUpstreamDomain(), Region, RegionInput, RegionUpstreamStatus

### Community 20 - "version.ts"
Cohesion: 0.31
Nodes (9): fallbackVersionPayload(), fs, getAppVersion(), getBuildInfo(), normalizeVersion(), PACKAGE_JSON_PATH, path, readJson() (+1 more)

### Community 21 - "region-pmtiles.boot.ts"
Cohesion: 0.25
Nodes (7): createRegionPmtilesBoot(), fs, { moveFileSync }, path, { resolveLegacyRegionPmtilesPath, resolveRegionPmtilesPath }, fs, moveFileSync()

### Community 22 - ".constructor"
Cohesion: 0.25
Nodes (4): runPostSyncTasks(), registerErrorHandlers(), initManagedSyncWorkers(), initSyncWorkersInfra()

### Community 23 - "style-region-overrides.service.ts"
Cohesion: 0.31
Nodes (6): createStyleRegionOverrideError(), createStyleRegionOverridesService(), LooseStyleOverrideError, normalizeIsAllowed(), normalizeRegionPattern(), normalizeStyleKey()

### Community 24 - "shared.ts"
Cohesion: 0.29
Nodes (6): ensureCompatDb(), wrapRawSqliteDb(), createSyncRunsDomain(), { RUN_SELECT_FIELDS }, RegionBounds, RegionResolutionStatus

### Community 25 - "region-sync-pipeline.ts"
Cohesion: 0.38
Nodes (6): normalizeRegionSyncPhase(), normalizeRegionSyncStage(), REGION_SYNC_PHASE_ORDER, REGION_SYNC_PHASE_SET, REGION_SYNC_PIPELINE_STAGE_SET, REGION_SYNC_PIPELINE_STAGES

### Community 26 - "session-store.infra.ts"
Cohesion: 0.47
Nodes (5): { createClient }, initSessionStore(), { RedisStore }, sanitizeRedisUrl(), session

## Knowledge Gaps
- **234 isolated node(s):** `{ requireCsrfSession }`, `{ sendCachedJson }`, `{ createAuthService }`, `{ createUserProfileService }`, `crypto` (+229 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `registerServerRuntimeRoutes()` connect `shell.ts` to `building-filters.service.ts`, `server-runtime.routes.ts`, `admin-edits.service.ts`, `app.route.ts`, `server-runtime.boot.ts`, `.constructor`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `sendCachedJson()` connect `server-runtime.routes.ts` to `building-filters.service.ts`, `admin-edits.service.ts`, `app.route.ts`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `createOsmSyncService()` connect `osm-sync.shared.ts` to `.initializeSubsystems`, `server-runtime.boot.ts`, `admin-edits.service.ts`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `registerServerRuntimeRoutes()` (e.g. with `server-runtime.routes.ts` and `passwordResetHtmlTemplate()`) actually correct?**
  _`registerServerRuntimeRoutes()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `{ requireCsrfSession }`, `{ sendCachedJson }`, `{ createAuthService }` to the rest of the system?**
  _234 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `osm-sync.shared.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06179775280898876 - nodes in this community are weakly interconnected._
- **Should `building-filters.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05639097744360902 - nodes in this community are weakly interconnected._