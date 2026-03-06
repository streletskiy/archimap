const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniApp } = require('../../src/lib/server/infra/mini-app.infra');

async function startServer(app) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

test('createMiniApp hides thrown handler details from clients', async (t) => {
  const app = createMiniApp();
  app.get('/boom', () => {
    throw new Error('database password leaked');
  });

  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const { port } = server.address();
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

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, {
    code: 'ERR_INTERNAL',
    error: 'Internal server error'
  });
});
