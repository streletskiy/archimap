const { spawnSync } = require('child_process');

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
  return { ok: result.status === 0, status: result.status ?? 1 };
}

function runPython(args, stdio = 'inherit', preferredCandidate = null, env = process.env) {
  if (preferredCandidate) {
    const direct = runPythonWithCandidate(preferredCandidate, args, stdio, env);
    if (direct.ok) return { ok: true, candidate: preferredCandidate };
    return { ok: false, candidate: preferredCandidate };
  }

  for (const candidate of getPythonCandidates(env)) {
    const result = runPythonWithCandidate(candidate, args, stdio, env);
    if (result.ok) return { ok: true, candidate };
  }
  return { ok: false, candidate: null };
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

function exportRegionExtractToNdjson({
  importerPath,
  region,
  outputPath,
  env = process.env
}) {
  const pythonCandidate = ensurePythonImporterDeps(env);
  const result = runPython([
    importerPath,
    '--extract-query', region.sourceValue,
    '--out-ndjson', outputPath
  ], 'inherit', pythonCandidate, {
    ...env,
    IMPORT_LIMIT: '0'
  });

  if (!result.ok) {
    throw new Error('Python importer failed for managed region sync');
  }
}

module.exports = {
  exportRegionExtractToNdjson
};
