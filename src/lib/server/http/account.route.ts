const { sendCachedJson } = require('../infra/http-cache.infra');
const { requireCsrfSession } = require('../services/csrf.service');

function registerAccountRoutes({
  app,
  accountReadRateLimiter,
  requireAuth,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  getUserEditsList,
  getUserEditDetailsById,
  withdrawPendingUserEdit
}) {
  function parseLimit(raw, fallback = 200, min = 1, max = 500) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.trunc(n);
    return Math.max(min, Math.min(max, v));
  }

  app.get('/api/account/edits', accountReadRateLimiter, requireAuth, async (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve current user' });
    }
    const statusRaw = String(req.query?.status || '').trim().toLowerCase();
    const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const limit = parseLimit(req.query?.limit, 200, 1, 500);
    const items = await getUserEditsList({ createdBy: actorKey, status, limit, summary: false });
    return sendCachedJson(req, res, { total: items.length, items }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.get('/api/account/edits/:editId', accountReadRateLimiter, requireAuth, async (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve current user' });
    }
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ code: 'ERR_INVALID_EDIT_ID', error: 'Invalid edit id' });
    }
    const item = await getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ code: 'ERR_EDIT_NOT_FOUND', error: 'Edit not found' });
    }
    if (String(item.updatedBy || '').trim().toLowerCase() !== actorKey) {
      return res.status(403).json({ code: 'ERR_ACCESS_DENIED', error: 'Access denied' });
    }
    return sendCachedJson(req, res, { item }, {
      cacheControl: 'private, no-cache',
      lastModified: item.updatedAt || undefined
    });
  });

  app.delete('/api/account/edits/:editId', requireCsrfSession, requireAuth, async (req, res) => {
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve current user' });
    }
    if (typeof withdrawPendingUserEdit !== 'function') {
      return res.status(500).json({ code: 'ERR_REQUEST_FAILED', error: 'Account edit cancellation is unavailable' });
    }

    try {
      const item = await withdrawPendingUserEdit(req.params.editId, actorKey);
      return res.json({ ok: true, item });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = String(error?.code || '').trim() || 'ERR_REQUEST_FAILED';
      return res.status(status).json({
        code,
        error: String(error?.message || 'Account edit cancellation failed')
      });
    }
  });
}

module.exports = {
  registerAccountRoutes
};
