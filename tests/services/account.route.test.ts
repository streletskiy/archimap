const test = require('node:test');
const assert = require('node:assert/strict');

const { createMiniApp, jsonMiddleware } = require('../../src/lib/server/infra/mini-app.infra');
const { registerAccountRoutes } = require('../../src/lib/server/http/account.route');

async function startServer(app): Promise<import('node:http').Server> {
  return await new Promise<import('node:http').Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function stopServer(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function getServerPort(server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server is not listening');
  }
  return address.port;
}

test('account edit deletion route withdraws the current user pending edit', async (t) => {
  const app = createMiniApp();
  app.use(jsonMiddleware());

  const withdrawCalls = [];
  registerAccountRoutes({
    app,
    accountReadRateLimiter: (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    getSessionEditActorKey: () => 'user@example.com',
    normalizeUserEditStatus: (value) => value,
    getUserEditsList: async () => [],
    getUserEditDetailsById: async () => null,
    withdrawPendingUserEdit: async (editId, actor) => {
      withdrawCalls.push({ editId, actor });
      return {
        editId: Number(editId),
        osmType: 'way',
        osmId: 123,
        status: 'pending',
        deletedMergedLocal: false
      };
    }
  });

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = getServerPort(server);

  const response = await fetch(`http://127.0.0.1:${port}/api/account/edits/77`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json'
    }
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.item.editId, 77);
  assert.deepEqual(withdrawCalls, [{ editId: '77', actor: 'user@example.com' }]);
});
