const assert = require('node:assert/strict');

async function main() {
  const endpoint = process.argv[2];
  assert.ok(endpoint, 'pass an explicit deployment URL; no production default');
  const base = new URL(endpoint);
  assert.ok(['https:', 'http:'].includes(base.protocol));
  let id = 0;
  async function rpc(method, params) {
    const requestId = ++id;
    const response = await fetch(new URL('/mcp', base), { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, requestId);
    assert.ok(('result' in body) !== ('error' in body), 'JSON-RPC response must contain exactly one of result or error');
    return body;
  }
  const initial = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1' } });
  assert.equal(initial.result.protocolVersion, '2025-06-18');
  const notification = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.result.tools.map(t => t.name), ['search', 'get', 'contact', 'submit']);
  assert.deepEqual((await rpc('ping')).result, {});
  const invalid = await rpc('tools/call', { name: 'search', arguments: { query: 'engineer', top_n: 'not-a-number' } });
  assert.equal(invalid.error.code, -32602);
  const unknown = await rpc('not-a-method');
  assert.equal(unknown.error.code, -32601);
  const health = await fetch(new URL('/health', base));
  assert.equal(health.status, 200);
  const state = await health.json();
  assert.equal(state.ok, true);
  assert.ok(Number.isInteger(state.indexed));
  const root = await fetch(base);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /MCP:/);
  const admin = await fetch(new URL('/reindex', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(admin.status, 401);
  console.log('SMOKE_PASSED', JSON.stringify({ indexed: state.indexed, commit: state.commit }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
