const { spawnSync } = require('child_process');
const path = require('path');

function getDefaultImporterPath() {
  return path.resolve(__dirname, '..', 'sync-osm-buildings.py');
}

function getPythonCandidates(env = process.env) {
  const out = [];
  const envPython = String(env.PYTHON_BIN || '').trim();
  if (envPython) {
    out.push({ exe: envPython, prefixArgs: [] });
  }
  if (process.platform === 'win32') {
    out.push(
      { exe: 'py', prefixArgs: ['-3'] },
      { exe: 'python', prefixArgs: [] },
      { exe: 'python3', prefixArgs: [] }
    );
  } else {
    out.push(
      { exe: 'python3', prefixArgs: [] },
      { exe: 'python', prefixArgs: [] },
      { exe: 'py', prefixArgs: ['-3'] }
    );
  }
  return out;
}

function runPythonWithCandidate(candidate, args, stdio = 'inherit', env = process.env) {
  const result = spawnSync(candidate.exe, [...candidate.prefixArgs, ...args], {
    stdio,
    shell: false,
    env
  });
  return { ok: result.status === 0, status: result.status ?? 1, result };
}

function runPython(args, stdio = 'inherit', preferredCandidate = null, env = process.env) {
  if (preferredCandidate) {
    const direct = runPythonWithCandidate(preferredCandidate, args, stdio, env);
    if (direct.ok) return { ok: true, candidate: preferredCandidate, result: direct.result };
    return { ok: false, candidate: preferredCandidate, result: direct.result };
  }

  for (const candidate of getPythonCandidates(env)) {
    const result = runPythonWithCandidate(candidate, args, stdio, env);
    if (result.ok) return { ok: true, candidate, result: result.result };
  }
  return { ok: false, candidate: null, result: null };
}

function ensurePythonImporterDeps(env = process.env) {
  const candidates = getPythonCandidates(env).filter((candidate) => {
    const probe = runPythonWithCandidate(candidate, ['-c', 'import sys; print(sys.executable)'], 'pipe', env);
    return probe.ok;
  });
  if (candidates.length === 0) {
    throw new Error('Python interpreter not found (python/py -3).');
  }

  for (const candidate of candidates) {
    const check = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate, env);
    if (check.ok) return candidate;
  }

  throw new Error(
    'Python modules quackosm/duckdb are not available. ' +
    'Install them manually, for example: "py -3 -m pip install --user quackosm duckdb".'
  );
}

function parseJsonPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Python extractor returned empty JSON payload');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse Python extractor JSON: ${String(error?.message || error)}`);
  }
}

function runImporterJson(importerPath, args, env = process.env) {
  const pythonCandidate = ensurePythonImporterDeps(env);
  const result = spawnSync(pythonCandidate.exe, [
    ...pythonCandidate.prefixArgs,
    importerPath,
    ...args
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env
  });

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status !== 0) {
    const message = stderr.trim() || stdout.trim() || 'Python extractor command failed';
    throw new Error(message);
  }

  return parseJsonPayload(stdout);
}

function createPythonExtractResolver(options = {}) {
  const importerPath = String(options.importerPath || getDefaultImporterPath()).trim() || getDefaultImporterPath();
  const env = options.env || process.env;

  return {
    async searchExtractCandidates(query, searchOptions = {}) {
      const limit = Math.max(1, Math.min(50, Number(searchOptions.limit || 12) || 12));
      const source = String(searchOptions.source || 'any').trim() || 'any';
      return runImporterJson(importerPath, [
        '--resolve-extract-query',
        String(query || ''),
        '--extract-source',
        source,
        '--limit',
        String(limit)
      ], env);
    },
    async resolveExactExtract(query, resolveOptions = {}) {
      const source = String(resolveOptions.source || 'any').trim() || 'any';
      return runImporterJson(importerPath, [
        '--resolve-exact-extract',
        String(query || ''),
        '--extract-source',
        source
      ], env);
    }
  };
}

function exportRegionExtractToNdjson({
  importerPath,
  region,
  outputPath,
  dbOutputPath,
  geojsonOutputPath,
  env = process.env
}) {
  const pythonCandidate = ensurePythonImporterDeps(env);
  const extractId = String(region?.extractId || '').trim();
  const extractSource = String(region?.extractSource || 'any').trim() || 'any';
  if (!extractId) {
    throw new Error('Managed region sync requires canonical extract id');
  }

  const legacyOutputPath = String(outputPath || '').trim();
  const nextDbOutputPath = String(dbOutputPath || '').trim();
  const nextGeojsonOutputPath = String(geojsonOutputPath || '').trim();
  if (legacyOutputPath && (nextDbOutputPath || nextGeojsonOutputPath)) {
    throw new Error('Use either outputPath or dbOutputPath/geojsonOutputPath for region extract export');
  }
  if (!legacyOutputPath && !nextDbOutputPath && !nextGeojsonOutputPath) {
    throw new Error('Region extract export requires at least one output path');
  }

  const args = [
    importerPath,
    '--extract-query', extractId,
    '--extract-source', extractSource
  ];
  if (legacyOutputPath) {
    args.push('--out-ndjson', legacyOutputPath);
  } else {
    if (nextDbOutputPath) {
      args.push('--out-db-ndjson', nextDbOutputPath);
    }
    if (nextGeojsonOutputPath) {
      args.push('--out-geojson-ndjson', nextGeojsonOutputPath);
    }
  }

  const result = runPython(args, 'inherit', pythonCandidate, {
    ...env,
    IMPORT_LIMIT: '0'
  });

  if (!result.ok) {
    throw new Error('Python importer failed for managed region sync');
  }
}

module.exports = {
  createPythonExtractResolver,
  ensurePythonImporterDeps,
  exportRegionExtractToNdjson,
  getDefaultImporterPath
};
