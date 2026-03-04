const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRuntimeEnv } = require('../../src/lib/server/infra/env.infra');

test('parseRuntimeEnv parses production environment without bootstrap flags', () => {
  const env = parseRuntimeEnv({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3252',
    SESSION_SECRET: 'very-strong-production-secret',
    APP_BASE_URL: 'https://example.test'
  });
  assert.equal(env.nodeEnv, 'production');
  assert.equal(env.host, '0.0.0.0');
  assert.equal(env.port, 3252);
});

test('parseRuntimeEnv rejects weak production session secret', () => {
  assert.throws(() => {
    parseRuntimeEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'dev-secret-change-me',
      APP_BASE_URL: 'https://example.test'
    });
  }, /SESSION_SECRET/);
});
