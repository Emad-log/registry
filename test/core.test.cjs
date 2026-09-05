const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, database } = require('./helpers.cjs');

test('core boundary exists and rejects ambiguous identifiers', () => {
  const file = path.join(__dirname, '../src/core.ts');
  assert.ok(fs.existsSync(file), 'shared boundary must exist before accepting public input');
  const core = load('src/core.ts');
  assert.equal(core.validId('jane-doe'), 'jane-doe');
  for (const id of ['Jane Doe', '../jane', '', '-jane', 'jane-', null, 1]) {
    assert.throws(() => core.validId(id), error => error.code === 'invalid_params');
  }
});

test('quota reservations are atomic across concurrent requests and scopes', async () => {
  const core = load('src/core.ts');
  assert.equal(typeof core.rateLimit, 'function', 'public work must reserve quota atomically');
  const DB = database();
  const env = { DB };
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => core.rateLimit(env, 'contact', 'same-ip', 20, 3600000)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'rate_limited'));
  await core.rateLimit(env, 'search', 'same-ip', 1, 3600000);
  await core.rateLimit(env, 'contact', 'other-ip', 1, 3600000);
  DB.sql.prepare('UPDATE request_limits SET at = 0').run();
  await core.rateLimit(env, 'contact', 'same-ip', 20, 3600000);
});

test('GitHub boundary refuses foreign paths and redirects without leaking credentials', async () => {
  const calls = [];
  const core = load('src/core.ts', { fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 302, headers: { location: 'https://foreign.example' } });
  } });
  assert.equal(typeof core.github, 'function');
  const env = { GITHUB_REPO: 'fixture/registry', GITHUB_TOKEN: 'fixture-private-token' };
  for (const route of ['https://foreign.example', '//foreign.example', '/../other']) {
    await assert.rejects(() => core.github(env, route));
  }
  assert.equal(calls.length, 0);
  const result = await core.github(env, '/git/ref/heads/main');
  assert.equal(result.status, 302);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].url, 'https://api.github.com/repos/fixture/registry/git/ref/heads/main');
  assert.equal(await core.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const response = core.json({ ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('public text boundary catches plain and encoded email without rejecting safe Unicode', () => {
  const core = load('src/core.ts');
  for (const value of ['contact: alice@example.test', 'alice%40example.test', 'alice&#64;example.test', 'alice&commat;example.test', 'mailto:alice%2540example.test', String.fromCharCode(0x2014)]) {
    assert.equal(core.privateText(value), true, value);
  }
  for (const value of ['improved 20%: alice%40example.test', 'bad%zz mailto%3Aalice%40example.test', 'alice%2540example.test after 30% improvement']) {
    assert.equal(core.privateText(value), true, 'malformed percent elsewhere must not disable screening');
  }
  const start = performance.now();
  assert.equal(core.privateText('x'.repeat(32768)), false);
  assert.ok(performance.now() - start < 1000, 'public text screening must be linear for text without addresses');
  assert.equal(core.privateText('# José 東京 🚀\nBuilt a compiler'), false);
  for (const value of [null, [], true, 'x']) assert.throws(() => core.object(value));
  for (const value of [null, 7, '', ' ', 'bad\u0000']) assert.throws(() => core.text(value, 'content', 10));
  assert.equal(core.text('hello\nworld', 'content', 20), 'hello\nworld');
});
