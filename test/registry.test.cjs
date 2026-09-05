const test = require('node:test');
const assert = require('node:assert/strict');
const { registry, load, setup, vector } = require('./registry-support.cjs');

test('health and get quarantine legacy records and expose only the active verified generation', async t => {
  const { env, DB, approve, upstream } = setup(t, { alice: '# Alice: Rust' });
  const api = registry();
  assert.equal(typeof api.health, 'function', 'health export must be implemented');
  DB.sql.prepare('INSERT INTO resumes(id,content,updated_at) VALUES(?,?,0)').run('legacy', 'private@example.test');
  DB.sql.prepare('INSERT INTO emails(id,email) VALUES(?,?)').run('alice', 'wrong@example.test');
  assert.deepEqual(await api.health(env), { ok: true, indexed: 0, commit: null });
  await assert.rejects(api.getResume(env, 'legacy'), { status: 404, code: 'not_found' });
  approve('alice');
  DB.sql.prepare('INSERT INTO registry_resumes(generation,id,sha,content,embedding) VALUES(1,?,?,?,?)').run('alice', upstream.blobs[0].sha, '# Alice: Rust', new Uint8Array(new Float32Array(vector()).buffer));
  DB.sql.exec("UPDATE registry_state SET current_generation=1, commit_sha='commit-fixture' WHERE id=1");
  assert.deepEqual(await api.getResume(env, 'alice'), { id: 'alice', resume: '# Alice: Rust' });
  assert.deepEqual(await api.health(env), { ok: true, indexed: 1, commit: 'commit-fixture' });
  DB.sql.exec('UPDATE candidates SET active=0');
  await assert.rejects(api.getResume(env, 'alice'), { status: 404 });
  assert.equal((await api.health(env)).indexed, 0);
  DB.sql.exec('UPDATE candidates SET active=1; DELETE FROM candidate_versions');
  await assert.rejects(api.getResume(env, 'alice'), { status: 404 });
  await assert.rejects(api.getResume(env, '../alice'), { status: 400 });
});

test('reindex publishes immutable verified Unicode blobs and excludes unverified source files', async t => {
  const { env, DB, upstream, approve, aiCalls } = setup(t, { alice: '# Alice: José 東京 🦀', intruder: '# Not verified' });
  const api = registry();
  assert.equal(typeof api.reindex, 'function', 'reindex export must be implemented');
  approve('alice');
  const result = await api.reindex(env, upstream.commit);
  assert.deepEqual(result, { indexed: 1, excluded: 1, commit: upstream.commit });
  assert.deepEqual(await api.getResume(env, 'alice'), { id: 'alice', resume: '# Alice: José 東京 🦀' });
  await assert.rejects(api.getResume(env, 'intruder'), { status: 404 });
  assert.deepEqual(await api.health(env), { ok: true, indexed: 1, commit: upstream.commit });
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_fts').get().n, 1);
  assert.equal(DB.sql.prepare('SELECT length(embedding) AS n FROM registry_resumes').get().n, 3072);
  assert.equal(aiCalls.length, 1);
  assert.ok(upstream.calls.every(c => !c.path.includes('/contents/') && !c.path.endsWith('/trees/main')));
});

test('upstream failures cannot replace an already published complete snapshot', async t => {
  const { env, DB, upstream, approve } = setup(t, { alice: '# Alice: Rust' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  const original = await api.health(env);
  const corruptions = [
    ['truncated tree', url => url.pathname.includes('/trees/') ? Response.json({ sha: upstream.tree, truncated: true, tree: [] }) : null],
    ['missing tree fields', url => url.pathname.includes('/trees/') ? Response.json({ sha: upstream.tree }) : null],
    ['tree HTTP failure', url => url.pathname.includes('/trees/') ? Response.json({ message: 'failure' }, { status: 503 }) : null],
    ['blob HTTP failure', url => url.pathname.includes('/blobs/') ? Response.json({ message: 'failure' }, { status: 404 }) : null],
    ['invalid UTF-8', url => url.pathname.includes('/blobs/') ? Response.json({ sha: upstream.blobs[0].sha, size: 2, encoding: 'base64', content: '/8M=' }) : null],
    ['wrong blob hash', url => url.pathname.includes('/blobs/') ? Response.json({ sha: upstream.blobs[0].sha, size: 5, encoding: 'base64', content: 'd3Jvbmc=' }) : null],
    ['bad JSON', url => url.pathname.includes('/trees/') ? new Response('{no') : null],
  ];
  for (const [label, override] of corruptions) {
    upstream.override = override;
    await assert.rejects(api.reindex(env), e => e.status >= 400 && typeof e.code === 'string', label);
    assert.deepEqual(await api.health(env), original, label);
    assert.equal((await api.getResume(env, 'alice')).resume, '# Alice: Rust', label);
  }
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 1);
});

test('bounded public source rejects private text, oversized files, oversized trees and corpus overflow', async t => {
  for (const content of ['reference@example.test', '[mail](mailto:secret%40example.test)', 'secret&#64;example.test', 'x'.repeat(32769), '', '\u0000', String.fromCharCode(0x2014), Buffer.from([0xff])]) {
    await t.test(`reject payload ${typeof content === 'string' ? content.length : 'invalid UTF8'}`, async t => {
      const { env, approve, aiCalls } = setup(t, { alice: content });
      approve('alice');
      await assert.rejects(registry().reindex(env), e => e.status >= 400 && typeof e.code === 'string');
      assert.equal((await registry().health(env)).indexed, 0);
      assert.equal(aiCalls.length, 0);
    });
  }
  await t.test('bounded tree response before JSON parse', async t => {
    const { env, upstream } = setup(t);
    upstream.override = url => url.pathname.includes('/trees/') ? new Response(' '.repeat(262145)) : null;
    await assert.rejects(registry().reindex(env), { code: 'capacity_exceeded' });
  });
  await t.test('launch capacity is 100 source resumes', async t => {
    const { env, upstream, aiCalls } = setup(t, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`person-${i}`, '# Fixture'])));
    await assert.rejects(registry().reindex(env), { code: 'capacity_exceeded' });
    assert.equal(aiCalls.length, 0);
    assert.equal(upstream.calls.filter(c => c.path.includes('/blobs/')).length, 0);
  });
});

test('D1 lease serializes indexers and fences expired holders without resurrecting deleted content', async t => {
  const { env, DB, upstream, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  let resume;
  let entered;
  const blocked = new Promise(resolve => { resume = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  env.AI.run = async () => { if (++calls === 1) { entered(); await blocked; } return { data: [vector()] }; };
  t.after(() => resume());
  const old = api.reindex(env);
  await started;
  const before = upstream.calls.length;
  await assert.rejects(api.reindex(env), { code: 'index_busy', status: 409 });
  assert.equal(upstream.calls.length, before, 'competing lease fails before outbound work');
  DB.sql.exec('UPDATE registry_state SET lock_until=0; UPDATE candidates SET active=0');
  assert.deepEqual(await api.reindex(env), { indexed: 0, excluded: 1, commit: upstream.commit });
  resume();
  await assert.rejects(old, { code: 'index_lease_lost', status: 409 });
  assert.equal((await api.health(env)).indexed, 0);
  await assert.rejects(api.getResume(env, 'alice'), { status: 404 });
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 0);
  assert.equal(DB.sql.prepare('SELECT lock_token FROM registry_state').get().lock_token, null);
});

test('expectedCommit validates exact current ref and refuses stale or moving CI targets', async t => {
  const { env, upstream, approve, aiCalls } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  for (const expected of ['short', 'A'.repeat(40), null, 3]) {
    await assert.rejects(api.reindex(env, expected), { status: 400, code: 'invalid_params' });
  }
  assert.equal(upstream.calls.length, 0);
  await assert.rejects(api.reindex(env, 'c'.repeat(40)), { status: 409, code: 'commit_mismatch' });
  assert.equal(aiCalls.length, 0);
  let reads = 0;
  upstream.override = url => url.pathname.includes('/git/ref/') && ++reads === 2 ? Response.json({ object: { type: 'commit', sha: 'c'.repeat(40) } }) : null;
  await assert.rejects(api.reindex(env, upstream.commit), { status: 409, code: 'commit_mismatch' });
  assert.equal((await api.health(env)).commit, null);
});

test('embeddings are reused by SHA and invalid AI vectors never replace published data', async t => {
  const { env, DB, approve, aiCalls } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  await api.reindex(env);
  assert.equal(aiCalls.length, 1, 'unchanged SHA reuses stored embedding');
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 1);
  for (const data of [[vector().slice(1)], [[...vector().slice(1), NaN]], [[...vector().slice(1), Infinity]], [[...vector().slice(1), 1e100]], [Array(768).fill(0)], [[...vector().slice(1), '1']], [], [vector(), vector()]]) {
    DB.sql.exec("UPDATE registry_resumes SET sha='unapproved' ");
    env.AI.run = async () => ({ data });
    const before = await api.health(env);
    await assert.rejects(api.reindex(env), { code: 'invalid_embedding' });
    assert.deepEqual(await api.health(env), before);
    assert.equal(DB.sql.prepare('SELECT lock_token FROM registry_state').get().lock_token, null);
  }
  env.AI.run = async () => { throw new Error('synthetic AI outage'); };
  await assert.rejects(api.reindex(env), { status: 503, code: 'ai_unavailable' });
});

test('search ranks real active resumes without URL boosts or query logging and rechecks ownership after AI', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Systems expert', bob: '# Systems learner https://dead.test https://dead.test https://dead.test' });
  approve('alice'); approve('bob');
  env.AI.run = async (_model, args) => ({ data: [args.text[0].includes('learner') ? vector(0.95, 0.3) : vector()] });
  const api = registry();
  await api.reindex(env);
  const rows = await api.search(env, 'systems', 5, 'fixture-ip');
  assert.deepEqual(rows.map(r => r.id), ['alice', 'bob']);
  assert.ok(rows.every(r => Number.isFinite(r.score) && r.resume.startsWith('# Systems')));
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM query_log').get().n, 0);
  env.AI.run = async () => { DB.sql.exec("UPDATE candidates SET active=0 WHERE id='alice'"); return { data: [vector()] }; };
  assert.deepEqual((await api.search(env, 'systems', 5, 'fixture-ip')).map(r => r.id), ['bob']);
  DB.sql.exec('DELETE FROM candidate_versions');
  assert.deepEqual(await api.search(env, 'systems', 5, 'fixture-ip'), []);
});

test('public search validates finite bounded inputs and reserves atomic per-IP and global AI budgets', async t => {
  const { env, DB, approve, aiCalls } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  for (const [query, top] of [['', 5], ['x'.repeat(2001), 5], [null, 5], ['\u0000', 5], ['x', NaN], ['x', Infinity], ['x', 0], ['x', 31], ['x', 2.5], ['x', '5']]) {
    await assert.rejects(api.search(env, query, top, 'fixture-ip'), { status: 400, code: 'invalid_params' });
  }
  assert.equal(aiCalls.length, 0);
  await api.reindex(env);
  for (let i = 0; i < 30; i++) await api.search(env, 'x', 1, 'fixture-ip');
  const before = aiCalls.length;
  await assert.rejects(api.search(env, 'x', 1, 'fixture-ip'), { status: 429, code: 'rate_limited' });
  assert.equal(aiCalls.length, before);
  DB.sql.exec('DELETE FROM request_limits');
  DB.sql.prepare('INSERT INTO request_limits(scope,key,at) VALUES(?,?,?)').run('search-global', 'all', Date.now());
  DB.sql.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<299) INSERT INTO request_limits(scope,key,at) SELECT 'search-global','all',unixepoch()*1000 FROM n");
  await assert.rejects(api.search(env, 'x', 1, 'different-ip'), { status: 429, code: 'rate_limited' });
  assert.equal(aiCalls.length, before);
});

test('read boundaries reject over-capacity state and malformed persisted vector bytes', async t => {
  const { env, DB, approve, upstream, aiCalls } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  for (const mode of ['array', 'buffer', 'view']) {
    DB.blobMode = mode;
    assert.equal((await api.search(env, 'x', 1, `ip-${mode}`))[0].id, 'alice');
  }
  DB.sql.exec("UPDATE registry_resumes SET embedding=X'00'");
  await assert.rejects(api.search(env, 'x', 1, 'bad-vector'), { code: 'invalid_embedding' });
  const bytes = new Uint8Array(new Float32Array(vector()).buffer);
  DB.sql.prepare('UPDATE registry_resumes SET embedding=?').run(bytes);
  for (let i = 0; i < 100; i++) {
    DB.sql.prepare('INSERT INTO candidates(id,email,active,created_at) VALUES(?,?,1,0)').run(`added-${i}`, 'fixture@example.test');
    DB.sql.prepare('INSERT INTO candidate_versions(candidate_id,blob_sha) VALUES(?,?)').run(`added-${i}`, upstream.blobs[0].sha);
    DB.sql.prepare('INSERT INTO registry_resumes(generation,id,sha,content,embedding) VALUES(1,?,?,?,?)').run(`added-${i}`, upstream.blobs[0].sha, '# Fixture', bytes);
  }
  const before = aiCalls.length;
  await assert.rejects(api.search(env, 'x', 1, 'overflow'), { code: 'capacity_exceeded' });
  assert.equal(aiCalls.length, before, 'overflow is rejected before paid inference');
});

test('full text keywords break semantic ties while AI uses an explicit bounded excerpt', async t => {
  const { env, DB, approve, aiCalls } = setup(t, { alice: '# Generalist', bob: '# Engineer\n' + 'Experience '.repeat(400) + '\nPostgreSQL tuning' });
  approve('alice'); approve('bob');
  const api = registry();
  await api.reindex(env);
  assert.ok(aiCalls.every(call => Buffer.byteLength(call.args.text[0]) <= 480), 'semantic excerpt is limited to 480 UTF-8 bytes');
  const results = await api.search(env, 'PostgreSQL', 5, 'fixture-ip');
  assert.deepEqual(results.map(row => row.id), ['bob', 'alice']);
  assert.ok(results[0].score - results[1].score < 0.001);
  assert.ok(results[0].resume.endsWith('PostgreSQL tuning'), 'public get/search retains the full resume');
  await assert.rejects(api.search(env, 'x'.repeat(1001), 5, 'fixture-ip'), { status: 400 });
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM query_log').get().n, 0);
});

test('daily global AI quota cannot be bypassed by different IPs', async t => {
  const { env, DB, approve, aiCalls } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  DB.sql.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO request_limits(scope,key,at) SELECT 'search-daily','all',unixepoch()*1000 FROM n");
  const before = aiCalls.length;
  const responses = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => api.search(env, 'x', 1, `ip-${i}`)));
  assert.ok(responses.every(r => r.status === 'rejected' && r.reason.code === 'rate_limited'));
  assert.equal(aiCalls.length, before);
});

test('bounded staging rolls back publication on SQL failure and leaves no stale generation', async t => {
  const files = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`person-${i}`, `# Fixture ${i}`]));
  const { env, DB, approve } = setup(t, files);
  for (const id of Object.keys(files)) approve(id);
  const api = registry();
  const originalBatch = DB.batch;
  DB.batch = async statements => { assert.ok(statements.length <= 20, 'stage at most 20 statements per batch'); return originalBatch(statements); };
  await api.reindex(env);
  const before = await api.health(env);
  let inserts = 0;
  DB.fault = query => { if (query.startsWith('INSERT INTO registry_resumes') && ++inserts === 22) throw new Error('synthetic D1 write outage'); };
  await assert.rejects(api.reindex(env), { code: 'registry_unavailable', status: 503 });
  DB.fault = null;
  assert.deepEqual(await api.health(env), before);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 25);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_fts').get().n, 25);
  assert.equal(DB.sql.prepare('SELECT lock_token FROM registry_state').get().lock_token, null);
});

test('malformed tree entries fail closed rather than being treated as deleted candidates', async t => {
  const { env, upstream, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  const before = await api.health(env);
  const good = { path: 'resumes/alice.md', type: 'blob', mode: '100644', sha: upstream.blobs[0].sha, size: upstream.blobs[0].bytes.length };
  for (const entries of [[{ ...good, type: ['blob'] }], [{ ...good, type: 'unknown' }], [{ ...good, mode: '120000' }], [{ ...good, size: undefined }], [{ ...good, size: 1 }], [good, good]]) {
    upstream.override = url => url.pathname.includes('/trees/') ? Response.json({ sha: upstream.tree, truncated: false, tree: entries }) : null;
    await assert.rejects(api.reindex(env), { code: 'invalid_source' });
    assert.deepEqual(await api.health(env), before);
  }
});

test('serialized D1 bytes and AI metadata are validated without coercion', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  const originalBatch = DB.batch;
  const validBytes = Array.from(new Uint8Array(new Float32Array(vector()).buffer));
  const malformed = [[...validBytes.slice(1), 256], [...validBytes.slice(1), -1], [...validBytes.slice(1), 1.1], [...validBytes.slice(1), '1'], validBytes.slice(1), Array(3072)];
  malformed[5][2] = 128; malformed[5][3] = 63;
  for (const bytes of malformed) {
    DB.batch = async statements => {
      const results = await originalBatch(statements);
      for (const result of results) for (const row of result.results) if ('embedding' in row) row.embedding = bytes;
      return results;
    };
    await assert.rejects(api.search(env, 'x', 1, 'fixture-ip'), { code: 'invalid_embedding' });
  }
  DB.batch = originalBatch;
  env.AI.run = async () => ({ shape: [2, 384], data: [vector()] });
  await assert.rejects(api.search(env, 'x', 1, 'fixture-ip'), { code: 'invalid_embedding' });
});

test('removal during indexing is omitted from publication counts and stored generation', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  env.AI.run = async () => { DB.sql.exec('UPDATE candidates SET active=0'); return { data: [vector()] }; };
  const result = await registry().reindex(env);
  assert.equal(result.indexed, 0);
  assert.equal(result.excluded, 1);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 0);
});

test('indexing stops further AI work once lease ownership is lost', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Alice', bob: '# Bob' });
  approve('alice'); approve('bob');
  let calls = 0;
  env.AI.run = async () => {
    if (++calls === 1) DB.sql.exec('UPDATE registry_state SET lock_until=0');
    return { data: [vector()] };
  };
  await assert.rejects(registry().reindex(env), { code: 'index_lease_lost' });
  assert.equal(calls, 1, 'stale indexer must stop before the next inference');
});

test('public reads reject corrupt oversized or private persisted content', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  const api = registry();
  await api.reindex(env);
  for (const value of ['wrong-reference@example.test', 'x'.repeat(32769)]) {
    DB.sql.prepare('UPDATE registry_resumes SET content=?').run(value);
    await assert.rejects(api.getResume(env, 'alice'), { code: 'invalid_source' });
    await assert.rejects(api.search(env, 'x', 1, 'fixture-ip'), { code: 'invalid_source' });
  }
});

test('identical blobs share one embedding within a new snapshot', async t => {
  const { env, approve, aiCalls } = setup(t, { alice: '# Shared fixture', bob: '# Shared fixture' });
  approve('alice'); approve('bob');
  assert.equal((await registry().reindex(env)).indexed, 2);
  assert.equal(aiCalls.length, 1);
});

test('AI requests include a deadline rather than holding a lease indefinitely', async t => {
  const { env, approve } = setup(t, { alice: '# Alice' });
  approve('alice');
  let options;
  env.AI.run = async (_model, _args, passed) => { options = passed; return { data: [vector()] }; };
  await registry().reindex(env);
  assert.ok(options?.signal instanceof AbortSignal);
});

test('empty public corpus returns no candidates without inference or impression logging', async t => {
  const { env, aiCalls, DB } = setup(t);
  assert.deepEqual(await registry().search(env, 'rust', 5, 'fixture-ip'), []);
  assert.equal(aiCalls.length, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM query_log').get().n, 0);
});

test('candidate contact integration never discloses legacy, unverified or withdrawn ownership', async t => {
  const { env, DB, approve } = setup(t, { alice: '# Alice' });
  const api = registry();
  const { contact } = load('candidates');
  DB.sql.prepare('INSERT INTO emails(id,email) VALUES(?,?)').run('alice', 'wrong-reference@example.test');
  await assert.rejects(contact(env, 'alice', 'fixture-ip'), { status: 404 });
  approve('alice', 'verified-owner@example.test');
  await assert.rejects(contact(env, 'alice', 'fixture-ip'), { status: 404 });
  await api.reindex(env);
  assert.deepEqual(await contact(env, 'alice', 'fixture-ip'), { id: 'alice', email: 'verified-owner@example.test' });
  DB.sql.exec('DELETE FROM candidate_versions');
  await assert.rejects(contact(env, 'alice', 'fixture-ip'), { status: 404 });
  approve('alice');
  DB.sql.exec('UPDATE candidates SET active=0');
  await assert.rejects(contact(env, 'alice', 'fixture-ip'), { status: 404 });
});

test('expired partially staged generation cannot overwrite a newer published generation', async t => {
  const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`person-${i}`, '# Shared fixture']));
  const { env, DB, approve } = setup(t, files);
  for (const id of Object.keys(files)) approve(id);
  const api = registry();
  const batch = DB.batch;
  let continueOld;
  let staged;
  const pause = new Promise(resolve => { continueOld = resolve; });
  const reached = new Promise(resolve => { staged = resolve; });
  let batches = 0;
  DB.batch = async statements => {
    const result = await batch(statements);
    if (statements.length === 20 && ++batches === 1) { staged(); await pause; }
    return result;
  };
  const old = api.reindex(env);
  await reached;
  assert.equal((await api.health(env)).indexed, 0);
  DB.sql.exec('UPDATE registry_state SET lock_until=0; UPDATE candidates SET active=0');
  await api.reindex(env);
  continueOld();
  await assert.rejects(old, { code: 'index_lease_lost' });
  assert.equal((await api.health(env)).indexed, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_resumes').get().n, 0);
  assert.equal(DB.sql.prepare('SELECT count(*) AS n FROM registry_fts').get().n, 0);
});

test('100-source launch boundary is executable with bounded batches and complete returned totals', async t => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`person-${i}`, (`# Fixture ${i}\n`).padEnd(32768, 'x ')]));
  const { env, DB, approve, upstream } = setup(t, files);
  for (const id of Object.keys(files)) approve(id);
  const originalBatch = DB.batch;
  DB.batch = async statements => { assert.ok(statements.length <= 20); return originalBatch(statements); };
  const api = registry();
  assert.deepEqual(await api.reindex(env), { indexed: 100, excluded: 0, commit: upstream.commit });
  assert.equal((await api.health(env)).indexed, 100);
  assert.equal((await api.search(env, 'fixture', 30, 'fixture-ip')).length, 30);
  const count = DB.sql.prepare('SELECT count(*) AS n FROM registry_fts').get().n;
  assert.equal(count, 100);
  assert.ok(DB.history.length < 1000, 'bounded local statements, not a remote latency benchmark');
});
