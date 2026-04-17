/*
 * Wraps the `osmium derive-changes` CLI and parses the resulting OsmChange XML
 * into typed id sets so the incremental region sync can decide which buildings
 * need re-import.
 *
 * We intentionally shell out to `osmium` rather than link against libosmium —
 * the importer image already carries osmium-tool, and the OSC XML schema is
 * narrow enough that a streaming regex parser is both faster and cheaper than
 * pulling in an XML dep.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

type ChangeAction = 'create' | 'modify' | 'delete';
type OsmType = 'node' | 'way' | 'relation';

type ChangedObject = {
  osmType: OsmType;
  osmId: number;
  action: ChangeAction;
  version: number | null;
  tags: Record<string, string>;
  // Populated for nodes only. For `modify`/`create` these reflect the new
  // position; for `delete` they are null (OSC deletes don't carry geometry).
  lat: number | null;
  lon: number | null;
  // Populated for ways only — ordered list of node refs, used for downstream
  // node->way impact analysis if ever needed.
  nodeRefs: number[] | null;
};

type ChangesetSummary = {
  nodes: ChangedObject[];
  ways: ChangedObject[];
  relations: ChangedObject[];
};

const BUILDING_TAG_KEYS = new Set(['building', 'building:part']);

function looksLikeBuilding(tags: Record<string, string>): boolean {
  if (!tags) return false;
  for (const key of Object.keys(tags)) {
    if (BUILDING_TAG_KEYS.has(key.toLowerCase())) {
      const value = String(tags[key] || '').trim().toLowerCase();
      if (!value || value === 'no' || value === 'false') continue;
      return true;
    }
  }
  return false;
}

async function runDeriveChanges(options: {
  prevPbf: string;
  newPbf: string;
  outOscPath: string;
  osmiumBin?: string;
  keepDeletedDetails?: boolean;
}): Promise<void> {
  const bin = options.osmiumBin || 'osmium';
  const args = ['derive-changes'];
  if (options.keepDeletedDetails !== false) {
    args.push('--keep-details');
  }
  args.push('-f', 'osc', '-o', options.outOscPath, '--overwrite', options.prevPbf, options.newPbf);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`osmium derive-changes exited with code ${code}: ${stderrBuf.trim()}`));
      }
    });
  });
}

/**
 * Streaming parser for the OSC XML produced by `osmium derive-changes`. We
 * intentionally do not use a full XML parser: the format is emitted by osmium
 * itself and always follows the same shape (one attribute per line inside
 * element bodies for ways/relations, one-line self-closing tags for nodes
 * and for tag/nd/member children). A tiny state machine is enough and keeps
 * the module dependency-free.
 */
async function parseChangeset(oscPath: string): Promise<ChangesetSummary> {
  const summary: ChangesetSummary = { nodes: [], ways: [], relations: [] };
  if (!fs.existsSync(oscPath)) {
    return summary;
  }

  let currentAction: ChangeAction | null = null;
  let currentObject: ChangedObject | null = null;
  let currentContainer: OsmType | null = null;

  const input = fs.createReadStream(oscPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const commit = () => {
    if (!currentObject || !currentContainer) return;
    if (currentContainer === 'node') summary.nodes.push(currentObject);
    else if (currentContainer === 'way') summary.ways.push(currentObject);
    else if (currentContainer === 'relation') summary.relations.push(currentObject);
    currentObject = null;
    currentContainer = null;
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('<create')) {
      currentAction = 'create';
      continue;
    }
    if (line.startsWith('<modify')) {
      currentAction = 'modify';
      continue;
    }
    if (line.startsWith('<delete')) {
      currentAction = 'delete';
      continue;
    }
    if (line.startsWith('</create') || line.startsWith('</modify') || line.startsWith('</delete')) {
      currentAction = null;
      continue;
    }
    if (line.startsWith('<osmChange') || line.startsWith('</osmChange') || line.startsWith('<?xml')) {
      continue;
    }

    if (!currentAction) {
      continue;
    }

    // Element open/close for node/way/relation.
    const elementMatch = line.match(/^<(node|way|relation)\s([^>]*?)(\/)?>$/);
    if (elementMatch) {
      const elementType = elementMatch[1] as OsmType;
      const attrs = parseAttrs(elementMatch[2]);
      const selfClosing = Boolean(elementMatch[3]);
      const obj: ChangedObject = {
        osmType: elementType,
        osmId: Number(attrs.id),
        action: currentAction,
        version: attrs.version ? Number(attrs.version) : null,
        tags: {},
        lat: attrs.lat != null ? Number(attrs.lat) : null,
        lon: attrs.lon != null ? Number(attrs.lon) : null,
        nodeRefs: elementType === 'way' ? [] : null
      };
      if (selfClosing) {
        // Inline object with no children — push immediately.
        summary[`${elementType}s` as keyof ChangesetSummary].push(obj);
        continue;
      }
      currentObject = obj;
      currentContainer = elementType;
      continue;
    }

    if (!currentObject) {
      continue;
    }

    // Closing tag for the current object.
    if (
      line.startsWith('</node') ||
      line.startsWith('</way') ||
      line.startsWith('</relation')
    ) {
      commit();
      continue;
    }

    const tagMatch = line.match(/^<tag\s+([^/>]*)\/?>$/);
    if (tagMatch) {
      const attrs = parseAttrs(tagMatch[1]);
      if (attrs.k != null) {
        currentObject.tags[String(attrs.k)] = String(attrs.v ?? '');
      }
      continue;
    }

    const ndMatch = line.match(/^<nd\s+ref="(\d+)"\s*\/?>$/);
    if (ndMatch && currentObject.nodeRefs) {
      currentObject.nodeRefs.push(Number(ndMatch[1]));
      continue;
    }

    // <member .../> elements are ignored — we only need the relation id/tags
    // to decide if it's building-like. Member expansion is Phase 2b's job.
  }

  return summary;
}

const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)="([^"]*)"/g;

function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(input)) !== null) {
    out[match[1]] = decodeXmlEntities(match[2]);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Given a parsed changeset, partition changed ways/relations into those that
 * are building-relevant based on their OSC-embedded tags. Returns feature ids
 * in the same `way/123` / `relation/456` form used by the Python importer.
 *
 * Nodes are returned separately — spatial lookup against the previous NDJSON
 * is required to translate node moves into affected building ids. That lives
 * in the `spatial-expansion` module so we can unit-test it independently.
 */
function selectBuildingChanges(summary: ChangesetSummary): {
  directlyAffected: Set<string>;
  deletedBuildingFeatureIds: Set<string>;
  changedNodes: ChangedObject[];
  touchedNodeIds: Set<number>;
} {
  const directlyAffected = new Set<string>();
  const deletedBuildingFeatureIds = new Set<string>();
  const touchedNodeIds = new Set<number>();

  const markBuilding = (obj: ChangedObject) => {
    const featureId = `${obj.osmType}/${obj.osmId}`;
    if (obj.action === 'delete') {
      deletedBuildingFeatureIds.add(featureId);
    }
    directlyAffected.add(featureId);
  };

  for (const way of summary.ways) {
    if (looksLikeBuilding(way.tags)) {
      markBuilding(way);
    }
  }
  for (const rel of summary.relations) {
    if (looksLikeBuilding(rel.tags)) {
      markBuilding(rel);
    }
  }
  for (const node of summary.nodes) {
    touchedNodeIds.add(node.osmId);
  }

  return {
    directlyAffected,
    deletedBuildingFeatureIds,
    changedNodes: summary.nodes,
    touchedNodeIds
  };
}

async function writeOsmIdFilterFile(filePath: string, featureIds: Iterable<string>): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sorted = Array.from(featureIds)
    .map((id) => String(id || '').trim())
    .filter((id) => /^(way|relation)\/\d+$/.test(id))
    .sort((a, b) => {
      const [at, ai] = a.split('/');
      const [bt, bi] = b.split('/');
      if (at !== bt) return at < bt ? -1 : 1;
      const ain = Number(ai);
      const bin = Number(bi);
      return ain === bin ? 0 : ain < bin ? -1 : 1;
    });
  fs.writeFileSync(filePath, sorted.length ? sorted.join('\n') + '\n' : '');
}

async function extractSubsetPbf(options: {
  newPbf: string;
  featureIds: Iterable<string>;
  outputPbf: string;
  osmiumBin?: string;
  addReferenced?: boolean;
}): Promise<{ subsetPath: string; idsWritten: number }> {
  const bin = options.osmiumBin || 'osmium';
  const tmpIdFile = path.join(os.tmpdir(), `archimap-osmium-ids-${process.pid}-${Date.now()}.txt`);
  const lines: string[] = [];
  for (const raw of options.featureIds) {
    const id = String(raw || '').trim();
    if (!id) continue;
    // osmium getid -i text format: "w12345", "r12345", "n12345" per line.
    const match = /^(way|relation|node)\/(\d+)$/.exec(id);
    if (!match) continue;
    const prefix = match[1] === 'way' ? 'w' : match[1] === 'relation' ? 'r' : 'n';
    lines.push(`${prefix}${match[2]}`);
  }
  fs.writeFileSync(tmpIdFile, lines.join('\n') + (lines.length ? '\n' : ''));
  try {
    const args = ['getid', '-i', tmpIdFile];
    if (options.addReferenced !== false) args.push('-r');
    args.push('-o', options.outputPbf, '--overwrite', options.newPbf);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`osmium getid exited with code ${code}: ${stderrBuf.trim()}`));
      });
    });
  } finally {
    try {
      fs.unlinkSync(tmpIdFile);
    } catch {
      // best-effort cleanup
    }
  }
  return { subsetPath: options.outputPbf, idsWritten: lines.length };
}

module.exports = {
  runDeriveChanges,
  parseChangeset,
  selectBuildingChanges,
  looksLikeBuilding,
  writeOsmIdFilterFile,
  extractSubsetPbf
};
