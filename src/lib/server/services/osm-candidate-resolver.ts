import {
  buildDesiredTagMap,
  cloneTagMap,
  diffStates,
  makeOsmError,
  parseEditedFields,
  parseSyncSummary,
  parseTags,
  stableJson,
  stateFromContourTags,
  stateFromLocalRow,
  tagsFingerprint
} from './osm-sync.shared';
import { fetchOsmElement } from './osm-api-client';
import { buildChangesetTags, closeChangeset, createChangeset, updateOsmElement } from './osm-changeset-builder';
import { hasSearchIndexRelevantValues } from './search-index-fields';
import type { SyncCandidate, SyncCandidateSummary } from '$shared/types';

type CandidateResolverDeps = {
  db: any;
  getCredentials: () => Promise<LooseRecord>;
  enqueueSearchIndexRefresh?: (osmType: string, osmId: number) => void;
  refreshDesignRefSuggestionsCache?: (reason?: string) => Promise<any> | any;
  fetch?: typeof fetch;
};

function createOsmCandidateResolver(deps: CandidateResolverDeps) {
  const { db, getCredentials, enqueueSearchIndexRefresh } = deps;
  if (!db) throw new Error('createOsmCandidateResolver: db is required');
  if (typeof getCredentials !== 'function') throw new Error('createOsmCandidateResolver: getCredentials is required');

  async function readCandidateRows(osmType, osmId) {
    return await db.prepare(`
      SELECT
        ue.id,
        ue.osm_type,
        ue.osm_id,
        ue.created_by,
        ue.status,
        ue.edited_fields_json,
        ue.source_osm_version,
        ue.sync_status,
        ue.sync_attempted_at,
        ue.sync_succeeded_at,
        ue.sync_cleaned_at,
        ue.sync_changeset_id,
        ue.sync_summary_json,
        ue.sync_error_text,
        ue.source_tags_json,
        ue.source_osm_updated_at,
        ue.updated_at,
        ue.created_at,
        ai.name AS local_name,
        ai.style AS local_style,
        ai.design AS local_design,
        ai.design_ref AS local_design_ref,
        ai.design_year AS local_design_year,
        ai.material AS local_material,
        ai.material_concrete AS local_material_concrete,
        ai.colour AS local_colour,
        ai.levels AS local_levels,
        ai.year_built AS local_year_built,
        ai.architect AS local_architect,
        ai.address AS local_address,
        ai.description AS local_description,
        ai.archimap_description AS local_archimap_description,
        ai.updated_at AS local_updated_at,
        bc.tags_json AS contour_tags_json,
        bc.updated_at AS contour_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      WHERE ue.osm_type = ? AND ue.osm_id = ?
      ORDER BY ue.updated_at DESC, ue.id DESC
    `).all(osmType, osmId);
  }

  function buildCandidateRecord(rows: LooseRecord[]): SyncCandidateSummary {
    const latestRow: LooseRecord = rows[0] || {};
    const latestLocalState = stateFromLocalRow(latestRow);
    const contourState = stateFromContourTags(parseTags(latestRow?.contour_tags_json));
    const explicitFields = [...new Set(rows.flatMap((row) => parseEditedFields(row.edited_fields_json)))];
    const hasSyncingRow = rows.some((row) => String(row.sync_status || 'unsynced').trim().toLowerCase() === 'syncing');
    // Keep a newer accepted/partially accepted edit from being hidden by older synced history rows.
    const latestSyncStatus = hasSyncingRow
      ? 'syncing'
      : String(latestRow.sync_status || 'unsynced').trim().toLowerCase();
    const syncReadOnly = latestSyncStatus === 'synced' || latestSyncStatus === 'cleaned';
    const summary = parseSyncSummary(latestRow?.sync_summary_json);
    const changes = diffStates(contourState, latestLocalState);
    const hasSyncableEdits = rows.some((row) => ['accepted', 'partially_accepted'].includes(String(row.status || '')));
    return {
      osmType: latestRow.osm_type,
      osmId: Number(latestRow.osm_id || 0),
      totalEdits: rows.length,
      syncableEdits: rows.filter((row) => ['accepted', 'partially_accepted'].includes(String(row.status || ''))).length,
      latestEditId: Number(latestRow.id || 0),
      latestUpdatedAt: latestRow.updated_at || null,
      latestCreatedBy: latestRow.created_by || null,
      latestStatus: latestRow.status || null,
      latestLocalName: latestRow.local_name || null,
      latestLocalUpdatedAt: latestRow.local_updated_at || null,
      sourceOsmUpdatedAt: latestRow.source_osm_updated_at || null,
      sourceOsmVersion: latestRow.source_osm_version || null,
      syncStatus: latestSyncStatus,
      syncAttemptedAt: latestRow.sync_attempted_at || null,
      syncSucceededAt: latestRow.sync_succeeded_at || null,
      syncCleanedAt: latestRow.sync_cleaned_at || null,
      syncChangesetId: latestRow.sync_changeset_id || null,
      syncSummary: summary,
      syncErrorText: latestRow.sync_error_text || null,
      currentContourUpdatedAt: latestRow.contour_updated_at || null,
      localState: latestLocalState,
      contourState,
      changes,
      syncReadOnly,
      canSync: hasSyncableEdits && !syncReadOnly && latestSyncStatus !== 'syncing',
      hasLocalState: Object.values(latestLocalState).some((value) => value != null),
      explicitFields
    };
  }

  async function listSyncCandidates(limit = 200): Promise<SyncCandidateSummary[]> {
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = await db.prepare(`
      SELECT
        ue.id,
        ue.osm_type,
        ue.osm_id,
        ue.created_by,
        ue.status,
        ue.edited_fields_json,
        ue.source_osm_version,
        ue.sync_status,
        ue.sync_attempted_at,
        ue.sync_succeeded_at,
        ue.sync_cleaned_at,
        ue.sync_changeset_id,
        ue.sync_summary_json,
        ue.sync_error_text,
        ue.source_tags_json,
        ue.source_osm_updated_at,
        ue.updated_at,
        ue.created_at,
        ai.name AS local_name,
        ai.style AS local_style,
        ai.design AS local_design,
        ai.design_ref AS local_design_ref,
        ai.design_year AS local_design_year,
        ai.material AS local_material,
        ai.material_concrete AS local_material_concrete,
        ai.colour AS local_colour,
        ai.levels AS local_levels,
        ai.year_built AS local_year_built,
        ai.architect AS local_architect,
        ai.address AS local_address,
        ai.description AS local_description,
        ai.archimap_description AS local_archimap_description,
        ai.updated_at AS local_updated_at,
        bc.tags_json AS contour_tags_json,
        bc.updated_at AS contour_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      WHERE ue.status IN ('accepted', 'partially_accepted')
      ORDER BY ue.updated_at DESC, ue.id DESC
      LIMIT ?
    `).all(cap);

    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.osm_type}/${row.osm_id}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    return [...grouped.values()].map((group) => buildCandidateRecord(group));
  }

  async function getSyncCandidate(osmType, osmId): Promise<SyncCandidate | null> {
    const rows = await readCandidateRows(osmType, osmId);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const grouped = buildCandidateRecord(rows);
    const currentContour = parseTags(rows[0]?.contour_tags_json);
    let liveElement = null;
    let preflightError = null;

    try {
      const creds = await getCredentials();
      if (creds.accessToken) {
        liveElement = await fetchOsmElement(osmType, osmId, creds.accessToken, creds.apiBaseUrl);
      } else {
        preflightError = 'OSM access token is not connected';
      }
    } catch (error) {
      preflightError = String(error?.message || error);
    }

    const liveTagMap = liveElement ? Object.assign({}, liveElement.tags || {}) : {};
    const { desired, localState, explicitFields } = buildDesiredTagMap(liveTagMap, rows);
    const changedFields = diffStates(stateFromContourTags(liveTagMap), localState);
    const sourceFingerprint = tagsFingerprint(rows[0]?.source_tags_json || JSON.stringify(currentContour || {}));
    const liveFingerprint = liveElement ? JSON.stringify(stableJson(cloneTagMap(liveElement.tags || {}))) : null;
    const sourceMatches = liveFingerprint ? liveFingerprint === sourceFingerprint : false;

    return {
      ...grouped,
      currentContourUpdatedAt: rows[0]?.contour_updated_at || null,
      currentContourTags: currentContour,
      liveElement: liveElement ? {
        type: liveElement.type,
        attrs: liveElement.attrs,
        tags: liveElement.tags
      } : null,
      desiredTags: desired,
      localState,
      explicitFields,
      changedFields,
      sourceMatches,
      conflict: liveElement && !sourceMatches
        ? {
          type: 'upstream_drift',
          message: 'Live OSM state no longer matches the stored source snapshot',
          sourceFingerprint,
          liveFingerprint
        }
        : null,
      preflightError
    };
  }

  async function updateSyncRows(osmType, osmId, patch: LooseRecord, statuses = ['accepted', 'partially_accepted']) {
    const statusList = Array.isArray(statuses) && statuses.length > 0 ? statuses : ['accepted', 'partially_accepted'];
    const placeholders = statusList.map(() => '?').join(', ');
    await db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        sync_status = ?,
        sync_attempted_at = COALESCE(sync_attempted_at, datetime('now')),
        sync_succeeded_at = ?,
        sync_cleaned_at = ?,
        sync_changeset_id = ?,
        sync_summary_json = ?,
        sync_error_text = ?,
        updated_at = datetime('now')
      WHERE osm_type = ?
        AND osm_id = ?
        AND status IN (${placeholders})
    `).run(
      patch.syncStatus || null,
      patch.syncSucceededAt || null,
      patch.syncCleanedAt || null,
      patch.syncChangesetId || null,
      patch.syncSummaryJson || null,
      patch.syncErrorText || null,
      osmType,
      osmId,
      ...statusList
    );
  }

  async function prepareSyncCandidateSyncData(osmType, osmId, candidate: SyncCandidate | null = null) {
    const syncCandidate = candidate || await getSyncCandidate(osmType, osmId);
    if (!syncCandidate) {
      return null;
    }

    const rows = await readCandidateRows(osmType, osmId);
    const currentTags = syncCandidate.liveElement?.tags || {};
    const { desired, localState, removedKeys } = buildDesiredTagMap(currentTags, rows);
    const changedFields = diffStates(stateFromContourTags(currentTags), localState);
    const diffKeys = new Set(
      Object.keys(desired).filter((key) => String(currentTags[key] ?? '') !== String(desired[key] ?? ''))
    );
    for (const key of removedKeys) {
      if (currentTags[key] != null && String(currentTags[key]).trim() !== '') {
        diffKeys.add(key);
      }
    }

    return {
      candidate: syncCandidate,
      rows,
      currentTags,
      desiredTags: desired,
      localState,
      changedFields,
      diffKeys,
      summaryBase: {
        osmType,
        osmId,
        fieldCount: diffKeys.size,
        changedFields: [...diffKeys],
        sourceUpdatedAt: syncCandidate.sourceOsmUpdatedAt || null,
        sourceVersion: syncCandidate.sourceOsmVersion || null
      },
      noChange: diffKeys.size === 0
    };
  }

  async function syncCandidatesToOsm(targets, _actor = null) {
    const requestedTargets = Array.isArray(targets) ? targets : [targets];
    const normalizedTargets = [];
    const seen = new Set();
    for (const target of requestedTargets) {
      const osmType = String(target?.osmType || '').trim();
      const osmId = Number(target?.osmId);
      if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) continue;
      const key = `${osmType}/${osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedTargets.push({ osmType, osmId });
    }

    if (normalizedTargets.length === 0) {
      throw makeOsmError('No sync candidates were provided', {
        status: 400,
        code: 'OSM_SYNC_CANDIDATES_MISSING'
      });
    }

    const creds = await getCredentials();
    if (!creds.accessToken) {
      throw makeOsmError('OSM access token is not configured', {
        status: 503,
        code: 'OSM_SYNC_NOT_CONNECTED'
      });
    }

    const preparedItems = [];
    for (const target of normalizedTargets) {
      const candidate = await getSyncCandidate(target.osmType, target.osmId);
      if (!candidate) {
        const error = makeOsmError('Sync candidate was not found', {
          status: 404,
          code: 'OSM_SYNC_CANDIDATE_NOT_FOUND',
          details: target
        });
        throw error;
      }
      if (candidate.syncReadOnly) {
        throw makeOsmError('This building group has already been synchronized and is now read-only', {
          status: 409,
          code: 'OSM_SYNC_ALREADY_PUBLISHED',
          details: target
        });
      }
      if (candidate.syncStatus === 'syncing') {
        throw makeOsmError('This building group is currently being synchronized', {
          status: 409,
          code: 'OSM_SYNC_IN_PROGRESS',
          details: target
        });
      }
      if (!candidate.canSync) {
        throw makeOsmError('No accepted local edits are available for sync', {
          status: 409,
          code: 'OSM_SYNC_NO_ACCEPTED_EDITS',
          details: target
        });
      }
      if (!candidate.liveElement) {
        throw makeOsmError(candidate.preflightError || 'Unable to load the current OSM element', {
          status: 404,
          code: 'OSM_SYNC_SOURCE_MISSING',
          details: target
        });
      }
      if (!candidate.sourceMatches) {
        throw makeOsmError('OSM element changed since the source snapshot was captured', {
          status: 409,
          code: 'OSM_SYNC_SOURCE_DRIFT',
          details: candidate.conflict || null
        });
      }

      const prepared = await prepareSyncCandidateSyncData(target.osmType, target.osmId, candidate);
      if (!prepared) {
        throw makeOsmError('Sync candidate was not found', {
          status: 404,
          code: 'OSM_SYNC_CANDIDATE_NOT_FOUND',
          details: target
        });
      }
      preparedItems.push(prepared);
    }

    const noChangeItems = preparedItems.filter((item) => item.noChange);
    const actionableItems = preparedItems.filter((item) => !item.noChange);
    const noChangeResults = [];

    for (const item of noChangeItems) {
      const noChangeSummary = {
        ...item.summaryBase,
        syncedAt: new Date().toISOString(),
        noChange: true
      };
      await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
        syncStatus: 'synced',
        syncSucceededAt: noChangeSummary.syncedAt,
        syncCleanedAt: null,
        syncChangesetId: null,
        syncSummaryJson: JSON.stringify(noChangeSummary),
        syncErrorText: null
      });
      noChangeResults.push({
        osmType: item.summaryBase.osmType,
        osmId: item.summaryBase.osmId,
        noChange: true,
        summary: noChangeSummary
      });
    }

    const startedAt = new Date().toISOString();
    for (const item of actionableItems) {
      await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
        syncStatus: 'syncing',
        syncSucceededAt: null,
        syncCleanedAt: null,
        syncChangesetId: null,
        syncSummaryJson: JSON.stringify({
          ...item.summaryBase,
          localState: item.localState,
          changedFields: item.changedFields,
          startedAt
        }),
        syncErrorText: null
      });
    }

    if (actionableItems.length === 0) {
      return {
        ok: true,
        noChange: true,
        changesetId: null,
        items: noChangeResults,
        summary: {
          syncedAt: new Date().toISOString(),
          totalCount: preparedItems.length,
          noChangeCount: noChangeItems.length,
          syncedCount: 0,
          fieldCount: 0
        }
      };
    }

    const changesetTags = buildChangesetTags(actionableItems, _actor);
    const changesetId = await createChangeset(creds.accessToken, creds.apiBaseUrl, changesetTags);
    const syncedResults = [...noChangeResults];
    const syncedItemKeys = new Set();

    try {
      for (const item of actionableItems) {
        const syncedAt = new Date().toISOString();
        await updateOsmElement(creds.accessToken, creds.apiBaseUrl, item.candidate.liveElement, item.desiredTags, changesetId);
        syncedItemKeys.add(`${item.summaryBase.osmType}/${item.summaryBase.osmId}`);
        const summary = {
          ...item.summaryBase,
          changesetId,
          comment: changesetTags.comment || null,
          source: changesetTags.source || null,
          createdBy: changesetTags.created_by || null,
          batchSize: actionableItems.length,
          syncedAt
        };
        await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
          syncStatus: 'synced',
          syncSucceededAt: summary.syncedAt,
          syncCleanedAt: null,
          syncChangesetId: changesetId,
          syncSummaryJson: JSON.stringify(summary),
          syncErrorText: null
        });
        syncedResults.push({
          osmType: item.summaryBase.osmType,
          osmId: item.summaryBase.osmId,
          noChange: false,
          changesetId,
          summary
        });
      }
    } catch (error) {
      const failureAt = new Date().toISOString();
      for (const item of actionableItems) {
        const key = `${item.summaryBase.osmType}/${item.summaryBase.osmId}`;
        if (syncedItemKeys.has(key)) continue;
        const failure = {
          ...item.summaryBase,
          changesetId,
          comment: changesetTags.comment || null,
          source: changesetTags.source || null,
          createdBy: changesetTags.created_by || null,
          batchSize: actionableItems.length,
          failedAt: failureAt,
          error: String(error?.message || error)
        };
        await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
          syncStatus: 'failed',
          syncSucceededAt: null,
          syncCleanedAt: null,
          syncChangesetId: null,
          syncSummaryJson: JSON.stringify(failure),
          syncErrorText: failure.error
        });
      }
      throw error;
    } finally {
      try {
        await closeChangeset(creds.accessToken, creds.apiBaseUrl, changesetId);
      } catch {
        // keep the main sync result; a close failure is noisy but not fatal here
      }
    }

    return {
      ok: true,
      noChange: false,
      changesetId,
      items: syncedResults,
      summary: {
        syncedAt: new Date().toISOString(),
        totalCount: preparedItems.length,
        noChangeCount: noChangeItems.length,
        syncedCount: actionableItems.length,
        fieldCount: actionableItems.reduce((total, item) => total + Number(item.summaryBase?.fieldCount || 0), 0)
      }
    };
  }

  async function syncCandidateToOsm(osmType, osmId, _actor = null) {
    const result = await syncCandidatesToOsm([{ osmType, osmId }], _actor);
    const item = Array.isArray(result.items) ? result.items[0] : null;
    if (!item) {
      return {
        ok: true,
        noChange: true,
        summary: result.summary || null
      };
    }
    return item.noChange
      ? {
          ok: true,
          noChange: true,
          summary: item.summary
        }
      : {
          ok: true,
          noChange: false,
          changesetId: result.changesetId,
          summary: item.summary
        };
  }

  async function cleanupSyncedLocalOverwritesAfterImport() {
    const candidates = await listSyncCandidates(500);
    const cleaned = [];

    for (const candidate of candidates) {
      if (!candidate || !['synced', 'cleaned'].includes(String(candidate.syncStatus || ''))) {
        continue;
      }
      if (!candidate.hasLocalState) continue;

      const contourRow = await db.prepare(`
        SELECT tags_json, updated_at
        FROM osm.building_contours
        WHERE osm_type = ? AND osm_id = ?
        LIMIT 1
      `).get(candidate.osmType, candidate.osmId);
      if (!contourRow) continue;

      const contourState = stateFromContourTags(parseTags(contourRow.tags_json));
      const localState = candidate.localState;
      const syncedFields = Array.isArray(candidate.explicitFields) && candidate.explicitFields.length > 0
        ? candidate.explicitFields
        : Object.keys(localState).filter((field) => field in localState);
      const sameState = syncedFields.every((field) => {
        if (!Object.prototype.hasOwnProperty.call(localState, field)) {
          return true;
        }
        return String(contourState?.[field] ?? '') === String(localState?.[field] ?? '');
      });
      if (!sameState) continue;

      const tx = db.transaction(() => {
        db.prepare(`
          DELETE FROM local.architectural_info
          WHERE osm_type = ? AND osm_id = ?
        `).run(candidate.osmType, candidate.osmId);

        db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            sync_status = 'cleaned',
            sync_cleaned_at = datetime('now'),
            updated_at = datetime('now')
          WHERE osm_type = ?
            AND osm_id = ?
            AND status IN ('accepted', 'partially_accepted')
            AND sync_status IN ('synced', 'cleaned')
        `).run(candidate.osmType, candidate.osmId);
      });

      try {
        tx();
        cleaned.push({
          osmType: candidate.osmType,
          osmId: candidate.osmId
        });
        if (typeof enqueueSearchIndexRefresh === 'function' && hasSearchIndexRelevantValues(candidate.localState)) {
          enqueueSearchIndexRefresh(candidate.osmType, candidate.osmId);
        }
      } catch (error) {
        console.error('osm_sync_cleanup_failed', {
          osmType: candidate.osmType,
          osmId: candidate.osmId,
          error: String(error?.message || error)
        });
      }
    }

    return {
      ok: true,
      cleaned
    };
  }

  return {
    listSyncCandidates,
    getSyncCandidate,
    syncCandidatesToOsm,
    syncCandidateToOsm,
    cleanupSyncedLocalOverwritesAfterImport
  };
}

export { createOsmCandidateResolver };
