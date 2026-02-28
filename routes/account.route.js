function registerAccountRoutes({ app, requireAuth, getSessionEditActorKey, normalizeUserEditStatus, getUserEditsList, getUserEditDetailsById }) {
  app.get('/api/account/edits', requireAuth, (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
    }
    const statusRaw = String(req.query?.status || '').trim().toLowerCase();
    const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const items = getUserEditsList({ createdBy: actorKey, status, limit: 5000 });
    return res.json({ total: items.length, items });
  });

  app.get('/api/account/edits/:editId', requireAuth, (req, res) => {
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
