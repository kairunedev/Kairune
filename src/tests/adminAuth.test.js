'use strict';

// Unit tests for the admin-key guard that protects the money-mutating routes
// (POST /permissions/:pid/spends, POST /agents/:id/permissions,
//  POST /permissions/:pid/revoke). The guard is bypassed under NODE_ENV=test,
// so we exercise it directly with a controlled environment.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { requireAdmin } = require('../middleware/moderation');

// Minimal mock request whose get() mimics Express header lookup.
function mockReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[String(name).toLowerCase()] };
}

let prevAdminKey;
let prevNodeEnv;

beforeEach(() => {
  prevAdminKey = process.env.ADMIN_KEY;
  prevNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = prevAdminKey;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

test('stays open when ADMIN_KEY is unset (demo/dev default)', () => {
  delete process.env.ADMIN_KEY;
  process.env.NODE_ENV = 'production';
  assert.strictEqual(requireAdmin(mockReq()), true);
});

test('rejects a missing key with 401 when ADMIN_KEY is set', () => {
  process.env.ADMIN_KEY = 'secret-key';
  process.env.NODE_ENV = 'production';
  assert.throws(
    () => requireAdmin(mockReq()),
    (err) => err.status === 401
  );
});

test('rejects a wrong key with 401 when ADMIN_KEY is set', () => {
  process.env.ADMIN_KEY = 'secret-key';
  process.env.NODE_ENV = 'production';
  assert.throws(
    () => requireAdmin(mockReq({ 'X-Admin-Key': 'nope' })),
    (err) => err.status === 401
  );
});

test('accepts the correct key when ADMIN_KEY is set', () => {
  process.env.ADMIN_KEY = 'secret-key';
  process.env.NODE_ENV = 'production';
  assert.strictEqual(
    requireAdmin(mockReq({ 'X-Admin-Key': 'secret-key' })),
    true
  );
});
