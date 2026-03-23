const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniApp, jsonMiddleware } = require('../../src/lib/server/infra/mini-app.infra');

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
    throw new Error('Server is not listening on an address');
  }
  return address.port;
}

test('createMiniApp hides thrown handler details from clients', async (t) => {
  const app = createMiniApp();
  app.get('/boom', () => {
    throw new Error('database password leaked');
  });

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = getServerPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/boom`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, {
    code: 'ERR_INTERNAL',
    error: 'Internal server error'
  });
});

test('createMiniApp listen fallback hides unhandled app.handle details from clients', async (t) => {
  const app = createMiniApp();
  app.handle = async () => {
    throw new Error('top level stack details');
  };

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = getServerPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, {
    code: 'ERR_INTERNAL',
    error: 'Internal server error'
  });
});

test('createMiniApp handles simple route matching and parameters', async (t) => {
  const app = createMiniApp();
  app.get('/users/:id', (req, res) => {
    res.json({ id: req.params.id, query: req.query });
  });

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = getServerPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/users/123?q=search`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { id: '123', query: { q: 'search' } });
});

test('createMiniApp handles jsonMiddleware', async (t) => {
  const app = createMiniApp();
  app.use(jsonMiddleware());
  app.post('/data', (req, res) => {
    res.json({ received: req.body });
  });

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = getServerPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'value' })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { received: { key: 'value' } });
});
