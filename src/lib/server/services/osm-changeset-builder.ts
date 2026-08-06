import {
  DEFAULT_CHANGESET_CREATED_BY,
  DEFAULT_CHANGESET_SOURCE,
  attrsToString,
  escapeXml,
  normalizeText,
  parseOsmElementResponse
} from './osm-sync.shared';
import { fetchText } from './osm-api-client';

const OSM_ELEMENT_TYPES = new Set(['node', 'way', 'relation']);

function normalizeElementType(value) {
  const type = String(value || '')
    .trim()
    .toLowerCase();
  if (!OSM_ELEMENT_TYPES.has(type)) {
    throw new Error(`Unsupported OSM element type: ${type || '(empty)'}`);
  }
  return type;
}

function normalizeElementRef(value, label) {
  const ref = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(ref)) {
    throw new Error(`Invalid ${label}: ${ref || '(empty)'}`);
  }
  return ref;
}

function normalizeElementStructure(element) {
  const type = normalizeElementType(element?.type);
  if (type === 'way') {
    if (!Array.isArray(element?.nodeRefs)) {
      throw new Error('Refusing to update OSM way without its node references');
    }
    return {
      type,
      nodeRefs: element.nodeRefs.map((ref, index) => normalizeElementRef(ref, `way node reference at index ${index}`)),
      members: []
    };
  }
  if (type === 'relation') {
    if (!Array.isArray(element?.members)) {
      throw new Error('Refusing to update OSM relation without its members');
    }
    return {
      type,
      nodeRefs: [],
      members: element.members.map((member, index) => {
        const memberType = normalizeElementType(member?.type);
        return {
          type: memberType,
          ref: normalizeElementRef(member?.ref, `relation member reference at index ${index}`),
          role: String(member?.role || '')
        };
      })
    };
  }
  return { type, nodeRefs: [], members: [] };
}

function buildElementStructureLines(element) {
  const structure = normalizeElementStructure(element);
  if (structure.type === 'way') {
    return structure.nodeRefs.map((ref) => `  <nd ref="${escapeXml(ref)}"/>`);
  }
  if (structure.type === 'relation') {
    return structure.members.map(
      (member) =>
        `  <member type="${escapeXml(member.type)}" ref="${escapeXml(member.ref)}" role="${escapeXml(member.role)}"/>`
    );
  }
  return [];
}

function buildElementXml(element, tags) {
  const type = normalizeElementType(element?.type);
  const header = attrsToString(element.attrs || {});
  const open = `<${type}${header ? ` ${header}` : ''}>`;
  const structureLines = buildElementStructureLines({ ...element, type });
  const tagLines = Object.keys(tags || {})
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
    .map((key) => `  <tag k="${escapeXml(key)}" v="${escapeXml(tags[key])}"/>`);
  const elementXml = [open, ...structureLines, ...tagLines, `</${type}>`]
    .filter((line) => String(line || '').length > 0)
    .join('\n');
  return ['<osm version="0.6">', elementXml, '</osm>'].join('\n');
}

function assertElementStructurePreserved(sourceElement, outboundXml) {
  const source = normalizeElementStructure(sourceElement);
  const outbound = normalizeElementStructure(parseOsmElementResponse(outboundXml));
  if (JSON.stringify(source) !== JSON.stringify(outbound)) {
    throw new Error(`Refusing to update OSM ${source.type}: structural children changed during serialization`);
  }
}

function buildChangesetComment(syncItems = []) {
  const items = Array.isArray(syncItems) ? syncItems.filter(Boolean) : [syncItems].filter(Boolean);
  if (items.length === 0) {
    return 'Update architectural info: OSM sync';
  }

  const fieldCount = items.reduce(
    (total, item) => total + Number(item?.fieldCount ?? item?.summaryBase?.fieldCount ?? item?.diffKeys?.size ?? 0),
    0
  );
  const labels = items
    .slice(0, 3)
    .map((item) => {
      const candidate = item?.candidate || {};
      const label =
        candidate?.latestLocalName ||
        item?.localState?.name ||
        (candidate?.osmType && candidate?.osmId ? `${candidate.osmType}/${candidate.osmId}` : null);
      return normalizeText(label, 64);
    })
    .filter(Boolean);

  let subject;
  if (items.length === 1) {
    const candidate = items[0]?.candidate || {};
    subject =
      labels[0] ||
      (candidate?.osmType && candidate?.osmId ? `${candidate.osmType}/${candidate.osmId}` : null) ||
      'OSM building';
  } else {
    subject = `${items.length} buildings`;
    if (labels.length > 0) {
      subject += `: ${labels.join(', ')}${items.length > labels.length ? ` +${items.length - labels.length} more` : ''}`;
    }
  }

  return (
    normalizeText(
      `Update architectural info: ${subject} (${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'})`,
      255
    ) || 'Update architectural info: OSM sync'
  );
}

function buildChangesetTags(syncItems = [], _actor = null) {
  const items = Array.isArray(syncItems) ? syncItems.filter(Boolean) : [syncItems].filter(Boolean);
  const generalAppName = 'archimap';
  const source = normalizeText(DEFAULT_CHANGESET_SOURCE, 255) || DEFAULT_CHANGESET_SOURCE;
  const createdBy = normalizeText(DEFAULT_CHANGESET_CREATED_BY, 255) || DEFAULT_CHANGESET_CREATED_BY;
  const comment = buildChangesetComment(items);
  const sourceLabel =
    items.length === 1
      ? items[0]?.candidate?.latestLocalName ||
        items[0]?.localState?.name ||
        (items[0]?.candidate?.osmType && items[0]?.candidate?.osmId
          ? `${items[0].candidate.osmType}/${items[0].candidate.osmId}`
          : null)
      : `${items.length} buildings`;
  const tags = {
    comment,
    source: sourceLabel ? `${source} · ${sourceLabel}` : source,
    created_by: createdBy,
    generated_by: generalAppName
  };
  return Object.fromEntries(Object.entries(tags).filter(([, value]) => value != null && String(value).trim() !== ''));
}

async function createChangeset(accessToken, apiBaseUrl, tags) {
  const xml = [
    '<osm>',
    '  <changeset>',
    ...Object.keys(tags).map((key) => `    <tag k="${escapeXml(key)}" v="${escapeXml(tags[key])}"/>`),
    '  </changeset>',
    '</osm>'
  ].join('\n');
  const response = await fetchText(new URL('/api/0.6/changeset/create', apiBaseUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'text/xml; charset=utf-8',
      Accept: 'text/plain, */*;q=0.1'
    },
    body: xml
  });
  const changesetId = Number(String(response || '').trim());
  if (!Number.isInteger(changesetId) || changesetId <= 0) {
    throw new Error('OSM changeset create returned an invalid id');
  }
  return changesetId;
}

async function closeChangeset(accessToken, apiBaseUrl, changesetId) {
  await fetchText(new URL(`/api/0.6/changeset/${encodeURIComponent(changesetId)}/close`, apiBaseUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'text/plain, */*;q=0.1'
    }
  });
}

function sanitizeElementAttrs(attrs: LooseRecord, elementType, changesetId) {
  const allowedKeys = new Set(['id', 'version', 'changeset', 'visible']);
  if (
    String(elementType || '')
      .trim()
      .toLowerCase() === 'node'
  ) {
    allowedKeys.add('lat');
    allowedKeys.add('lon');
  }
  const sanitized: LooseRecord = {};
  for (const key of allowedKeys) {
    if (attrs?.[key] != null) {
      sanitized[key] = String(attrs[key]);
    }
  }
  sanitized.id = String(attrs?.id || '');
  sanitized.version = String(attrs?.version || '');
  sanitized.changeset = String(changesetId);
  return sanitized;
}

async function updateOsmElement(accessToken, apiBaseUrl, currentElement, desiredTags, changesetId) {
  const elementAttrs: LooseRecord = currentElement.attrs || {};
  const attrs = sanitizeElementAttrs(elementAttrs, currentElement.type, changesetId);
  const bodyXml = buildElementXml(
    {
      type: currentElement.type,
      attrs,
      nodeRefs: currentElement.nodeRefs,
      members: currentElement.members
    },
    desiredTags
  );
  assertElementStructurePreserved(currentElement, bodyXml);
  return fetchText(
    new URL(`/api/0.6/${encodeURIComponent(currentElement.type)}/${encodeURIComponent(elementAttrs.id)}`, apiBaseUrl),
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'text/plain, */*;q=0.1'
      },
      body: bodyXml
    }
  );
}

async function deleteOsmElement(accessToken, apiBaseUrl, currentElement, changesetId) {
  const elementAttrs: LooseRecord = currentElement.attrs || {};
  const attrs = sanitizeElementAttrs(elementAttrs, currentElement.type, changesetId);
  const bodyXml = buildElementXml(
    {
      type: currentElement.type,
      attrs,
      nodeRefs: currentElement.nodeRefs,
      members: currentElement.members
    },
    currentElement.tags || {}
  );
  assertElementStructurePreserved(currentElement, bodyXml);
  return fetchText(
    new URL(`/api/0.6/${encodeURIComponent(currentElement.type)}/${encodeURIComponent(elementAttrs.id)}`, apiBaseUrl),
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'text/plain, */*;q=0.1'
      },
      body: bodyXml
    }
  );
}

export {
  buildElementXml,
  normalizeElementStructure,
  assertElementStructurePreserved,
  buildChangesetComment,
  buildChangesetTags,
  createChangeset,
  closeChangeset,
  sanitizeElementAttrs,
  updateOsmElement,
  deleteOsmElement
};
