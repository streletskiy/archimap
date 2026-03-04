const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRuntimeEnv } = require('../../src/lib/server/infra/env.infra');

test('parseRuntimeEnv applies secure bootstrap defaults in production', () => {
  const env = parseRuntimeEnv({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3252',
    SESSION_SECRET: 'very-strong-production-secret',
    APP_BASE_URL: 'https://example.test'
  });
  assert.equal(env.bootstrapAdminEnabled, false);
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
