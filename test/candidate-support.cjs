// Real SQLite and isolated Worker modules keep outbound requests inside explicit mocks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash, webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const digest = text => createHash('sha256').update(text).digest('hex');
const blobSha = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
class Statement {
  constructor(db, sql, args = []) { Object.assign(this, { db, sql, args }); }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  execute() {
    if (this.db.fail && this.db.fail(this.sql, this.args)) throw new Error('Injected database failure');
    const statement = this.db.sqlite.prepare(this.sql);
    if (/\bRETURNING\b|^\s*SELECT/i.test(this.sql)) {
      const results = statement.all(...this.args);
      return { success: true, results, meta: { changes: results.length } };
    }
    return { success: true, results: [], meta: { changes: Number(statement.run(...this.args).changes) } };
  }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first(column) { const row = this.execute().results[0] ?? null; return column && row ? row[column] : row; }
}
class LocalD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
      this.sqlite.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const rows = statements.map(s => s.execute()); this.sqlite.exec('COMMIT'); return rows; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  row(sql, ...args) { return this.sqlite.prepare(sql).get(...args) ?? null; }
  rows(sql, ...args) { return this.sqlite.prepare(sql).all(...args); }
}
class GitHubMock {
  constructor() {
    this.main = new Map(); this.branches = new Map(); this.prs = []; this.calls = [];
    this.commit = 'a'.repeat(40); this.snapshots = new Map(); this.before = null; this.after = null;
  }
  async fetch(url, init = {}) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com', 'Unmocked network denied');
    assert.ok(parsed.pathname.startsWith('/repos/fixture/registry/'));
    const route = decodeURIComponent(parsed.pathname.slice('/repos/fixture/registry'.length));
    const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : null;
    const call = { route, method, body, query: parsed.search }; this.calls.push(call);
    if (this.before) { const response = await this.before(call); if (response) return response; }
    const finish = async (data, status = 200) => {
      if (this.after) await this.after(call, data);
      return reply(data, status);
    };
    if (/^\/git\/refs?\/heads\//.test(route) && method === 'GET') {
      const name = route.replace(/^\/git\/refs?\/heads\//, '');
      if (name === 'main') { this.snapshots.set(this.commit, new Map(this.main)); return finish({ object: { sha: this.commit } }); }
      if (this.branches.has(name)) return finish({ object: { sha: this.commit } });
      return finish({}, 404);
    }
    if (route === '/git/refs' && method === 'POST') {
      const name = body.ref.replace('refs/heads/', '');
      if (this.branches.has(name)) return finish({}, 422);
      assert.ok(this.snapshots.has(body.sha), 'Branch must use an immutable observed commit');
      this.branches.set(name, new Map(this.snapshots.get(body.sha)));
      return finish({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (route.startsWith('/git/refs/heads/') && method === 'DELETE') {
      this.branches.delete(route.slice('/git/refs/heads/'.length));
      return new Response(null, { status: 204 });
    }
    if (route.startsWith('/contents/')) {
      const file = route.slice('/contents/'.length);
      if (method === 'GET') {
        const ref = parsed.searchParams.get('ref');
        const files = ref === 'main' ? this.main : this.branches.get(ref) || this.snapshots.get(ref);
        assert.ok(files, `Unknown ref ${ref}`);
        if (!files.has(file)) return finish({}, 404);
        const text = files.get(file);
        return finish({ type: 'file', path: file, sha: blobSha(text), encoding: 'base64', content: Buffer.from(text).toString('base64') });
      }
      const files = this.branches.get(body.branch); assert.ok(files);
      const previous = files.get(file);
      if ((previous !== undefined && body.sha !== blobSha(previous)) || (previous === undefined && body.sha)) return finish({}, 409);
      if (method === 'DELETE') { files.delete(file); return finish({ content: null, commit: { sha: 'b'.repeat(40) } }); }
      assert.equal(method, 'PUT');
      const text = Buffer.from(body.content, 'base64').toString('utf8'); files.set(file, text);
      return finish({ content: { sha: blobSha(text) }, commit: { sha: 'b'.repeat(40) } }, 201);
    }
    if (route === '/pulls' && method === 'GET') {
      const branch = parsed.searchParams.get('head').split(':').slice(1).join(':');
      return finish(this.prs.filter(p => p.head.ref === branch));
    }
    if (/^\/pulls\/\d+$/.test(route)) {
      const pr = this.prs[Number(route.split('/')[2]) - 1];
      if (!pr) return finish({}, 404);
      if (method === 'PATCH') { assert.equal(body.state, 'closed'); pr.state = 'closed'; }
      else assert.equal(method, 'GET');
      return finish(pr);
    }
    if (route === '/pulls' && method === 'POST') {
      if (this.prs.some(p => p.head.ref === body.head)) return finish({}, 422);
      const number = this.prs.length + 1;
      const pr = { number, html_url: `https://github.com/fixture/registry/pull/${number}`, state: 'open', head: { ref: body.head }, base: { ref: body.base } };
      this.prs.push(pr); return finish(pr, 201);
    }
    throw new Error(`Unmocked network denied: ${method} ${route}`);
  }
  merge(index = 0) { this.main = new Map(this.branches.get(this.prs[index].head.ref)); this.commit = digest(`${this.commit}:${index}`).slice(0, 40); this.prs[index].state = 'closed'; this.prs[index].merged_at = '2026-01-01T00:00:00Z'; }
}
function setup() {
  const db = new LocalD1(); const gh = new GitHubMock();
  const clock = { now: 1800000000000 }; const mail = { calls: [], status: 200, body: { id: 'fixture-email-id' }, before: null };
  const env = { DB: db, GITHUB_REPO: 'fixture/registry', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'fixture-token', ADMIN_TOKEN: 'fixture-admin', RESEND_API_KEY: 'fixture-resend', MAIL_FROM: 'verify@fixture.invalid', AI: { run() { throw new Error('AI unavailable in candidate tests'); } } };
  class Clock extends Date { static now() { return clock.now; } }
  const sandbox = { Request, Response, Headers, URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, Uint32Array, ArrayBuffer, Date: Clock, btoa, atob, crypto: webcrypto, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      if (url === 'https://api.resend.com/emails') {
        mail.calls.push({ body: JSON.parse(init.body), headers: new Headers(init.headers), init });
        if (mail.before) await mail.before();
        return reply(mail.body, mail.status);
      }
      return gh.fetch(url, init);
    } };
  const cache = new Map();
  const context = vm.createContext(sandbox);
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const filename = path.join(root, 'src', `${name}.ts`);
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {}; cache.set(name, exports);
    const factory = vm.runInContext(`(function(exports,require){${compiled}\n})`, context, { filename });
    factory(exports, module => { assert.ok(module.startsWith('./')); return load(module.slice(2)); });
    return exports;
  }
  const app = load('candidates');
  return { db, gh, env, clock, mail, app, load,
    submit: (args, key = 'fixture-ip') => app.submit(env, args, key),
    contact: (id, key = 'fixture-ip') => app.contact(env, id, key),
    code: (index = mail.calls.length - 1) => mail.calls[index].body.text.match(/Verification code: (\d{8})/)[1],
  };
}
module.exports = { setup, reply, blobSha };
