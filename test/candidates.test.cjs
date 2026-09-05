const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, reply, blobSha } = require('./candidate-support.cjs');
const input = { name: 'fixture-candidate', email: 'private@example.test', content: '# Fictional test candidate\nJosé 東京 ✅ 😀' };
const errorCode = code => error => error.code === code;

test('malformed identifiers and private public payloads are rejected rather than rewritten', async () => {
  const s = setup();
  for (const name of ['Jane Doe', 'Alice', '../alice', '-alice', 'alice-', 'a'.repeat(65), ' a']) {
    await assert.rejects(s.submit({ ...input, name }), errorCode('invalid_params'));
  }
  for (const content of ['Contact: private@example.test', '[mail](mailto:other@example.test)', 'other%40example.test', 'other&#64;example.test', '# Bad\u2014punctuation', '\ud800', 'x'.repeat(32769)]) {
    await assert.rejects(s.submit({ ...input, content }), errorCode('invalid_params'));
  }
  for (const args of [{ ...input, email: 'bad' }, { ...input, email: 'a@b.test\nBcc:x@y.test' }, { ...input, action: 'delete' }, { ...input, unknown: 'x' }, { ...input, content: null }, { ...input, action: 'remove' }]) {
    await assert.rejects(s.submit(args), errorCode('invalid_params'));
  }
  assert.equal(s.mail.calls.length, 0); assert.equal(s.gh.calls.length, 0);
});

test('mail send failure never leaves a confirmable challenge', async () => {
  for (const [status, body] of [[500, { message: 'failure' }], [200, {}], [202, { id: 'not-documented-success' }]]) {
    const s = setup(); s.mail.status = status; s.mail.body = body;
    await assert.rejects(s.submit(input), errorCode('mail_failed'));
    assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_requests').n, 0);
    assert.equal(s.gh.calls.length, 0);
  }
  const s = setup(); delete s.env.RESEND_API_KEY;
  await assert.rejects(s.submit(input), errorCode('mail_unavailable'));
  assert.equal(s.mail.calls.length, 0);
});

test('verified confirmation writes Unicode safely and retry returns the same private PR', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  const result = await s.submit({ request_id: request.request_id, code });
  assert.equal(result.status, 'pending_review'); assert.equal(result.id, input.name);
  assert.equal(result.pr_url, 'https://github.com/fixture/registry/pull/1');
  const branch = s.gh.prs[0].head.ref;
  assert.equal(s.gh.branches.get(branch).get(`resumes/${input.name}.md`), input.content);
  assert.equal(s.db.row('SELECT email FROM candidates WHERE id = ?', input.name).email, input.email);
  assert.equal(s.db.row('SELECT blob_sha FROM candidate_versions WHERE candidate_id = ?', input.name).blob_sha, blobSha(input.content));
  const writes = s.gh.calls.filter(c => c.method !== 'GET').length;
  assert.deepEqual(await s.submit({ request_id: request.request_id, code }), result);
  assert.equal(s.gh.calls.filter(c => c.method !== 'GET').length, writes);
  const publicWrites = JSON.stringify(s.gh.calls.filter(c => c.method !== 'GET'));
  assert.ok(!publicWrites.includes(input.email)); assert.ok(!publicWrites.includes(code));
  assert.ok(!branch.includes(request.request_id), 'Public branch names must not disclose private request IDs');
});

test('codes expire and five failed attempts lock the challenge atomically', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  const wrong = code === '00000000' ? '00000001' : '00000000';
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => s.submit({ request_id: request.request_id, code: wrong })));
  assert.ok(attempts.every(r => r.status === 'rejected' && r.reason.code === 'invalid_code'));
  await assert.rejects(s.submit({ request_id: request.request_id, code }), errorCode('invalid_code'));
  assert.equal(s.db.row('SELECT attempts FROM candidate_requests').attempts, 5);
  assert.equal(s.gh.calls.length, 0);
  const expired = setup(); const req = await expired.submit(input); expired.clock.now += 900000;
  await assert.rejects(expired.submit({ request_id: req.request_id, code: expired.code() }), errorCode('invalid_code'));
  for (const args of [{ request_id: req.request_id, code: 12345678 }, { request_id: req.request_id, code: expired.code(), email: input.email }, { request_id: '../bad', code: '12345678' }]) {
    await assert.rejects(expired.submit(args), errorCode('invalid_params'));
  }
});

test('duplicate initial requests share a challenge and sends obey concurrent email IP and global budgets', async () => {
  const s = setup();
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => s.submit(input)));
  assert.equal(new Set(duplicates.map(r => r.request_id)).size, 1); assert.equal(s.mail.calls.length, 1);
  const email = setup();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => email.submit({ ...input, content: `${input.content}\n${i}` }, `ip-${i}`)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(email.mail.calls.length, 3);
  const ip = setup();
  const ipResults = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => ip.submit({ ...input, email: `owner${i}@example.test` })));
  assert.equal(ipResults.filter(r => r.status === 'fulfilled').length, 5);
  const global = setup();
  const globalResults = await Promise.allSettled(Array.from({ length: 103 }, (_, i) => global.submit({ ...input, email: `owner${i}@example.test` }, `ip-${i}`)));
  assert.equal(globalResults.filter(r => r.status === 'fulfilled').length, 100);
  assert.equal(global.mail.calls.length, 100);
  assert.ok(globalResults.filter(r => r.status === 'rejected').every(r => r.reason.code === 'rate_limited'));
  email.clock.now += 3600001;
  await email.submit({ ...input, content: `${input.content}\nafter window` });
});

test('a verified different mailbox cannot overwrite an existing owner or race ownership', async () => {
  const s = setup(); const first = await s.submit(input); const firstCode = s.code();
  const impostor = await s.submit({ ...input, email: 'impostor@example.test' }, 'other-ip'); const impostorCode = s.code();
  await s.submit({ request_id: first.request_id, code: firstCode });
  const writes = s.gh.calls.length;
  await assert.rejects(s.submit({ request_id: impostor.request_id, code: impostorCode }), errorCode('owner_mismatch'));
  assert.equal(s.gh.calls.length, writes);
  assert.equal(s.db.row('SELECT email FROM candidates').email, input.email);
  await assert.rejects(s.submit({ ...input, email: 'impostor@example.test' }, 'other-ip'), errorCode('owner_mismatch'));
});

test('confirmation recovers lost branch file and PR responses without duplicate public writes', async () => {
  for (const stage of ['branch', 'file', 'pr', 'database']) {
    const s = setup(); const request = await s.submit(input); const code = s.code(); let failed = false;
    s.gh.after = async call => {
      if (!failed && ((stage === 'branch' && call.route === '/git/refs') || (stage === 'file' && call.method === 'PUT') || (stage === 'pr' && call.route === '/pulls' && call.method === 'POST'))) {
        failed = true; throw new Error('Response lost after upstream accepted');
      }
    };
    s.db.fail = sql => { if (!failed && stage === 'database' && sql.startsWith('UPDATE candidate_requests SET pr_url')) { failed = true; return true; } return false; };
    await assert.rejects(s.submit({ request_id: request.request_id, code }));
    s.clock.now += 1000000;
    const result = await s.submit({ request_id: request.request_id, code });
    assert.equal(result.pr_url, 'https://github.com/fixture/registry/pull/1');
    assert.equal(s.gh.prs.length, 1); assert.equal(s.gh.branches.size, 1);
    assert.equal(s.gh.calls.filter(c => c.method === 'PUT').length, 1);
    assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 1);
  }
});

test('concurrent confirmations serialize one candidate write and retry a busy confirmation', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  let release; let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  s.gh.before = async call => { if (first && call.route === '/git/ref/heads/main') { first = false; entered(); await held; } };
  const leader = s.submit({ request_id: request.request_id, code });
  await started;
  const followers = await Promise.allSettled(Array.from({ length: 11 }, () => s.submit({ request_id: request.request_id, code })));
  release(); const results = [...await Promise.allSettled([leader]), ...followers];
  assert.equal(s.gh.calls.filter(c => c.route === '/git/refs' && c.method === 'POST').length, 1);
  assert.equal(s.gh.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(followers.filter(r => r.status === 'rejected').length, 11);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'submission_busy'));
  assert.equal((await s.submit({ request_id: request.request_id, code })).pr_url, 'https://github.com/fixture/registry/pull/1');
});

test('owner upsert uses the immutable approved base SHA and refuses unapproved source collisions', async () => {
  const s = setup(); const request = await s.submit(input);
  await s.submit({ request_id: request.request_id, code: s.code() }); s.gh.merge();
  const update = await s.submit({ ...input, content: '# Updated fictional candidate\nMontréal' });
  await s.submit({ request_id: update.request_id, code: s.code() });
  const puts = s.gh.calls.filter(c => c.method === 'PUT');
  assert.equal(puts[1].body.sha, blobSha(input.content));
  assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 2);
  const collision = setup(); collision.gh.main.set(`resumes/${input.name}.md`, '# Unverified public file');
  const req = await collision.submit(input);
  await assert.rejects(collision.submit({ request_id: req.request_id, code: collision.code() }), errorCode('source_conflict'));
  assert.equal(collision.gh.branches.size, 0);
  assert.equal(collision.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 0);
});

test('contact discloses only the active published approved version under an atomic quota', async () => {
  const s = setup(); const request = await s.submit(input);
  await s.submit({ request_id: request.request_id, code: s.code() });
  await assert.rejects(s.contact(input.name), errorCode('not_found'));
  s.db.sqlite.prepare('INSERT INTO registry_resumes(generation,id,sha,content,embedding) VALUES (1,?,?,?,?)').run(input.name, blobSha(input.content), input.content, new Uint8Array(3072));
  s.db.sqlite.exec('UPDATE registry_state SET current_generation = 1 WHERE id = 1');
  assert.equal((await s.contact(input.name, 'quota-ip')).email, input.email);
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => s.contact(input.name, 'quota-ip')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 19);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'rate_limited'));
  s.db.sqlite.prepare('UPDATE registry_resumes SET sha = ?').run('unapproved');
  await assert.rejects(s.contact(input.name, 'fresh-ip'), errorCode('not_found'));
  s.db.sqlite.prepare('INSERT INTO emails(id,email) VALUES (?,?)').run('legacy', 'legacy@example.test');
  await assert.rejects(s.contact('legacy', 'fresh-ip'), errorCode('not_found'));
});

test('verified remove hides immediately during GitHub failure then deletes with expected SHA', async () => {
  const s = setup(); const request = await s.submit(input); const originalCode = s.code();
  await s.submit({ request_id: request.request_id, code: originalCode }); s.gh.merge();
  s.db.sqlite.prepare('INSERT INTO registry_resumes(generation,id,sha,content,embedding) VALUES (1,?,?,?,?)').run(input.name, blobSha(input.content), input.content, new Uint8Array(3072));
  s.db.sqlite.exec('UPDATE registry_state SET current_generation = 1 WHERE id = 1');
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' }); const removeCode = s.code();
  assert.equal((await s.contact(input.name)).email, input.email);
  s.gh.before = () => reply({}, 503);
  await assert.rejects(s.submit({ request_id: removal.request_id, code: removeCode }));
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
  await assert.rejects(s.contact(input.name), errorCode('not_found'));
  const registry = s.load('registry');
  await assert.rejects(registry.getResume(s.env, input.name), errorCode('not_found'));
  assert.equal((await registry.search(s.env, 'fictional', 10, 'test-search')).length, 0);
  s.gh.before = null;
  const result = await s.submit({ request_id: removal.request_id, code: removeCode });
  assert.equal(result.status, 'pending_review');
  const deletion = s.gh.calls.find(c => c.method === 'DELETE' && c.route.startsWith('/contents/'));
  assert.equal(deletion.body.sha, blobSha(input.content));
  assert.equal(s.gh.branches.get(s.gh.prs[1].head.ref).has(`resumes/${input.name}.md`), false);
  await s.submit({ request_id: request.request_id, code: originalCode });
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
});

test('only the exact verified blob hash is allowlisted and malformed upstream metadata is rejected', async () => {
  for (const stage of ['commit', 'file', 'pr']) {
    const s = setup(); const request = await s.submit(input);
    s.gh.after = (call, data) => {
      if (stage === 'commit' && call.route === '/git/ref/heads/main') data.object.sha = '../../escape';
      if (stage === 'file' && call.method === 'PUT') data.content.sha = 'f'.repeat(40);
      if (stage === 'pr' && call.method === 'POST' && call.route === '/pulls') data.html_url = 'https://evil.invalid/leak';
    };
    await assert.rejects(s.submit({ request_id: request.request_id, code: s.code() }), errorCode('github_invalid'));
    if (stage !== 'pr') assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 0);
  }
});

test('one pending PR blocks out-of-order upserts while removal stays private until reviewed', async () => {
  const s = setup(); const request = await s.submit(input);
  await s.submit({ request_id: request.request_id, code: s.code() });
  const update = await s.submit({ ...input, content: '# Second version' }); const updateCode = s.code();
  await assert.rejects(s.submit({ request_id: update.request_id, code: updateCode }), errorCode('pending_submission'));
  assert.equal(s.gh.prs.length, 1);
  s.gh.merge(); await s.submit({ request_id: update.request_id, code: updateCode });
  assert.equal(s.gh.prs.length, 2);
});

test('expired lease holders cannot publish or approve after ownership lock is replaced', async () => {
  const s = setup(); const request = await s.submit(input); let replaced = false;
  s.gh.after = call => {
    if (!replaced && call.route === '/git/ref/heads/main') {
      replaced = true; s.clock.now += 120001;
      s.db.sqlite.prepare('UPDATE candidates SET lock_token = ?, lock_until = ?, active = 0').run('new-owner-lock', s.clock.now + 120000);
    }
  };
  await assert.rejects(s.submit({ request_id: request.request_id, code: s.code() }), errorCode('submission_busy'));
  assert.equal(s.gh.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 0);
  assert.equal(s.db.row('SELECT lock_token FROM candidates').lock_token, 'new-owner-lock');
});

test('definitive file failure cleans its branch and allows a later verified request', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  s.gh.before = call => call.method === 'PUT' ? reply({ message: 'Forbidden' }, 403) : null;
  await assert.rejects(s.submit({ request_id: request.request_id, code }), errorCode('github_unavailable'));
  assert.equal(s.gh.branches.size, 0);
  assert.equal(s.db.row('SELECT pending_request FROM candidates').pending_request, null);
  assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 0);
  s.gh.before = null;
  assert.equal((await s.submit({ request_id: request.request_id, code })).status, 'pending_review');
});

test('restoration requires a new verified request after removal and source deletion', async () => {
  const s = setup(); const request = await s.submit(input); const oldCode = s.code();
  await s.submit({ request_id: request.request_id, code: oldCode }); s.gh.merge();
  const stale = await s.submit({ ...input, content: '# Stale queued upsert' }); const staleCode = s.code();
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' });
  await s.submit({ request_id: removal.request_id, code: s.code() });
  await assert.rejects(s.submit({ request_id: stale.request_id, code: staleCode }), errorCode('request_superseded'));
  s.gh.merge(1); s.clock.now += 3600001;
  const restore = await s.submit({ ...input, content: '# Restored fictional candidate' });
  await s.submit({ request_id: restore.request_id, code: s.code() });
  assert.equal(s.db.row('SELECT active FROM candidates').active, 1);
  assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 1);
  await s.submit({ request_id: removal.request_id, code: s.code(2) });
  assert.equal(s.db.row('SELECT active FROM candidates').active, 1, 'Old removal retry is status only');
});

test('verification email explains the authorized action without republishing private content', async () => {
  const s = setup(); const request = await s.submit({ ...input, email: 'Private@EXAMPLE.TEST' });
  const mail = s.mail.calls[0].body;
  assert.equal(mail.to[0], 'Private@example.test');
  assert.ok(mail.text.includes('upsert')); assert.ok(mail.text.includes(input.name));
  assert.ok(mail.text.includes('public')); assert.ok(mail.text.includes('Do not share'));
  assert.ok(!mail.text.includes(input.content));
  await s.submit({ request_id: request.request_id, code: s.code() });
  assert.equal(s.db.row('SELECT email FROM candidates').email, 'Private@example.test');
  await assert.rejects(s.submit({ ...input, email: 'private@example.test' }), errorCode('owner_mismatch'));
});

test('database failure after email acceptance can restart without a stuck unusable challenge', async () => {
  const s = setup(); let once = true;
  s.db.fail = sql => { if (once && sql.startsWith('UPDATE candidate_requests SET sent')) { once = false; return true; } return false; };
  await assert.rejects(s.submit(input));
  assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_requests').n, 0);
  const request = await s.submit(input);
  assert.equal((await s.submit({ request_id: request.request_id, code: s.code() })).status, 'pending_review');
});

test('bounded maintenance purges old private challenges and unfinished codes stop after a day', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  s.gh.before = () => reply({}, 503);
  await assert.rejects(s.submit({ request_id: request.request_id, code }));
  s.clock.now += 86400001;
  await assert.rejects(s.submit({ request_id: request.request_id, code }), errorCode('invalid_code'));
  s.gh.before = null;
  const pending = await s.submit({ ...input, name: 'other-candidate' });
  s.clock.now += 86400001;
  await s.app.cleanupCandidates(s.env);
  assert.equal(s.db.row('SELECT request_id FROM candidate_requests WHERE request_id = ?', pending.request_id), null);
  assert.equal(s.db.row('SELECT pending_request FROM candidates').pending_request, request.request_id, 'Unresolved public work stays reserved for safe reconciliation');
  assert.ok(s.db.row('SELECT request_id FROM candidate_requests WHERE request_id = ?', request.request_id));
});

test('removal supersedes an interrupted upsert without leaving a permanent pending reservation', async () => {
  const s = setup(); const request = await s.submit(input); const code = s.code();
  s.gh.before = call => call.method === 'PUT' ? reply({}, 503) : null;
  await assert.rejects(s.submit({ request_id: request.request_id, code }));
  s.gh.before = null;
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' });
  const result = await s.submit({ request_id: removal.request_id, code: s.code() });
  assert.equal(result.status, 'removed');
  assert.equal(s.gh.branches.size, 0); assert.equal(s.gh.prs.length, 0);
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
  await assert.rejects(s.submit({ request_id: request.request_id, code }), errorCode('request_superseded'));
});

test('removal closes an older pending PR before opening the deletion PR', async () => {
  const s = setup(); const first = await s.submit(input);
  await s.submit({ request_id: first.request_id, code: s.code() }); s.gh.merge();
  const update = await s.submit({ ...input, content: '# Pending update' });
  await s.submit({ request_id: update.request_id, code: s.code() });
  const remove = await s.submit({ name: input.name, email: input.email, action: 'remove' });
  await s.submit({ request_id: remove.request_id, code: s.code() });
  assert.equal(s.gh.prs[1].state, 'closed'); assert.equal(s.gh.prs[2].state, 'open');
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
});

test('fencing prevents a removal racing the final activation from restoring visibility', async () => {
  const s = setup(); const first = await s.submit(input);
  await s.submit({ request_id: first.request_id, code: s.code() }); s.gh.merge();
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' });
  await s.submit({ request_id: removal.request_id, code: s.code() }); s.gh.merge(1);
  const restore = await s.submit({ ...input, content: '# Restored' }); let injected = false;
  s.db.fail = sql => {
    if (!injected && sql.includes('UPDATE candidates SET active = 1')) {
      injected = true;
      s.db.sqlite.prepare('UPDATE candidate_requests SET superseded = 1 WHERE request_id = ?').run(restore.request_id);
      s.db.sqlite.prepare('UPDATE candidates SET active = 0, lock_token = ?').run('new-removal-lock');
    }
    return false;
  };
  await assert.rejects(s.submit({ request_id: restore.request_id, code: s.code() }), errorCode('submission_busy'));
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
});

test('completed retention preserves live reservations but removes old resolved private request data', async () => {
  const s = setup(); const first = await s.submit(input);
  await s.submit({ request_id: first.request_id, code: s.code() }); s.gh.merge();
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' });
  await s.submit({ request_id: removal.request_id, code: s.code() });
  s.clock.now += 31 * 86400000;
  await s.app.cleanupCandidates(s.env);
  assert.equal(s.db.row('SELECT request_id FROM candidate_requests WHERE request_id = ?', first.request_id), null);
  assert.ok(s.db.row('SELECT request_id FROM candidate_requests WHERE request_id = ?', removal.request_id));
  assert.equal(s.db.row('SELECT email FROM candidates').email, input.email);
});

test('lost delete response retries exactly one deletion without restoring the contact', async () => {
  const s = setup(); const first = await s.submit(input);
  await s.submit({ request_id: first.request_id, code: s.code() }); s.gh.merge();
  const removal = await s.submit({ name: input.name, email: input.email, action: 'remove' }); const code = s.code();
  let lost = false;
  s.gh.after = call => { if (!lost && call.method === 'DELETE') { lost = true; throw Error('lost'); } };
  await assert.rejects(s.submit({ request_id: removal.request_id, code }));
  await s.submit({ request_id: removal.request_id, code });
  assert.equal(s.gh.calls.filter(c => c.method === 'DELETE' && c.route.startsWith('/contents')).length, 1);
  assert.equal(s.db.row('SELECT active FROM candidates').active, 0);
});

test('reported GitHub write success is read back before allowlisting or returning a PR', async () => {
  for (const stage of ['file', 'pr']) {
    const s = setup(); const request = await s.submit(input);
    s.gh.before = call => {
      if (stage === 'file' && call.method === 'PUT') return reply({ content: { sha: blobSha(input.content) } }, 201);
      if (stage === 'pr' && call.method === 'POST' && call.route === '/pulls') {
        return reply({ number: 99, html_url: 'https://github.com/fixture/registry/pull/99', head: { ref: call.body.head }, base: { ref: 'main' } }, 201);
      }
    };
    await assert.rejects(s.submit({ request_id: request.request_id, code: s.code() }), errorCode('github_invalid'));
    assert.equal(s.db.row('SELECT pr_url FROM candidate_requests').pr_url, null);
    if (stage === 'file') assert.equal(s.db.row('SELECT COUNT(*) AS n FROM candidate_versions').n, 0);
  }
});

test('identical approved published content completes unchanged without a new branch or PR', async () => {
  const s = setup(); const first = await s.submit(input);
  await s.submit({ request_id: first.request_id, code: s.code() }); s.gh.merge(); s.clock.now += 900001;
  const repeat = await s.submit(input); const code = s.code();
  const result = await s.submit({ request_id: repeat.request_id, code });
  assert.equal(result.status, 'unchanged'); assert.equal(result.pr_url, null);
  assert.equal(s.gh.branches.size, 1); assert.equal(s.gh.prs.length, 1);
  assert.deepEqual(await s.submit({ request_id: repeat.request_id, code }), result);
});

test('initial submission sends a private challenge without any public write', async () => {
  const s = setup(); const result = await s.submit(input);
  assert.equal(s.gh.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(result.status, 'verification_required');
  assert.match(result.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(result.expires_at, s.clock.now + 900000);
  assert.match(s.code(), /^\d{8}$/);
  assert.deepEqual(s.mail.calls[0].body.to, [input.email]);
  assert.ok(s.mail.calls[0].body.text.includes(result.request_id));
  assert.ok(!JSON.stringify(result).includes(input.email));
  assert.ok(!JSON.stringify(result).includes(s.code()));
  const row = s.db.row('SELECT * FROM candidate_requests WHERE request_id = ?', result.request_id);
  assert.ok(!JSON.stringify(row).includes(s.code()), 'Only the code hash may be persisted');
});
