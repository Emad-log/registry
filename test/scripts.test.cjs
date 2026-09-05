const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const path = require('node:path');

test('reindex automation fails HTTP and application errors, and verifies the published commit', async () => {
  let status = 401;
  let invalid = false;
  let healthy = true;
  const commit = 'a'.repeat(40);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: healthy, indexed: 0, commit }));
    } else {
      res.statusCode = status;
      res.end(JSON.stringify(status !== 200 ? { error: 'fixture_failure' } : invalid ? { indexed: 'wrong' } : { indexed: 0, excluded: 0, commit }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/reindex.cjs')], { env: {
      PATH: process.env.PATH, HIRES_ENDPOINT: `http://127.0.0.1:${server.address().port}`, HIRES_ADMIN_TOKEN: 'fixture-only', EXPECTED_COMMIT: commit,
    } });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  try {
    for (status of [401, 500]) assert.notEqual((await run()).code, 0);
    status = 200; invalid = true;
    assert.notEqual((await run()).code, 0);
    invalid = false; healthy = false;
    assert.notEqual((await run()).code, 0);
    healthy = true;
    const passed = await run();
    assert.equal(passed.code, 0, passed.output);
    assert.match(passed.output, /REINDEX_VERIFIED/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('smoke rejects a JSON-RPC response containing both result and error', async () => {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' }, error: { code: -32603, message: 'fixture failure' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '../scripts/smoke.cjs'), `http://127.0.0.1:${server.address().port}`]);
      let output = ''; child.stderr.on('data', part => { output += part; });
      child.stdout.resume(); child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /exactly one/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
