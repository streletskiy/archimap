// Bound probes and coalesce concurrent health checks without retaining failures.
function createReadinessProbe(check, { ttlMs = 1000, timeoutMs = 2000 }: LooseRecord = {}) {
  let pending = null;
  let checkedAt = 0;
  let ready = false;
  return async () => {
    if (pending) return pending;
    if (Date.now() - checkedAt < ttlMs) return ready;
    pending = (async () => {
      let timer;
      try {
        ready = Boolean(await Promise.race([
          Promise.resolve().then(check),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); })
        ]));
      } catch { ready = false; }
      finally { clearTimeout(timer); checkedAt = Date.now(); pending = null; }
      return ready;
    })();
    return pending;
  };
}

module.exports = { createReadinessProbe };
