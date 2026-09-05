const assert = require('node:assert/strict');

async function main() {
  const { HIRES_ENDPOINT, HIRES_ADMIN_TOKEN, EXPECTED_COMMIT } = process.env;
  assert.ok(HIRES_ENDPOINT && HIRES_ADMIN_TOKEN, 'missing reindex configuration');
  if (EXPECTED_COMMIT) assert.match(EXPECTED_COMMIT, /^[a-f0-9]{40}$/);
  const endpoint = new URL('/reindex', HIRES_ENDPOINT);
  assert.ok(endpoint.protocol === 'https:' || endpoint.hostname === '127.0.0.1', 'HTTPS required');
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, { method: 'POST', headers: {
      Authorization: 'Bearer ' + HIRES_ADMIN_TOKEN, 'content-type': 'application/json',
    }, body: JSON.stringify(EXPECTED_COMMIT ? { commit: EXPECTED_COMMIT } : {}), signal: AbortSignal.timeout(300000), redirect: 'error' });
    const result = await response.json();
    if (response.status === 409 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    assert.equal(response.status, 200, `reindex failed: HTTP ${response.status}, ${result.error || 'unexpected response'}`);
    assert.ok(Number.isInteger(result.indexed) && result.indexed >= 0);
    assert.ok(Number.isInteger(result.excluded) && result.excluded >= 0);
    assert.match(result.commit, /^[a-f0-9]{40}$/);
    if (EXPECTED_COMMIT) assert.equal(result.commit, EXPECTED_COMMIT);
    const check = await fetch(new URL('/health', HIRES_ENDPOINT), { signal: AbortSignal.timeout(30000) });
    assert.equal(check.status, 200);
    const health = await check.json();
    assert.equal(health.ok, true);
    assert.equal(health.commit, result.commit);
    assert.equal(health.indexed, result.indexed);
    console.log('REINDEX_VERIFIED', JSON.stringify(result));
    return;
  }
  throw new Error('reindex busy; retry later');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
