const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PID_MARKER = '__ARCHIMAP_OSMIUM_PID__=';

type ReplicationMetadata = { baseUrl: string; sequence: number; timestamp: string };
type OsmiumOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  spawnRef?: typeof spawn;
  onOutput?: (line: string) => void;
};

function abortError() {
  const error = new Error('Osmium operation cancelled');
  error.name = 'AbortError';
  return error;
}

function toOsmiumContainerPath(filePath: string, env: NodeJS.ProcessEnv = process.env) {
  const hostRoot = env.OSMIUM_HOST_DATA_ROOT || env.ARCHIMAP_DATA_DIR || '/app/data';
  const containerRoot = String(env.OSMIUM_CONTAINER_DATA_ROOT || '/app/data').replace(/\/+$/, '');
  const pathApi = /^[a-z]:[\\/]/i.test(hostRoot) ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(hostRoot), pathApi.resolve(filePath));
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error('Osmium container input/output must be within OSMIUM_HOST_DATA_ROOT');
  }
  return `${containerRoot}${relative ? `/${relative.replace(/\\/g, '/')}` : ''}`;
}

function commandForOsmium(args: string[], filePaths: string[], env: NodeJS.ProcessEnv) {
  const container = String(env.OSMIUM_CONTAINER || '').trim();
  const bin = String(env.OSMIUM_BIN || 'osmium').trim() || 'osmium';
  if (!container) return { executable: bin, args, container: null };
  const mapped = new Map(filePaths.map((filePath) => [filePath, toOsmiumContainerPath(filePath, env)]));
  return {
    executable: 'docker',
    container,
    args: [
      'exec',
      container,
      'sh',
      '-c',
      `printf '${PID_MARKER}%s\\n' "$$" >&2; exec "$@"`,
      'archimap-osmium',
      bin,
      ...args.map((arg) => mapped.get(arg) || arg)
    ]
  };
}

async function runOsmium(args: string[], filePaths: string[], options: OsmiumOptions = {}) {
  const { env = process.env, signal, spawnRef = spawn } = options;
  if (signal?.aborted) throw abortError();
  const command = commandForOsmium(args, filePaths, env);
  return await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputLine = '';
    let failure: Error = null;
    let cancelled = false;
    let remotePid = null;
    let remoteTerminated = false;
    let killTimer = null;
    let finished = false;
    const child = spawnRef(command.executable, command.args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    function signalRemote(signalName, afterSignal = null) {
      if (!remotePid) return;
      // Killing only `docker exec` leaves its container process running. The fixed
      // wrapper reports its PID before exec, so cancellation reaches Osmium too.
      const killer = spawnRef('docker', ['exec', command.container, 'kill', signalName, String(remotePid)], {
        env,
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('error', () => {});
      if (afterSignal) killer.once('close', afterSignal);
    }
    function terminate() {
      if (command.container) {
        if (remotePid && !remoteTerminated) {
          remoteTerminated = true;
          signalRemote('-TERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (command.container && remotePid) {
            // Wait for remote SIGKILL delivery before closing the local client;
            // its close event permits callers to remove output files.
            signalRemote('-KILL', () => child.kill('SIGKILL'));
          } else {
            child.kill('SIGKILL');
          }
        }, 5000);
        killTimer.unref();
      }
    }
    function onAbort() {
      cancelled = true;
      terminate();
    }
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        failure = new Error('Osmium output exceeded the metadata limit');
        terminate();
      }
    });
    child.stderr.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-16384);
      if (options.onOutput) {
        outputLine += data.toString();
        const lines = outputLine.split(/\r?\n/);
        outputLine = lines.pop();
        for (const line of lines) {
          if (line && !line.startsWith(PID_MARKER)) options.onOutput(line);
        }
      }
      const match = stderr.match(/__ARCHIMAP_OSMIUM_PID__=(\d+)\r?\n/);
      if (match) {
        remotePid = Number(match[1]);
        stderr = stderr.replace(match[0], '');
        if (cancelled || failure) terminate();
      }
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(abortError());
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Osmium ${args[0]} failed (${code}): ${stderr.trim()}`));
      resolve(stdout);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort between the initial check and listener registration must also stop
    // the child; wait for close before callers clean its workspace.
    if (!finished && signal?.aborted) onAbort();
  });
}

function normalizeReplicationMetadata(metadata: ReplicationMetadata): ReplicationMetadata {
  const baseUrl = String(metadata?.baseUrl || '').trim();
  const sequence = Number(metadata?.sequence);
  const timestamp = String(metadata?.timestamp || '').trim();
  if (
    !/^https?:\/\//i.test(baseUrl) ||
    String(metadata?.sequence ?? '').trim() === '' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error('PBF replication metadata is missing or invalid');
  }
  return { baseUrl, sequence, timestamp: new Date(timestamp).toISOString() };
}

async function readPbfReplicationMetadata(filePath: string, options: OsmiumOptions & { allowMissing?: boolean } = {}) {
  const output = await runOsmium(['fileinfo', '--json', filePath], [filePath], options);
  const info = JSON.parse(output);
  const header = info?.header?.option || {};
  // Missing values must not coerce to sequence zero and initialize a wrong feed.
  const required = [
    header.osmosis_replication_base_url,
    header.osmosis_replication_sequence_number,
    header.osmosis_replication_timestamp
  ];
  if (required.some((value) => value == null || String(value).trim() === '')) {
    if (options.allowMissing) return null;
    throw new Error('PBF replication metadata is missing or invalid');
  }
  return normalizeReplicationMetadata({
    baseUrl: header.osmosis_replication_base_url,
    sequence: header.osmosis_replication_sequence_number,
    timestamp: header.osmosis_replication_timestamp
  });
}

async function applyReplicationChanges({
  basePath,
  changePaths,
  targetPath,
  state,
  _argumentBudgetBytes = process.platform === 'win32' ? 24 * 1024 : 512 * 1024,
  ...options
}: OsmiumOptions & {
  basePath: string;
  changePaths: string[];
  targetPath: string;
  state: ReplicationMetadata;
  /** Private test seam for exercising OS command-length boundaries. */
  _argumentBudgetBytes?: number;
}) {
  const metadata = normalizeReplicationMetadata(state);
  if (!Array.isArray(changePaths) || changePaths.length === 0) {
    throw new Error('Applying replication changes requires an ordered nonempty diff batch');
  }
  if (path.resolve(basePath) === path.resolve(targetPath)) {
    throw new Error('Osmium output must differ from its base PBF');
  }
  if (!Number.isSafeInteger(_argumentBudgetBytes) || _argumentBudgetBytes < 1) {
    throw new Error('Invalid Osmium argument budget');
  }
  const env = options.env || process.env;
  const intermediatePath = () =>
    path.join(path.dirname(targetPath), `.replication-${crypto.randomBytes(8).toString('hex')}.osm.pbf`);
  const argumentBytes = (arg) => Buffer.byteLength(arg, 'utf8') * (process.platform === 'win32' ? 2 : 1) + 4;
  function argsFor(input, output, changes, final = true) {
    return [
      'apply-changes',
      '--no-progress',
      '--fsync',
      '--output-format=pbf',
      ...(final
        ? [
            `--output-header=osmosis_replication_base_url=${metadata.baseUrl}`,
            `--output-header=osmosis_replication_sequence_number=${metadata.sequence}`,
            `--output-header=osmosis_replication_timestamp=${metadata.timestamp}`
          ]
        : []),
      '--output',
      output,
      input,
      ...changes
    ];
  }
  // Reserve the longest possible input/output names, including unpublished
  // intermediates. Windows needs additional room for Node's argv quoting.
  const possiblePaths = [basePath, targetPath, intermediatePath()];
  const mapPath = (file) => (env.OSMIUM_CONTAINER ? toOsmiumContainerPath(file, env) : file);
  const longestPath = possiblePaths.reduce((longest, file) =>
    argumentBytes(mapPath(file)) > argumentBytes(mapPath(longest)) ? file : longest
  );
  const fixedCommand = commandForOsmium(argsFor(longestPath, longestPath, []), [longestPath], env);
  const fixedBytes = [fixedCommand.executable, ...fixedCommand.args].reduce((sum, arg) => sum + argumentBytes(arg), 0);
  const groups: string[][] = [];
  let group = [],
    bytes = fixedBytes;
  for (const file of changePaths) {
    const size = argumentBytes(mapPath(file));
    if (fixedBytes + size > _argumentBudgetBytes) throw new Error('One Osmium diff path exceeds the argument budget');
    if (bytes + size > _argumentBudgetBytes) {
      groups.push(group);
      group = [];
      bytes = fixedBytes;
    }
    group.push(file);
    bytes += size;
  }
  if (group.length) groups.push(group);
  const intermediates = new Set<string>();
  let input = basePath;
  try {
    for (let index = 0; index < groups.length; index++) {
      options.signal?.throwIfAborted();
      const final = index === groups.length - 1;
      const output = final ? targetPath : intermediatePath();
      if (!final) intermediates.add(output);
      // Do not sort/simplify: equal-version extract changes are applied in feed
      // order, including across groups. Only the final file gets the new cursor.
      await runOsmium(argsFor(input, output, groups[index], final), [input, output, ...groups[index]], options);
      if (intermediates.has(input)) {
        fs.rmSync(input, { force: true });
        intermediates.delete(input);
      }
      input = output;
    }
  } finally {
    // runOsmium waits for native/remote process exit before cleanup is allowed.
    for (const file of intermediates) fs.rmSync(file, { force: true });
  }
  const actual = await readPbfReplicationMetadata(targetPath, options);
  if (
    actual.baseUrl !== metadata.baseUrl ||
    actual.sequence !== metadata.sequence ||
    actual.timestamp !== metadata.timestamp
  ) {
    throw new Error('Applied PBF replication metadata differs from the requested state');
  }
  return actual;
}

async function filterBuildingSource({
  basePath,
  targetPath,
  ...options
}: OsmiumOptions & { basePath: string; targetPath: string }) {
  if (path.resolve(basePath) === path.resolve(targetPath)) {
    throw new Error('Osmium output must differ from its base PBF');
  }
  await runOsmium(
    [
      'tags-filter',
      '--no-progress',
      '--fsync',
      '--output-format=pbf',
      '--output',
      targetPath,
      basePath,
      'wr/building',
      'wr/building:part'
    ],
    [basePath, targetPath],
    options
  );
  // Default tags-filter completes references and keeps their tags. Never use
  // --omit-referenced or --remove-tags: moved nodes and relation members matter.
  return targetPath;
}

module.exports = {
  applyReplicationChanges,
  commandForOsmium,
  filterBuildingSource,
  readPbfReplicationMetadata,
  toOsmiumContainerPath
};
