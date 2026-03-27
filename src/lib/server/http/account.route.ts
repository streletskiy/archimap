const { sendCachedJson } = require('../infra/http-cache.infra');
const { requireCsrfSession } = require('../services/csrf.service');

function registerAccountRoutes({
  app,
  accountReadRateLimiter,
  requireAuth,
  getSessionEditActorKey,
  normalizeUserEditStatus,
  getUserEditsPage,
  getUserEditDetailsById,
  withdrawPendingUserEdit
}) {
  function parseLimit(raw, fallback = 200, min = 1, max = 500) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.trunc(n);
    return Math.max(min, Math.min(max, v));
  }

  function parsePage(raw, fallback = 1, min = 1, max = 1000) {
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
    const query = String(req.query?.q || '').trim();
    const createdFrom = String(req.query?.from || '').trim();
    const createdTo = String(req.query?.to || '').trim();
    const page = parsePage(req.query?.page, 1, 1, 1000);
    const limit = parseLimit(req.query?.limit, 20, 1, 100);
    const offset = (page - 1) * limit;
    const pageData = typeof getUserEditsPage === 'function'
      ? await getUserEditsPage({
        createdBy: actorKey,
        status,
        q: query,
        createdFrom,
        createdTo,
        limit,
        offset
      })
      : { total: 0, items: [] };
    const pageCount = pageData.total > 0 ? Math.ceil(pageData.total / limit) : 0;
    return sendCachedJson(req, res, {
      total: pageData.total,
      page,
      pageSize: limit,
      pageCount,
      items: pageData.items
    }, {
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
