const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, reply, blobSha } = require('./candidate-support.cjs');

test('candidate create update and remove integrate with published search and contact', async () => {
  const s = setup();
  s.clock.now = Date.now();
  const registry = s.load('registry');
  const app = s.load('index').default;
  s.env.AI = { run: async () => ({ data: [[1, ...Array(767).fill(0)]], shape: [1, 768] }) };
  const originalFetch = s.gh.fetch.bind(s.gh);
  s.gh.fetch = async (url, init) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace('/repos/fixture/registry', '');
    if (route === '/git/ref/heads/main') return reply({ object: { type: 'commit', sha: s.gh.commit } });
    if (route === '/git/commits/' + s.gh.commit) return reply({ sha: s.gh.commit, tree: { sha: 'c'.repeat(40) } });
    if (route === '/git/trees/' + 'c'.repeat(40)) return reply({ sha: 'c'.repeat(40), truncated: false, tree: Array.from(s.gh.main, ([file, content]) => ({ path: file, type: 'blob', mode: '100644', sha: blobSha(content), size: Buffer.byteLength(content) })) });
    if (route.startsWith('/git/blobs/')) {
      const content = Array.from(s.gh.main.values()).find(value => blobSha(value) === route.split('/').at(-1));
      assert.ok(content);
      return reply({ sha: blobSha(content), encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
    }
    if (route.startsWith('/contents/') && parsed.searchParams.get('ref') === s.gh.commit) s.gh.snapshots.set(s.gh.commit, new Map(s.gh.main));
    return originalFetch(url, init);
  };
  const owner = { name: 'lifecycle-fixture', email: 'owner@example.test', content: '# Fictional lifecycle fixture\nJosé 東京 🚀\nRust and distributed systems.' };
  const first = await s.submit(owner);
  const one = await s.submit({ request_id: first.request_id, code: s.code() });
  assert.equal(one.status, 'pending_review');
  assert.equal((await registry.health(s.env)).indexed, 0);
  s.gh.merge(0);
  const indexed = await registry.reindex(s.env);
  assert.equal(indexed.indexed, 1);
  assert.equal((await registry.getResume(s.env, owner.name)).resume, owner.content);
  assert.equal((await s.contact(owner.name)).email, owner.email);
  const found = await registry.search(s.env, 'Rust', 10, 'fixture-recruiter');
  assert.equal(found[0].id, owner.name);
  assert.ok(!JSON.stringify(found).includes(owner.email));
  s.clock.now += 100;
  const second = await s.submit({ ...owner, content: owner.content + '\nUpdated work.' });
  const two = await s.submit({ request_id: second.request_id, code: s.code() });
  assert.equal(two.status, 'pending_review');
  s.gh.merge(1);
  await registry.reindex(s.env);
  assert.match((await registry.getResume(s.env, owner.name)).resume, /Updated work/);
  s.clock.now += 100;
  const last = await s.submit({ action: 'remove', name: owner.name, email: owner.email });
  const gone = await s.submit({ request_id: last.request_id, code: s.code() });
  assert.ok(gone.status === 'pending_review' || gone.status === 'removed');
  await assert.rejects(() => s.contact(owner.name), e => e.code === 'not_found');
  await assert.rejects(() => registry.getResume(s.env, owner.name), e => e.code === 'not_found');
  s.gh.merge(2);
  assert.equal((await registry.reindex(s.env)).indexed, 0);
  assert.equal((await registry.search(s.env, 'Rust', 10, 'fixture-recruiter')).length, 0);
  const response = await app.fetch(new Request('https://hires.md/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get', arguments: { id: owner.name } } }) }), s.env);
  const body = await response.json();
  assert.equal(body.result.isError, true);
});
