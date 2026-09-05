const test = require('node:test');
const assert = require('node:assert/strict');
const { load, database } = require('./helpers.cjs');

function fixture() {
  const calls = [];
  const registry = {
    health: async () => ({ ok: true, indexed: 0, commit: null }),
    search: async (_env, query, top) => { calls.push(['search', query, top]); return []; },
    getResume: async (_env, id) => ({ id, resume: '# Fixture' }),
    reindex: async (_env, commit) => ({ indexed: 0, excluded: 0, commit }),
  };
  const candidates = {
    submit: async (_env, args) => { calls.push(['submit', args]); return { status: 'verification_required', request_id: 'fixture-request' }; },
    contact: async (_env, id) => ({ id, email: 'controlled@example.test' }),
  };
  const app = load('src/index.ts', { modules: { './registry': registry, './candidates': candidates } }).default;
  const env = { DB: database(), ADMIN_TOKEN: 'local-admin-only', GITHUB_REPO: 'fixture/registry' };
  const request = async (body, extra = {}, route = '/mcp', method = 'POST') => {
    const response = await app.fetch(new Request('https://hires.md' + route, { method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10', ...extra },
      ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env);
    const raw = await response.text();
    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { app, env, calls, request };
}

test('malformed MCP envelopes are rejected rather than echoed', async () => {
  const f = fixture();
  for (const body of [
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { jsonrpc: '2.0', id: true, method: 'ping' },
  ]) {
    const r = await f.request(body);
    assert.equal(r.body.error.code, -32600);
  }
});
test('public API integrates verified candidate and registry boundaries without legacy endpoints', async () => {
  const f = fixture();
  const r = await f.request({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'search', arguments: { query: 'Rust engineer', top_n: 2 } } });
  assert.equal(r.body.result.isError, false);
  assert.deepEqual(JSON.parse(r.body.result.content[0].text), []);
  assert.deepEqual(f.calls, [['search', 'Rust engineer', 2]]);
  assert.equal((await f.request({}, {}, '/admin/token')).status, 404);
  assert.equal((await f.request({}, {}, '/admin/digest')).status, 404);
  const root = await f.request(undefined, {}, '/', 'GET');
  assert.equal(root.status, 200);
  assert.match(root.body, /https:\/\/hires.md\/mcp/);
});
test('HTTP rejects foreign origins, unsupported versions, wrong types and oversized bodies before work', async () => {
  const f = fixture();
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await f.request(ping, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await f.request(ping, { 'MCP-Protocol-Version': 'invalid' })).status, 400);
  assert.equal((await f.request(ping, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request('x'.repeat(70000))).status, 413);
  assert.equal((await f.request('{')).body.error.code, -32700);
  const invalid = await f.request(null);
  assert.equal(invalid.body.error.code, -32600);
  assert.equal(f.calls.length, 0);
});

test('valid tokenless handshake, validation errors and notifications have precise results', async () => {
  const f = fixture();
  const initialize = await f.request({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(initialize.body.id, 0);
  assert.equal(initialize.body.result.protocolVersion, '2025-06-18');
  const list = await f.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['search', 'get', 'contact', 'submit']);
  const notification = await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(notification.body, '');
  for (const params of [undefined, { name: 'get' }, { name: 'search', arguments: { query: 'Rust', top_n: 'abc' } }, { name: 'search', arguments: { query: 'Rust', top_n: null } }]) {
    const r = await f.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    assert.equal(r.body.error.code, -32602);
  }
  assert.equal((await f.request({}, {}, '/reindex')).status, 401);
  assert.equal((await f.request({}, { Authorization: 'Bearer local-admin-only' }, '/reindex', 'GET')).status, 405);
});
test('maintenance retains live quota and delegates private-request cleanup', async () => {
  const called = [];
  const app = load('src/index.ts', { modules: {
    './registry': {}, './candidates': { cleanupCandidates: async () => called.push('candidates') },
  } }).default;
  assert.equal(typeof app.scheduled, 'function', 'quota rows need a bounded retention path');
  const DB = database();
  DB.sql.prepare('INSERT INTO request_limits(scope,key,at) VALUES (?,?,?)').run('api', 'old', 0);
  DB.sql.prepare('INSERT INTO request_limits(scope,key,at) VALUES (?,?,?)').run('api', 'recent', Date.now());
  await app.scheduled({}, { DB });
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM request_limits').get().n, 1);
  assert.deepEqual(called, ['candidates']);
});
test('read-only MCP methods reject malformed params and notifications cannot execute tools', async () => {
  const f = fixture();
  for (const params of [null, [], 'invalid']) {
    const r = await f.request({ jsonrpc: '2.0', id: 1, method: 'ping', params });
    assert.equal(r.body.error.code, -32602);
  }
  const response = await f.request({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'submit', arguments: {} } });
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
});
module.exports = { fixture };
