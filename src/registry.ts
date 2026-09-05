import { AppError, github, privateText, rateLimit, text, validId, type Env } from './core';

const MAX_RESUMES = 100;
const MAX_FILE_BYTES = 32768;
const MAX_JSON_BYTES = 262144;

function capacity(): never {
  throw new AppError(503, 'capacity_exceeded', 'Registry launch capacity exceeded: 100 resumes, 32768 bytes each, 256 KiB source metadata');
}

const PUBLISHED = `FROM registry_resumes r
  JOIN registry_state s ON s.id=1 AND s.current_generation=r.generation
  JOIN candidates c ON c.id=r.id AND c.active=1
  JOIN candidate_versions v ON v.candidate_id=r.id AND v.blob_sha=r.sha`;

const PUBLIC_CONTENT = `CASE WHEN length(CAST(r.content AS BLOB))<=32768 THEN r.content ELSE NULL END`;

function publicContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim() || privateText(content) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) return invalidSource();
  return content;
}

export async function getResume(env: Env, id: string): Promise<{ id: string; resume: string }> {
  validId(id);
  const row = await env.DB.prepare(`SELECT r.id, ${PUBLIC_CONTENT} AS resume ${PUBLISHED} WHERE r.id=?`).bind(id).first<{ id: string; resume: unknown }>();
  if (!row) throw new AppError(404, 'not_found', 'Candidate not found');
  return { id: row.id, resume: publicContent(row.resume) };
}

export async function health(env: Env): Promise<{ ok: true; indexed: number; commit: string | null }> {
  const row = await env.DB.prepare(`SELECT (SELECT count(*) ${PUBLISHED}) AS indexed, commit_sha AS commit_sha FROM registry_state WHERE id=1`).first<{ indexed: number; commit_sha: string | null }>();
  if (!row) throw new AppError(503, 'registry_unavailable', 'Registry state is missing');
  return { ok: true, indexed: row.indexed, commit: row.commit_sha };
}

function invalidSource(): never {
  throw new AppError(502, 'invalid_source', 'GitHub snapshot is incomplete or invalid');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidSource();
  return value as Record<string, unknown>;
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) return invalidSource();
  return value;
}

async function sourceJson(env: Env, path: string): Promise<Record<string, unknown>> {
  const response = await github(env, path);
  if (!response.ok) { await response.body?.cancel(); return invalidSource(); }
  if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) { await response.body?.cancel(); return capacity(); }
  if (!response.body) return invalidSource();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); return capacity(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalidSource();
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))); }
  catch { return invalidSource(); }
}

async function sourceBlob(env: Env, hash: string, expectedSize: number): Promise<string> {
  const blob = await sourceJson(env, `/git/blobs/${hash}`);
  if (blob.sha !== hash || blob.encoding !== 'base64' || typeof blob.content !== 'string' || !Number.isInteger(blob.size)) return invalidSource();
  if ((blob.size as number) > MAX_FILE_BYTES) return capacity();
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, '')), c => c.charCodeAt(0)); }
  catch { return invalidSource(); }
  if (bytes.length !== blob.size || bytes.length !== expectedSize) return invalidSource();
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const encoded = new Uint8Array(prefix.length + bytes.length);
  encoded.set(prefix);
  encoded.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest('SHA-1', encoded);
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) return invalidSource();
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return publicContent(content);
  }
  catch { return invalidSource(); }
}

async function currentCommit(env: Env): Promise<string> {
  const ref = await sourceJson(env, `/git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`);
  const target = record(ref.object);
  if (target.type !== 'commit') return invalidSource();
  return sha(target.sha);
}

function invalidEmbedding(): never {
  throw new AppError(503, 'invalid_embedding', 'Embedding must contain 768 finite float32 values with nonzero norm');
}

function checkedVector(values: unknown): Float32Array {
  if (!Array.isArray(values) || values.length !== 768) return invalidEmbedding();
  for (const value of values) if (typeof value !== 'number' || !Number.isFinite(value)) return invalidEmbedding();
  const vector = new Float32Array(values);
  if (vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) return invalidEmbedding();
  return vector;
}

function fromBlob(value: unknown): Float32Array {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (Array.isArray(value)) {
    if (value.length !== 3072) return invalidEmbedding();
    for (const byte of value) if (!Number.isInteger(byte) || byte < 0 || byte > 255) return invalidEmbedding();
    bytes = new Uint8Array(value);
  }
  else return invalidEmbedding();
  if (bytes.length !== 3072) return invalidEmbedding();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return checkedVector(Array.from(new Float32Array(copy.buffer)));
}

async function embed(env: Env, content: string): Promise<Float32Array> {
  // A byte-bounded prefix stays below 512 tokens; FTS indexes the complete text.
  let excerpt = '';
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of content) {
    bytes += encoder.encode(character).length;
    if (bytes > 480) break;
    excerpt += character;
  }
  let output: unknown;
  try { output = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [excerpt] }, { signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError(503, 'ai_unavailable', 'Embedding service unavailable'); }
  if (!output || typeof output !== 'object' || !('data' in output) || !Array.isArray(output.data) || output.data.length !== 1) return invalidEmbedding();
  if ('shape' in output && (!Array.isArray(output.shape) || output.shape.length !== 2 || output.shape[0] !== 1 || output.shape[1] !== 768)) return invalidEmbedding();
  return checkedVector(output.data[0]);
}

export async function reindex(env: Env, expectedCommit?: string): Promise<{ indexed: number; excluded: number; commit: string }> {
  if (expectedCommit !== undefined && (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}$/.test(expectedCommit))) {
    throw new AppError(400, 'invalid_params', 'expectedCommit must be an exact lowercase 40-character commit SHA');
  }
  const token = crypto.randomUUID();
  const lease = await env.DB.prepare(`UPDATE registry_state SET next_generation=next_generation+1, lock_token=?, lock_until=unixepoch()*1000+120000
    WHERE id=1 AND lock_until<=unixepoch()*1000 RETURNING next_generation`).bind(token).first<{ next_generation: number }>();
  if (!lease) throw new AppError(409, 'index_busy', 'Another indexer holds the registry lease');
  const generation = lease.next_generation;
  const renew = async () => {
    const result = await env.DB.prepare(`UPDATE registry_state SET lock_until=unixepoch()*1000+120000
      WHERE id=1 AND lock_token=? AND next_generation=? AND lock_until>unixepoch()*1000`).bind(token, generation).run();
    if (result.meta.changes !== 1) throw new AppError(409, 'index_lease_lost', 'Registry lease expired or was replaced; retry indexing');
  };
  try {
    const commit = await currentCommit(env);
    if (expectedCommit !== undefined && commit !== expectedCommit) throw new AppError(409, 'commit_mismatch', 'Current branch does not match expectedCommit');
    const committed = await sourceJson(env, `/git/commits/${commit}`);
    if (committed.sha !== commit) return invalidSource();
    const treeSha = sha(record(committed.tree).sha);
    const tree = await sourceJson(env, `/git/trees/${treeSha}?recursive=1`);
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) return invalidSource();
    const paths = new Set<string>();
    const files = tree.tree.map(value => {
      const file = record(value);
      if (typeof file.path !== 'string' || typeof file.type !== 'string' || !['blob', 'tree', 'commit'].includes(file.type) || paths.has(file.path)) return invalidSource();
      paths.add(file.path);
      const resume = /^resumes\/[^/]+\.md$/.test(file.path);
      if (resume && (file.type !== 'blob' || file.mode !== '100644' || !Number.isInteger(file.size) || (file.size as number) < 0)) return invalidSource();
      if (resume && (file.size as number) > MAX_FILE_BYTES) return capacity();
      return { path: file.path, type: file.type, sha: sha(file.sha), size: file.size as number };
    }).filter(f => f.type === 'blob' && /^resumes\/[^/]+\.md$/.test(f.path));
    if (files.length > MAX_RESUMES) return capacity();
    const statements: D1PreparedStatement[] = [];
    const vectors = new Map<string, Float32Array>();
    let indexed = 0;
    let excluded = 0;
    for (const file of files) {
      await renew();
      const id = validId(file.path.slice(8, -3));
      const approved = await env.DB.prepare('SELECT 1 FROM candidate_versions v JOIN candidates c ON c.id=v.candidate_id AND c.active=1 WHERE c.id=? AND v.blob_sha=?').bind(id, file.sha).first();
      if (!approved) { excluded++; continue; }
      const content = await sourceBlob(env, file.sha, file.size);
      let embedding = vectors.get(file.sha);
      if (!embedding) {
        const cached = await env.DB.prepare('SELECT CASE WHEN length(embedding)=3072 THEN embedding ELSE NULL END AS embedding FROM registry_resumes WHERE sha=? LIMIT 1').bind(file.sha).first<{ embedding: unknown }>();
        embedding = cached ? fromBlob(cached.embedding) : await embed(env, content);
        vectors.set(file.sha, embedding);
      }
      statements.push(env.DB.prepare(`INSERT INTO registry_resumes(generation,id,sha,content,embedding) SELECT ?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM registry_state WHERE id=1 AND lock_token=? AND next_generation=? AND lock_until>unixepoch()*1000)`)
        .bind(generation, id, file.sha, content, new Uint8Array(embedding.buffer), token, generation));
      statements.push(env.DB.prepare(`INSERT INTO registry_fts(generation,id,content) SELECT generation,id,content FROM registry_resumes WHERE generation=? AND id=?`).bind(generation, id));
      indexed++;
    }
    for (let i = 0; i < statements.length; i += 20) {
      await renew();
      await env.DB.batch(statements.slice(i, i + 20));
    }
    if (await currentCommit(env) !== commit) throw new AppError(409, 'commit_mismatch', 'Branch moved during indexing; retry with the current commit');
    const results = await env.DB.batch<{ indexed: number }>([
      env.DB.prepare(`UPDATE registry_state SET current_generation=?,commit_sha=? WHERE id=1 AND lock_token=? AND next_generation=? AND lock_until>unixepoch()*1000
        AND (SELECT count(*) FROM registry_resumes WHERE generation=?)=?`).bind(generation, commit, token, generation, generation, indexed),
      env.DB.prepare(`DELETE FROM registry_resumes WHERE generation=? AND NOT EXISTS
        (SELECT 1 FROM candidates c JOIN candidate_versions v ON v.candidate_id=c.id WHERE c.id=registry_resumes.id AND c.active=1 AND v.blob_sha=registry_resumes.sha)`).bind(generation),
      env.DB.prepare(`DELETE FROM registry_fts WHERE generation=? AND NOT EXISTS
        (SELECT 1 FROM registry_resumes r WHERE r.generation=registry_fts.generation AND r.id=registry_fts.id)`).bind(generation),
      env.DB.prepare(`DELETE FROM registry_fts WHERE generation<>? AND EXISTS(SELECT 1 FROM registry_state WHERE id=1 AND current_generation=? AND lock_token=?)`).bind(generation, generation, token),
      env.DB.prepare(`DELETE FROM registry_resumes WHERE generation<>? AND EXISTS(SELECT 1 FROM registry_state WHERE id=1 AND current_generation=? AND lock_token=?)`).bind(generation, generation, token),
      env.DB.prepare('SELECT count(*) AS indexed FROM registry_resumes WHERE generation=?').bind(generation),
    ]);
    if (results[0].meta.changes !== 1) throw new AppError(409, 'index_lease_lost', 'Registry lease expired or was replaced; retry indexing');
    const published = Number(results[5].results[0].indexed);
    excluded += indexed - published;
    indexed = published;
    return { indexed, excluded, commit };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'registry_unavailable', 'Registry storage unavailable; retry indexing');
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM registry_fts WHERE generation=? AND generation<>(SELECT current_generation FROM registry_state WHERE id=1)').bind(generation),
      env.DB.prepare('DELETE FROM registry_resumes WHERE generation=? AND generation<>(SELECT current_generation FROM registry_state WHERE id=1)').bind(generation),
      env.DB.prepare('UPDATE registry_state SET lock_token=NULL,lock_until=0 WHERE id=1 AND lock_token=? AND next_generation=?').bind(token, generation),
    ]);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / Math.sqrt(aa * bb);
}

export async function search(env: Env, query: string, topN: number, requesterKey: string): Promise<Array<{ id: string; score: number; resume: string }>> {
  text(query, 'query', 1000);
  if (!Number.isInteger(topN) || topN < 1 || topN > 30) throw new AppError(400, 'invalid_params', 'top_n must be an integer from 1 to 30');
  await rateLimit(env, 'search', requesterKey, 30, 60000);
  const count = await env.DB.prepare(`SELECT count(*) AS n ${PUBLISHED}`).first<{ n: number }>();
  if (!count?.n) return [];
  if (count.n > MAX_RESUMES) return capacity();
  await rateLimit(env, 'search-global', 'all', 300, 60000);
  await rateLimit(env, 'search-daily', 'all', 2000, 86400000);
  const qvec = await embed(env, query);
  const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map(term => `"${term}"`).join(' OR ');
  const statements = [env.DB.prepare(`SELECT r.id,${PUBLIC_CONTENT} AS content,
    CASE WHEN length(r.embedding)=3072 THEN r.embedding ELSE NULL END AS embedding ${PUBLISHED} LIMIT ?`).bind(MAX_RESUMES + 1)];
  if (terms) statements.push(env.DB.prepare(`SELECT r.id,bm25(registry_fts) AS keyword_rank ${PUBLISHED}
    JOIN registry_fts ON registry_fts.id=r.id AND registry_fts.generation=r.generation
    WHERE registry_fts MATCH ? ORDER BY keyword_rank,r.id LIMIT ?`).bind(terms, MAX_RESUMES));
  const [rows, keywords] = await env.DB.batch<{ id: string; content: string; embedding: unknown }>(statements);
  if (rows.results.length > MAX_RESUMES) return capacity();
  const ranks = new Map((keywords?.results ?? []).map((row, i) => [row.id, i]));
  return rows.results.map(row => ({ id: row.id, score: cosine(qvec, fromBlob(row.embedding)) + (ranks.has(row.id) ? 0.001 / (61 + ranks.get(row.id)!) : 0), resume: publicContent(row.content) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topN);
}
