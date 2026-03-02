function registerAccountRoutes({
  app,
  accountReadRateLimiter,
  requireAuth,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  getUserEditsList,
  getUserEditDetailsById
}) {
  function parseLimit(raw, fallback = 200, min = 1, max = 500) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.trunc(n);
    return Math.max(min, Math.min(max, v));
  }

  app.get('/api/account/edits', accountReadRateLimiter, requireAuth, (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
    }
    const statusRaw = String(req.query?.status || '').trim().toLowerCase();
    const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const limit = parseLimit(req.query?.limit, 200, 1, 500);
    const items = getUserEditsList({ createdBy: actorKey, status, limit, summary: false });
    return res.json({ total: items.length, items });
  });

  app.get('/api/account/edits/:editId', accountReadRateLimiter, requireAuth, (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
    }
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const item = getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }
    if (String(item.updatedBy || '').trim().toLowerCase() !== actorKey) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    return res.json({ item });
  });
}

module.exports = {
  registerAccountRoutes
};
