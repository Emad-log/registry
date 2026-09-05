const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { privateText } = require('../test/helpers.cjs').load('src/core.ts');
const root = path.resolve(__dirname, '..');

function run(command, args) {
  const result = cp.spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

assert.equal(privateText('test@example.test'), true);
assert.equal(privateText('test%40example.test'), true);
assert.equal(privateText('# Public resume\nUnicode José 東京'), false);
const tracked = cp.execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
for (const file of new Set(tracked)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const value = fs.readFileSync(full, 'utf8');
  assert.ok(!value.includes(String.fromCharCode(0x2014)), `U+2014 in ${file}`);
  assert.ok(!/^(<<<<<<< |=======|>>>>>>> )/m.test(value), `conflict marker in ${file}`);
  assert.ok(!/ghp_[a-zA-Z0-9]{30,}|cfut_[a-zA-Z0-9]{30,}|adm_[a-f0-9]{32,}/.test(value), `secret pattern in ${file}`);
  if (/^resumes\/[^/]+\.md$/.test(file)) assert.ok(!privateText(value), `private data in ${file}`);
}
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
const tests = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.cjs')).sort().map(f => 'test/' + f);
assert.ok(tests.length > 0, 'missing tests');
run(process.execPath, ['--test', ...tests]);
run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', '.wrangler/check-build']);
console.log('CHECKS_PASSED');
