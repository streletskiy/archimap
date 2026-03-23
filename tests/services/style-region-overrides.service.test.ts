const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration = require('../../db/migrations/009_style_region_overrides.migration.ts');
const { createStyleRegionOverridesService } = require('../../src/lib/server/services/style-region-overrides.service');

function createTestDb() {
  const rawDb = new Database(':memory:');
  migration.up(rawDb);

  let txQueue = Promise.resolve();
  return {
    provider: 'sqlite',
    prepare(sql) {
      const statement = rawDb.prepare(String(sql || ''));
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args)
      };
    },
    transaction(fn) {
      return async (...args) => {
        const run = async () => {
          rawDb.exec('BEGIN');
          try {
            const result = await fn(...args);
            rawDb.exec('COMMIT');
            return result;
          } catch (error) {
            try {
              rawDb.exec('ROLLBACK');
            } catch {
              // Keep original error.
            }
            throw error;
          }
        };

        const execution = txQueue.then(run, run);
        txQueue = execution.catch(() => {});
        return execution;
      };
    }
  };
}

test('style region overrides service saves, updates, lists, and deletes overrides', async () => {
  const db = createTestDb();
  const service = createStyleRegionOverridesService({ db });

  const first = await service.saveOverride({
    region_pattern: 'RU-*',
    style_key: 'omani',
    is_allowed: true
  }, 'admin@example.com');

  assert.equal(first.region_pattern, 'ru-*');
  assert.equal(first.style_key, 'omani');
  assert.equal(first.is_allowed, true);
  assert.equal(first.updated_by, 'admin@example.com');
  assert.equal(Number.isInteger(first.id), true);

  const updated = await service.saveOverride({
    region_pattern: 'ru-*',
    style_key: 'omani',
    is_allowed: false
  }, 'moderator@example.com');

  assert.equal(updated.id, first.id);
  assert.equal(updated.is_allowed, false);
  assert.equal(updated.updated_by, 'moderator@example.com');

  const adminItems = await service.listOverridesForAdmin();
  assert.equal(adminItems.length, 1);
  assert.equal(adminItems[0].is_allowed, false);
  assert.equal(adminItems[0].created_at != null, true);

  const publicItems = await service.listPublicOverrides();
  assert.deepEqual(publicItems, [{
    id: first.id,
    region_pattern: 'ru-*',
    style_key: 'omani',
    is_allowed: false
  }]);

  const deleted = await service.deleteOverride(first.id);
  assert.equal(deleted.id, first.id);
  assert.deepEqual(await service.listOverridesForAdmin(), []);
});
