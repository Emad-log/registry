const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(relative, overrides = {}) {
  const cache = new Map();
  function moduleAt(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = fs.readFileSync(file, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const sandbox = {
      module, exports: module.exports, crypto: webcrypto, Request, Response, Headers, URL,
      TextEncoder, TextDecoder, Uint8Array, Float32Array, ArrayBuffer, AbortSignal,
      btoa, atob, Date, console, setTimeout, clearTimeout,
      fetch: async () => { throw new Error('Unmocked network blocked'); }, ...overrides,
      require: name => {
        if (overrides.modules?.[name]) return overrides.modules[name];
        if (!name.startsWith('.')) throw new Error('Unexpected import: ' + name);
        return moduleAt(path.resolve(path.dirname(file), name.replace(/\.js$/, '') + '.ts'));
      },
    };
    vm.runInNewContext(code, sandbox, { filename: file });
    return module.exports;
  }
  return moduleAt(path.join(root, relative));
}

function database(files = ['0004_limits.sql']) {
  const sql = new DatabaseSync(':memory:');
  for (const name of files) sql.exec(fs.readFileSync(path.join(root, 'migrations', name), 'utf8'));
  function prepare(query, params = []) {
    const execute = kind => {
      const stmt = sql.prepare(query);
      if (kind === 'first') return stmt.get(...params) ?? null;
      if (kind === 'all') return { results: stmt.all(...params), success: true };
      const result = stmt.run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return { query, params, bind: (...values) => prepare(query, values),
      first: async () => execute('first'), all: async () => execute('all'), run: async () => execute('run'),
      execute };
  }
  return { sql, prepare, batch: async statements => {
    sql.exec('BEGIN');
    try { const results = statements.map(s => s.execute('run')); sql.exec('COMMIT'); return results; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  } };
}
module.exports = { load, database };
