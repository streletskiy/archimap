import { parseOsmElementResponse } from '../src/lib/server/services/osm-sync.shared';

interface AuditFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface AuditOptions {
  apiBaseUrl?: string;
  fetchImpl?: (input: string, init?: LooseRecord) => Promise<AuditFetchResponse>;
}

interface RelationVersion {
  id: number;
  version: number;
  members: Array<{ type: string; ref: string; role: string }>;
}

const DEFAULT_API_BASE_URL = 'https://api.openstreetmap.org';
const AUDIT_USER_AGENT = 'archimap-relation-audit/1.0';

function relationStructureFingerprint(relation: RelationVersion) {
  return JSON.stringify(
    relation.members.map((member) => ({
      type: String(member.type || ''),
      ref: String(member.ref || ''),
      role: String(member.role || '')
    }))
  );
}

function parseRelationVersion(xml: string): RelationVersion {
  const parsed = parseOsmElementResponse(xml);
  if (parsed.type !== 'relation') {
    throw new Error(`Expected relation XML, received ${parsed.type || 'unknown element'}`);
  }
  const id = Number(parsed.attrs?.id);
  const version = Number(parsed.attrs?.version);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(version) || version <= 0) {
    throw new Error('Relation XML is missing a valid id or version');
  }
  return { id, version, members: parsed.members };
}

function extractModifiedRelations(osmChangeXml: string) {
  const relations: RelationVersion[] = [];
  for (const modifyMatch of String(osmChangeXml || '').matchAll(/<modify\b[^>]*>([\s\S]*?)<\/modify>/gi)) {
    const body = String(modifyMatch[1] || '');
    for (const relationMatch of body.matchAll(/<relation\b[\s\S]*?<\/relation>/gi)) {
      relations.push(parseRelationVersion(relationMatch[0]));
    }
  }
  return relations;
}

async function fetchXml(url: URL, fetchImpl: AuditOptions['fetchImpl']) {
  const response = await fetchImpl(String(url), {
    headers: {
      Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
      'User-Agent': AUDIT_USER_AGENT
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OSM API ${response.status} for ${url.pathname}: ${body.slice(0, 200)}`);
  }
  return body;
}

async function auditChangesetRelations(changesetId: number, options: AuditOptions = {}) {
  if (!Number.isInteger(changesetId) || changesetId <= 0) {
    throw new Error(`Invalid changeset id: ${changesetId}`);
  }
  const apiBaseUrl = new URL(options.apiBaseUrl || DEFAULT_API_BASE_URL);
  const fetchImpl = options.fetchImpl || (global.fetch as AuditOptions['fetchImpl']);
  if (!fetchImpl) throw new Error('A fetch implementation is required');

  const changeXml = await fetchXml(
    new URL(`/api/0.6/changeset/${encodeURIComponent(changesetId)}/download`, apiBaseUrl),
    fetchImpl
  );
  const modifiedRelations = extractModifiedRelations(changeXml);
  const results = [];
  for (const after of modifiedRelations) {
    if (after.version <= 1) continue;
    const beforeXml = await fetchXml(
      new URL(`/api/0.6/relation/${encodeURIComponent(after.id)}/${encodeURIComponent(after.version - 1)}`, apiBaseUrl),
      fetchImpl
    );
    const before = parseRelationVersion(beforeXml);
    results.push({
      changesetId,
      relationId: after.id,
      beforeVersion: before.version,
      afterVersion: after.version,
      beforeMemberCount: before.members.length,
      afterMemberCount: after.members.length,
      structureChanged: relationStructureFingerprint(before) !== relationStructureFingerprint(after),
      membersRemoved: before.members.filter(
        (member) =>
          !after.members.some(
            (candidate) =>
              candidate.type === member.type && candidate.ref === member.ref && candidate.role === member.role
          )
      )
    });
  }
  return results;
}

function parseCliArgs(args: string[]) {
  const json = args.includes('--json');
  const ids = args
    .filter((arg) => arg !== '--json')
    .flatMap((arg) => arg.split(','))
    .map((arg) => Number(arg.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    throw new Error('Usage: npm run osm:audit-relations -- <changeset-id> [changeset-id ...] [--json]');
  }
  return { ids: [...new Set(ids)], json };
}

async function main() {
  const { ids, json } = parseCliArgs(process.argv.slice(2));
  const results = [];
  for (const id of ids) results.push(...(await auditChangesetRelations(id)));

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (results.length === 0) {
    console.log('No modified relations found.');
  } else {
    console.table(
      results.map((result) => ({
        changeset: result.changesetId,
        relation: result.relationId,
        before: result.beforeMemberCount,
        after: result.afterMemberCount,
        changed: result.structureChanged
      }))
    );
  }

  if (results.some((result) => result.structureChanged)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

export {
  auditChangesetRelations,
  extractModifiedRelations,
  parseCliArgs,
  parseRelationVersion,
  relationStructureFingerprint
};
