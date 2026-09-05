const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, reply, blobSha } = require('./candidate-support.cjs');
const owner = { name: 'review-fixture', email: 'owner@example.test', content: '# Explicitly fictional review fixture\nRust systems work.' };
const codeIs = code => e => e.code === code;
const settle = p => p.then(value => ({ ok: true, value }), e => ({ ok: false, code: e.code, message: e.message }));
function evidence(_name, _data) {}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function bridge(s) {
  s.clock.now = Date.now();
  s.env.AI = { run: async () => ({ data: [[1, ...Array(767).fill(0)]], shape: [1, 768] }) };
  const fetch = s.gh.fetch.bind(s.gh);
  const trees = new Map();
  const blobs = new Map();
  s.gh.fetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.ok(parsed.pathname.startsWith('/repos/fixture/registry/'));
    const route = parsed.pathname.slice('/repos/fixture/registry'.length);
    if (route === '/git/ref/heads/main') {
      s.gh.snapshots.set(s.gh.commit, new Map(s.gh.main));
      return reply({ object: { type: 'commit', sha: s.gh.commit } });
    }
    if (route.startsWith('/git/commits/')) {
      const commit = route.split('/').at(-1);
      const files = s.gh.snapshots.get(commit);
      assert.ok(files);
      const sha = require('node:crypto').createHash('sha1').update(JSON.stringify([...files])).digest('hex');
      trees.set(sha, [...files].map(([file, content]) => {
        blobs.set(blobSha(content), content);
        return { path: file, type: 'blob', mode: '100644', sha: blobSha(content), size: Buffer.byteLength(content) };
      }));
      return reply({ sha: commit, tree: { sha } });
    }
    if (route.startsWith('/git/trees/')) {
      const sha = route.split('/').at(-1);
      assert.ok(trees.has(sha));
      return reply({ sha, truncated: false, tree: trees.get(sha) });
    }
    if (route.startsWith('/git/blobs/')) {
      const sha = route.split('/').at(-1);
      assert.ok(blobs.has(sha));
      const content = blobs.get(sha);
      return reply({ sha, encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
    }
    return fetch(url, init);
  };
  return s.load('registry');
}
async function confirmed(s, input = owner, key = 'fixture-ip') {
  const request = await s.submit(input, key);
  const code = s.code();
  const response = await s.submit({ request_id: request.request_id, code }, key);
  return { request, code, response };
}

test('restoring an identical blob stays unpublished until restoration PR merge and reindex', async () => {
  const s = setup(); const registry = bridge(s);
  await confirmed(s); s.gh.merge(0); await registry.reindex(s.env);
  const original = await registry.health(s.env);
  const removal = await confirmed(s, { name: owner.name, email: owner.email, action: 'remove' });
  await assert.rejects(s.contact(owner.name), codeIs('not_found'));
  s.gh.merge(1);
  assert.equal(s.gh.main.has('resumes/' + owner.name + '.md'), false);
  s.clock.now += 900001;
  const restore = await confirmed(s);
  assert.equal(restore.response.status, 'pending_review');
  assert.equal(s.gh.prs[2].state, 'open');
  const app = s.load('index').default;
  const read = async route => {
    const response = await app.fetch(new Request('https://review.invalid/' + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: owner.name }),
    }), s.env);
    const value = await response.json();
    return { status: response.status, body: value };
  };
  const get = await read('get'); const contact = await read('contact');
  const health = await registry.health(s.env);
  const search = await registry.search(s.env, 'Rust', 10, 'review-search');
  evidence('restore-same-blob', { original, removed: removal.response, restore: restore.response,
    mainContainsResume: s.gh.main.has('resumes/' + owner.name + '.md'), restorationPr: s.gh.prs[2],
    get, contact, health, search });
  assert.equal(get.status, 404, 'Pending restoration must not expose a stale pre-removal index row');
  assert.equal(contact.status, 404);
  assert.equal(search.length, 0);
});

test('two distinct concurrent removals leave at least one retryable deletion request', async () => {
  const s = setup(); await confirmed(s); s.gh.merge(0);
  const ra = await s.submit({ name: owner.name, email: owner.email, action: 'remove' }, 'ip-a'); const ca = s.code();
  const rb = await s.submit({ name: owner.name, email: owner.email, action: 'remove' }, 'ip-b'); const cb = s.code();
  const arrived = deferred(); const release = deferred();
  const prepare = s.db.prepare.bind(s.db); let held = 0;
  s.db.prepare = sql => {
    const stmt = prepare(sql);
    if (sql === 'SELECT email FROM candidates WHERE id = ?') {
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        const bound = bind(...args); const first = bound.first.bind(bound);
        bound.first = async (...rest) => {
          const result = await first(...rest);
          if (++held <= 2) { if (held === 2) arrived.resolve(); await release.promise; }
          return result;
        };
        return bound;
      };
    }
    return stmt;
  };
  const a = settle(s.submit({ request_id: ra.request_id, code: ca }, 'ip-a'));
  const b = settle(s.submit({ request_id: rb.request_id, code: cb }, 'ip-b'));
  await arrived.promise; release.resolve();
  const initial = await Promise.all([a, b]);
  const retry = [await settle(s.submit({ request_id: ra.request_id, code: ca }, 'ip-a')),
    await settle(s.submit({ request_id: rb.request_id, code: cb }, 'ip-b'))];
  const rows = s.db.rows('SELECT request_id,action,superseded,completed,pr_url FROM candidate_requests WHERE action = ?', 'remove');
  const candidate = s.db.row('SELECT active,pending_request FROM candidates');
  evidence('concurrent-removals', { initial, retry, rows, candidate, prs: s.gh.prs,
    mainContainsResume: s.gh.main.has('resumes/' + owner.name + '.md') });
  assert.equal(candidate.active, 0);
  assert.ok(retry.some(r => r.ok), 'At least one verified removal must survive to complete the deletion PR');
});

test('restoration cannot expose an older in-flight index generation', async () => {
  const s = setup(); const registry = bridge(s);
  await confirmed(s); s.gh.merge(0); await registry.reindex(s.env);
  const old = s.db.row('SELECT * FROM registry_resumes');
  s.db.sqlite.prepare('UPDATE registry_state SET next_generation = next_generation + 1').run();
  const inFlight = s.db.row('SELECT next_generation FROM registry_state').next_generation;
  await confirmed(s, { name: owner.name, email: owner.email, action: 'remove' });
  s.gh.merge(1);
  s.clock.now += 900001;
  await confirmed(s);
  s.db.sqlite.prepare('INSERT INTO registry_resumes(generation,id,sha,content,embedding) VALUES(?,?,?,?,?)')
    .run(inFlight, old.id, old.sha, old.content, old.embedding);
  s.db.sqlite.prepare('UPDATE registry_state SET current_generation = ?').run(inFlight);
  await assert.rejects(registry.getResume(s.env, owner.name), codeIs('not_found'));
  await assert.rejects(s.contact(owner.name), codeIs('not_found'));
});

test('security control: competing verified mailboxes cannot acquire the same candidate', async () => {
  const s = setup();
  const a = await s.submit(owner); const ca = s.code();
  const b = await s.submit({ ...owner, email: 'other@example.test' }, 'other-ip'); const cb = s.code();
  const result = await Promise.all([
    settle(s.submit({ request_id: a.request_id, code: ca })),
    settle(s.submit({ request_id: b.request_id, code: cb }, 'other-ip')),
  ]);
  assert.equal(result.filter(r => r.ok).length, 1);
  assert.equal(result.filter(r => r.code === 'owner_mismatch').length, 1);
  assert.equal(s.gh.prs.length, 1);
  assert.equal(s.db.row('SELECT count(*) AS n FROM candidates').n, 1);
  evidence('ownership-control', { result, publicPrCount: s.gh.prs.length, candidateCount: 1 });
});

test('security control: removal between public write and database approval prevents update publication', async () => {
  const s = setup(); const registry = bridge(s);
  await confirmed(s); s.gh.merge(0); await registry.reindex(s.env);
  const update = await s.submit({ ...owner, content: owner.content + '\nUnmerged update' }); const updateCode = s.code();
  const entered = deferred(); const release = deferred(); let once = true;
  s.gh.after = async call => {
    if (once && call.route === '/pulls' && call.method === 'POST') { once = false; entered.resolve(); await release.promise; }
  };
  const updating = settle(s.submit({ request_id: update.request_id, code: updateCode }));
  await entered.promise;
  const removal = await s.submit({ name: owner.name, email: owner.email, action: 'remove' }); const removalCode = s.code();
  const blocked = await settle(s.submit({ request_id: removal.request_id, code: removalCode }));
  assert.equal(blocked.code, 'submission_busy');
  await assert.rejects(registry.getResume(s.env, owner.name), codeIs('not_found'));
  await assert.rejects(s.contact(owner.name), codeIs('not_found'));
  release.resolve(); const stopped = await updating;
  assert.equal(stopped.code, 'submission_busy');
  const removed = await s.submit({ request_id: removal.request_id, code: removalCode });
  assert.equal(removed.status, 'pending_review');
  assert.equal(s.gh.prs[1].state, 'closed');
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
  await assert.rejects(s.submit({ request_id: update.request_id, code: updateCode }), codeIs('request_superseded'));
  evidence('removal-fence-control', { blocked, stopped, removed, supersededPrClosed: s.gh.prs[1].state === 'closed' });
});

test('security control: plain and ordinary encoded contact cannot reach public writes', async () => {
  const attempts = ['plain@example.test', 'plain%40example.test', 'plain&#x40;example.test',
    'plain&commat;example.test', 'bad%zz plain%2540example.test', 'plain%26%23x40%3bexample.test',
    'plain%252540example.test', 'mailto%3Aaddress', 'plain&#37;40example.test'];
  for (const content of attempts) {
    const s = setup();
    await assert.rejects(s.submit({ ...owner, content }), codeIs('invalid_params'));
    assert.equal(s.gh.calls.length, 0); assert.equal(s.mail.calls.length, 0);
  }
  evidence('privacy-control', { attempted: attempts.length, rejectedBeforeMailAndGitHub: attempts.length });
});
