const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(name) {
  const filename = path.join(root, 'src', `${name}.ts`);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  compiled.require = (id) => id.startsWith('./') ? load(id.slice(2)) : require(id);
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return compiled.exports;
}

function registry() { return load('registry'); }

function database() {
  const sql = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    sql.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
  }
  const history = [];
  const db = {
    sql, history, fault: null, blobMode: 'array',
    prepare(query) {
      const make = (args) => ({
        bind: (...values) => make(values),
        execute() {
          history.push(query);
          if (db.fault) db.fault(query, args);
          const values = args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
          const stmt = sql.prepare(query);
          const rows = stmt.all(...values).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
            if (!(v instanceof Uint8Array)) return [k, v];
            if (db.blobMode === 'array') return [k, Array.from(v)];
            if (db.blobMode === 'buffer') return [k, v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)];
            return [k, v];
          })));
          const changes = sql.prepare('SELECT changes() AS n').get().n;
          return { success: true, results: rows, meta: { changes } };
        },
        async all() { return this.execute(); },
        async run() { return this.execute(); },
        async first(column) { const row = this.execute().results[0]; return column ? row?.[column] ?? null : row ?? null; },
      });
      return make([]);
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = statements.map(s => s.execute()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}

const vector = (a = 1, b = 0) => [a, b, ...Array(766).fill(0)];
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function source(files = {}) {
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const blobs = Object.entries(files).map(([id, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { id, bytes, sha: blobSha(bytes) };
  });
  const calls = [];
  const fixture = { commit, tree, blobs, calls, override: null };
  fixture.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ path: url.pathname, search: url.search, method: init?.method ?? 'GET' });
    if (url.hostname !== 'api.github.com') throw new Error('External network denied');
    if (fixture.override) {
      const response = await fixture.override(url, init);
      if (response) return response;
    }
    const p = url.pathname.replace('/repos/fixture/registry', '');
    if (p === '/git/ref/heads/main') return Response.json({ object: { type: 'commit', sha: fixture.commit } });
    if (p === `/git/commits/${commit}`) return Response.json({ sha: commit, tree: { sha: tree } });
    if (p === `/git/trees/${tree}`) return Response.json({ sha: tree, truncated: false, tree: blobs.map(b => ({ path: `resumes/${b.id}.md`, mode: '100644', type: 'blob', sha: b.sha, size: b.bytes.length })) });
    const b = blobs.find(b => p === `/git/blobs/${b.sha}`);
    if (b) return Response.json({ sha: b.sha, encoding: 'base64', size: b.bytes.length, content: b.bytes.toString('base64') });
    throw new Error(`Unexpected fixture network path: ${p}`);
  };
  return fixture;
}

function setup(t, files = {}) {
  const DB = database();
  const upstream = source(files);
  const original = global.fetch;
  global.fetch = upstream.fetch;
  t.after(() => { global.fetch = original; DB.sql.close(); });
  const aiCalls = [];
  const env = {
    DB, GITHUB_REPO: 'fixture/registry', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'fixture', ADMIN_TOKEN: 'fixture',
    AI: { async run(model, args) { aiCalls.push({ model, args }); return { data: args.text.map(() => vector()), shape: [args.text.length, 768] }; } },
  };
  function approve(id, email = `${id}@example.test`) {
    const b = upstream.blobs.find(b => b.id === id);
    DB.sql.prepare('INSERT INTO candidates(id,email,active,created_at) VALUES(?,?,1,0) ON CONFLICT(id) DO UPDATE SET active=1').run(id, email);
    DB.sql.prepare('INSERT OR IGNORE INTO candidate_versions(candidate_id,blob_sha) VALUES(?,?)').run(id, b.sha);
  }
  return { env, DB, upstream, aiCalls, approve };
}

module.exports = { registry, load, database, vector, blobSha, source, setup };
