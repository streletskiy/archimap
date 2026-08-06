const { fetchOsmElement, fetchOsmElementVersion } = require('./osm-api-client');
const { closeChangeset, createChangeset, deleteOsmElement, updateOsmElement } = require('./osm-changeset-builder');
const { makeOsmError } = require('./osm-sync.shared');

const MAX_REPAIR_ITEMS = 20;
const MAX_MIGRATED_TAGS = 20;
const MIGRATABLE_ARCHITECTURAL_TAGS = new Set([
  'architect',
  'building:architecture',
  'building:colour',
  'building:material',
  'design',
  'design:ref',
  'design:year',
  'roof:shape',
  'start_date'
]);

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw makeOsmError(`${label} must be a positive integer`, {
      status: 400,
      code: 'OSM_REPAIR_INVALID_INPUT'
    });
  }
  return normalized;
}

function currentVersion(element) {
  return positiveInteger(element?.attrs?.version, 'OSM element version');
}

function currentId(element) {
  return positiveInteger(element?.attrs?.id, 'OSM element id');
}

function assertExpectedElement(element, type, id, expectedVersion) {
  if (element?.type !== type || currentId(element) !== id) {
    throw makeOsmError(`OSM ${type}/${id} returned an unexpected element`, {
      status: 409,
      code: 'OSM_REPAIR_SOURCE_MISMATCH'
    });
  }
  if (String(element?.attrs?.visible || 'true') === 'false') {
    throw makeOsmError(`OSM ${type}/${id} is deleted`, {
      status: 409,
      code: 'OSM_REPAIR_ELEMENT_DELETED'
    });
  }
  if (currentVersion(element) !== expectedVersion) {
    throw makeOsmError(`OSM ${type}/${id} changed since the repair was prepared`, {
      status: 409,
      code: 'OSM_REPAIR_VERSION_DRIFT',
      details: { osmType: type, osmId: id, expectedVersion, actualVersion: currentVersion(element) }
    });
  }
}

function assertEmptyRelation(relation, relationId) {
  if (relation?.type !== 'relation' || !Array.isArray(relation?.members)) {
    throw makeOsmError(`OSM relation/${relationId} is malformed`, {
      status: 409,
      code: 'OSM_REPAIR_SOURCE_MISMATCH'
    });
  }
  if (relation.members.length !== 0) {
    throw makeOsmError(`OSM relation/${relationId} is no longer empty`, {
      status: 409,
      code: 'OSM_REPAIR_RELATION_NOT_EMPTY'
    });
  }
}

function normalizeTagKeys(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MIGRATED_TAGS) {
    throw makeOsmError(`tagKeys must contain between 1 and ${MAX_MIGRATED_TAGS} entries`, {
      status: 400,
      code: 'OSM_REPAIR_INVALID_INPUT'
    });
  }
  const keys = value.map((key) => String(key || '').trim());
  if (
    keys.some((key) => !MIGRATABLE_ARCHITECTURAL_TAGS.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw makeOsmError('tagKeys must contain unique, supported architectural OSM tag keys', {
      status: 400,
      code: 'OSM_REPAIR_INVALID_INPUT'
    });
  }
  return keys;
}

function memberKey(member) {
  return `${String(member?.type || '').trim().toLowerCase()}/${positiveInteger(member?.ref, 'Relation member id')}`;
}

function normalizeMemberVersions(value, sourceMembers) {
  if (!Array.isArray(value) || value.length !== sourceMembers.length) {
    throw makeOsmError('memberVersions must cover every source relation member', {
      status: 400,
      code: 'OSM_REPAIR_INVALID_INPUT'
    });
  }
  const versions = new Map();
  for (const item of value) {
    const type = String(item?.type || '').trim().toLowerCase();
    if (type !== 'way') {
      throw makeOsmError('Only way members can be migrated to a replacement way', {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
    const ref = positiveInteger(item?.ref, 'Relation member id');
    const version = positiveInteger(item?.version, 'Relation member version');
    const key = `${type}/${ref}`;
    if (versions.has(key)) {
      throw makeOsmError(`Duplicate member version for ${key}`, {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
    versions.set(key, version);
  }
  for (const member of sourceMembers) {
    if (!versions.has(memberKey(member))) {
      throw makeOsmError(`Missing historical version for ${memberKey(member)}`, {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
  }
  return versions;
}

function edgeKey(left, right) {
  const a = positiveInteger(left, 'Way node reference');
  const b = positiveInteger(right, 'Way node reference');
  return a < b ? `${a}/${b}` : `${b}/${a}`;
}

function geometryFingerprint(ways) {
  const edges = [];
  for (const way of ways) {
    if (way?.type !== 'way' || !Array.isArray(way?.nodeRefs) || way.nodeRefs.length < 2) {
      throw makeOsmError('Historical relation member has invalid way geometry', {
        status: 409,
        code: 'OSM_REPAIR_GEOMETRY_MISMATCH'
      });
    }
    for (let index = 1; index < way.nodeRefs.length; index += 1) {
      edges.push(edgeKey(way.nodeRefs[index - 1], way.nodeRefs[index]));
    }
  }
  return edges.sort().join('|');
}

function normalizeRepairItems(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  if (items.length === 0 || items.length > MAX_REPAIR_ITEMS) {
    throw makeOsmError(`items must contain between 1 and ${MAX_REPAIR_ITEMS} repairs`, {
      status: 400,
      code: 'OSM_REPAIR_INVALID_INPUT'
    });
  }
  const relationIds = new Set();
  return items.map((item) => {
    const action = String(item?.action || '').trim();
    if (!['restore_members', 'migrate_relation_to_way'].includes(action)) {
      throw makeOsmError(`Unsupported OSM repair action: ${action || '(empty)'}`, {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
    const relationId = positiveInteger(item?.relationId, 'relationId');
    if (relationIds.has(relationId)) {
      throw makeOsmError(`Duplicate repair for relation/${relationId}`, {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
    relationIds.add(relationId);
    const expectedVersion = positiveInteger(item?.expectedVersion, 'expectedVersion');
    const sourceVersion = positiveInteger(item?.sourceVersion, 'sourceVersion');
    if (sourceVersion >= expectedVersion) {
      throw makeOsmError('sourceVersion must be older than expectedVersion', {
        status: 400,
        code: 'OSM_REPAIR_INVALID_INPUT'
      });
    }
    const normalized: LooseRecord = {
      action,
      relationId,
      expectedVersion,
      sourceVersion
    };
    if (action === 'migrate_relation_to_way') {
      normalized.wayId = positiveInteger(item?.wayId, 'wayId');
      normalized.expectedWayVersion = positiveInteger(item?.expectedWayVersion, 'expectedWayVersion');
      normalized.tagKeys = normalizeTagKeys(item?.tagKeys);
      normalized.memberVersions = item?.memberVersions;
    }
    return normalized;
  });
}

function createOsmRepairService({ getCredentials }) {
  if (typeof getCredentials !== 'function') {
    throw new Error('createOsmRepairService: getCredentials is required');
  }

  async function prepareRestore(item, creds) {
    const current = await fetchOsmElement('relation', item.relationId, creds.accessToken, creds.apiBaseUrl);
    assertExpectedElement(current, 'relation', item.relationId, item.expectedVersion);
    assertEmptyRelation(current, item.relationId);

    const source = await fetchOsmElementVersion(
      'relation',
      item.relationId,
      item.sourceVersion,
      creds.accessToken,
      creds.apiBaseUrl
    );
    assertExpectedElement(source, 'relation', item.relationId, item.sourceVersion);
    if (!Array.isArray(source.members) || source.members.length === 0) {
      throw makeOsmError(`Historical relation/${item.relationId}/${item.sourceVersion} has no members`, {
        status: 409,
        code: 'OSM_REPAIR_HISTORY_EMPTY'
      });
    }

    for (const member of source.members) {
      const type = String(member?.type || '').trim().toLowerCase();
      if (!['node', 'way', 'relation'].includes(type)) {
        throw makeOsmError(`Historical relation/${item.relationId} has an invalid member type`, {
          status: 409,
          code: 'OSM_REPAIR_SOURCE_MISMATCH'
        });
      }
      const ref = positiveInteger(member?.ref, 'Relation member id');
      const liveMember = await fetchOsmElement(type, ref, creds.accessToken, creds.apiBaseUrl);
      if (liveMember?.type !== type || currentId(liveMember) !== ref) {
        throw makeOsmError(`OSM ${type}/${ref} returned an unexpected element`, {
          status: 409,
          code: 'OSM_REPAIR_SOURCE_MISMATCH'
        });
      }
      if (String(liveMember?.attrs?.visible || 'true') === 'false') {
        throw makeOsmError(`OSM ${type}/${ref} is deleted`, {
          status: 409,
          code: 'OSM_REPAIR_MEMBER_DELETED'
        });
      }
    }

    return { ...item, current, source };
  }

  async function prepareMigration(item, creds) {
    const current = await fetchOsmElement('relation', item.relationId, creds.accessToken, creds.apiBaseUrl);
    assertExpectedElement(current, 'relation', item.relationId, item.expectedVersion);
    assertEmptyRelation(current, item.relationId);

    const source = await fetchOsmElementVersion(
      'relation',
      item.relationId,
      item.sourceVersion,
      creds.accessToken,
      creds.apiBaseUrl
    );
    assertExpectedElement(source, 'relation', item.relationId, item.sourceVersion);
    if (
      !Array.isArray(source.members) ||
      source.members.length === 0 ||
      source.members.some((member) => member.type !== 'way' || String(member.role || '') !== 'outer')
    ) {
      throw makeOsmError('Only an outer-way-only historical multipolygon can be migrated to a way', {
        status: 409,
        code: 'OSM_REPAIR_SOURCE_MISMATCH'
      });
    }

    const replacement = await fetchOsmElement('way', item.wayId, creds.accessToken, creds.apiBaseUrl);
    assertExpectedElement(replacement, 'way', item.wayId, item.expectedWayVersion);
    if (
      !Array.isArray(replacement.nodeRefs) ||
      replacement.nodeRefs.length < 4 ||
      replacement.nodeRefs[0] !== replacement.nodeRefs[replacement.nodeRefs.length - 1]
    ) {
      throw makeOsmError(`Replacement way/${item.wayId} is not a closed area`, {
        status: 409,
        code: 'OSM_REPAIR_GEOMETRY_MISMATCH'
      });
    }

    const memberVersions = normalizeMemberVersions(item.memberVersions, source.members);
    const historicalWays = [];
    for (const member of source.members) {
      const version = memberVersions.get(memberKey(member));
      const way = await fetchOsmElementVersion(
        'way',
        positiveInteger(member.ref, 'Relation member id'),
        version,
        creds.accessToken,
        creds.apiBaseUrl
      );
      assertExpectedElement(way, 'way', positiveInteger(member.ref, 'Relation member id'), version);
      historicalWays.push(way);
    }
    if (geometryFingerprint(historicalWays) !== geometryFingerprint([replacement])) {
      throw makeOsmError(`Replacement way/${item.wayId} does not match the historical relation geometry`, {
        status: 409,
        code: 'OSM_REPAIR_GEOMETRY_MISMATCH'
      });
    }

    const desiredTags = { ...(replacement.tags || {}) };
    for (const key of item.tagKeys) {
      const sourceValue = current.tags?.[key];
      if (sourceValue == null || String(sourceValue) === '') {
        throw makeOsmError(`Relation/${item.relationId} does not have tag ${key}`, {
          status: 409,
          code: 'OSM_REPAIR_TAG_MISSING'
        });
      }
      const targetValue = desiredTags[key];
      if (targetValue != null && String(targetValue) !== String(sourceValue)) {
        throw makeOsmError(`Way/${item.wayId} has a conflicting ${key} tag`, {
          status: 409,
          code: 'OSM_REPAIR_TAG_CONFLICT'
        });
      }
      desiredTags[key] = String(sourceValue);
    }

    return { ...item, current, source, replacement, desiredTags };
  }

  async function repairDamagedRelations(input, _actor = null) {
    const items = normalizeRepairItems(input);
    const creds = await getCredentials();
    if (!creds.accessToken) {
      throw makeOsmError('OSM access token is not configured', {
        status: 503,
        code: 'OSM_SYNC_NOT_CONNECTED'
      });
    }

    const prepared = [];
    for (const item of items) {
      prepared.push(
        item.action === 'restore_members' ? await prepareRestore(item, creds) : await prepareMigration(item, creds)
      );
    }

    const plannedItems = prepared.map((item) =>
      item.action === 'restore_members'
        ? {
            action: item.action,
            relationId: item.relationId,
            expectedVersion: item.expectedVersion,
            sourceVersion: item.sourceVersion,
            memberCount: item.source.members.length
          }
        : {
            action: item.action,
            relationId: item.relationId,
            expectedVersion: item.expectedVersion,
            sourceVersion: item.sourceVersion,
            wayId: item.wayId,
            expectedWayVersion: item.expectedWayVersion,
            migratedTagKeys: item.tagKeys,
            historicalMemberCount: item.source.members.length,
            replacementNodeCount: item.replacement.nodeRefs.length
          }
    );
    if (input?.dryRun === true) {
      return { ok: true, dryRun: true, changesetId: null, items: plannedItems };
    }

    const changesetId = await createChangeset(creds.accessToken, creds.apiBaseUrl, {
      comment: 'Repair building geometries damaged by ArchiMap tag sync',
      source: 'OpenStreetMap history',
      created_by: 'ArchiMap OSM repair',
      generated_by: 'archimap'
    });
    const results = [];
    try {
      for (const item of prepared) {
        if (item.action === 'restore_members') {
          const restored = { ...item.current, members: item.source.members };
          const nextVersion = await updateOsmElement(
            creds.accessToken,
            creds.apiBaseUrl,
            restored,
            item.current.tags || {},
            changesetId
          );
          results.push({
            action: item.action,
            relationId: item.relationId,
            memberCount: item.source.members.length,
            version: positiveInteger(String(nextVersion || '').trim(), 'Updated relation version')
          });
          continue;
        }

        const nextWayVersion = await updateOsmElement(
          creds.accessToken,
          creds.apiBaseUrl,
          item.replacement,
          item.desiredTags,
          changesetId
        );
        await deleteOsmElement(creds.accessToken, creds.apiBaseUrl, item.current, changesetId);
        results.push({
          action: item.action,
          relationId: item.relationId,
          wayId: item.wayId,
          migratedTagKeys: item.tagKeys,
          wayVersion: positiveInteger(String(nextWayVersion || '').trim(), 'Updated way version'),
          relationDeleted: true
        });
      }
    } finally {
      try {
        await closeChangeset(creds.accessToken, creds.apiBaseUrl, changesetId);
      } catch {
        // Preserve the primary result. Open changesets close automatically if this request fails.
      }
    }

    return { ok: true, changesetId, items: results };
  }

  return { repairDamagedRelations };
}

module.exports = {
  createOsmRepairService,
  geometryFingerprint,
  normalizeRepairItems
};
