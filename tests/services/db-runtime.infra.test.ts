const test = require('node:test');
const assert = require('node:assert/strict');
const { _test_ } = require('../../src/lib/server/infra/db-runtime.infra');

const {
  replaceSqlitePositionalPlaceholders,
  convertNamedParams,
  createPostgresCompatDb
} = _test_;

test('replaceSqlitePositionalPlaceholders correctly replaces ? with $n ignoring strings/comments', () => {
  const sql = `
    SELECT * FROM users
    WHERE id = ? /* comment ? */ AND name = 'user?'
    -- another ?
    AND age > ?
  `;
  const result = replaceSqlitePositionalPlaceholders(sql, (idx) => `$${idx}`);
  assert.equal(result.includes('id = $1'), true);
  assert.equal(result.includes('age > $2'), true);
  assert.equal(result.includes('/* comment ? */'), true);
  assert.equal(result.includes("'user?'"), true);
  assert.equal(result.includes('-- another ?'), true);
});

test('convertNamedParams replaces @name with $n and returns array of values', () => {
  const sql = 'SELECT * FROM users WHERE id = @id AND age > @age OR user_id = @id';
  const params = { id: 123, age: 18 };
  const { text, values } = convertNamedParams(sql, params);
  
  assert.equal(text, 'SELECT * FROM users WHERE id = $1 AND age > $2 OR user_id = $1');
  assert.deepEqual(values, [123, 18]);
});

test('createPostgresCompatDb wraps pg pool in sqlite-compatible API', async () => {
  const mockPool = {
    query: async (text, _values) => {
      if (text.includes('INSERT')) {
        return { rowCount: 1, rows: [{ id: 456 }] };
      }
      return { rowCount: 1, rows: [{ id: 123, name: 'Test' }] };
    }
  };

  const db = createPostgresCompatDb(mockPool);
  assert.equal(db.provider, 'postgres');

  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(123);
  assert.deepEqual(row, { id: 123, name: 'Test' });

  const rows = await db.prepare('SELECT * FROM users').all();
  assert.deepEqual(rows, [{ id: 123, name: 'Test' }]);

  const result = await db.prepare('INSERT INTO users(name) VALUES(?) RETURNING id').run('Test2');
  assert.deepEqual(result, { changes: 1, lastInsertRowid: 456 });
});
