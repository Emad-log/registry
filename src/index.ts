// hires.md worker: D1 + Workers AI search, MCP endpoint, server-side contact.

export interface Env {
  AI: Ai;
  DB: D1Database;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  ADMIN_TOKEN: string;
  GITHUB_TOKEN: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const RRF_K = 60;
const MAX_TOP_N = 30;
const CONTACT_HOURLY_LIMIT = 20;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stripEmails(text: string): { clean: string; emails: string[] } {
  const emails = text.match(EMAIL_RE) ?? [];
  const clean = text.replace(EMAIL_RE, "[contact via endpoint]");
  return { clean, emails: [...new Set(emails)] };
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "hm_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bearer(request: Request): Promise<string | null> {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function checkToken(db: D1Database, request: Request): Promise<{ ok: true; label: string } | { ok: false }> {
  const token = await bearer(request);
  if (!token) return { ok: false };
  const row = await db
    .prepare("SELECT label FROM api_tokens WHERE token = ?")
    .bind(token)
    .first<{ label: string }>();
  return row ? { ok: true, label: row.label } : { ok: false };
}

function isAdmin(env: Env, request: Request): boolean {
  const h = request.headers.get("authorization") ?? "";
  return h === `Bearer ${env.ADMIN_TOKEN}`;
}

async function embed(env: Env, text: string): Promise<Float32Array> {
  const res = (await env.AI.run(EMBED_MODEL, { text: [text] })) as {
    data?: number[][];
    shape?: number[];
  };
  // Workers AI may return {data} or a flat array with {shape}
  if (res.data && Array.isArray(res.data[0])) {
    return new Float32Array(res.data[0]);
  }
  if (res.shape && Array.isArray((res as unknown as { result?: unknown }).result)) {
    const flat = (res as unknown as { result: number[] }).result;
    return new Float32Array(flat);
  }
  // last resort: object values flattened
  const alt = res as unknown as Record<string, unknown>;
  for (const v of Object.values(alt)) {
    if (Array.isArray(v) && typeof v[0] === "number" && (v as number[]).length >= 256) {
      return new Float32Array(v as number[]);
    }
  }
  throw new Error("unexpected embedding response shape: " + JSON.stringify(res).slice(0, 200));
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(0));
}

function fromBlob(value: unknown): Float32Array {
  // D1 returns BLOB columns as an array of byte numbers, not an ArrayBuffer.
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (Array.isArray(value)) {
    bytes = new Uint8Array(value as number[]);
  } else {
    throw new Error("unexpected blob type from D1: " + typeof value);
  }
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new Float32Array(buf);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ftsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/["'*()]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}

async function search(env: Env, query: string, topN: number): Promise<unknown[]> {
  topN = Math.min(Math.max(1, topN), MAX_TOP_N);

  const qvec = await embed(env, query);
  const rows = await env.DB.prepare(
    "SELECT id, embedding, receipts FROM resumes WHERE embedding IS NOT NULL"
  ).all<{
    id: string;
    embedding: ArrayBuffer;
    receipts: number;
  }>();
  const vecScores: { id: string; score: number }[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    score: cosine(qvec, fromBlob(r.embedding)),
  }));
  vecScores.sort((a, b) => b.score - a.score);

  const kwRank = new Map<string, number>();
  const fq = ftsQuery(query);
  if (fq) {
    const kw = await env.DB.prepare(
      "SELECT id FROM resumes_fts WHERE resumes_fts MATCH ? ORDER BY rank LIMIT 50"
    )
      .bind(fq)
      .all<{ id: string }>();
    (kw.results ?? []).forEach((r, i) => kwRank.set(r.id, i));
  }

  // Fusion: cosine dominates; keyword rank is a tiebreaker; receipt density is a capped multiplicative boost.
  const receiptBoost = new Map<string, number>();
  for (const r of rows.results ?? []) {
    receiptBoost.set(r.id, 1 + Math.min(0.15, Math.min(r.receipts, 3) * 0.05));
  }
  const fused = new Map<string, number>();
  for (const { id, score } of vecScores) {
    const kw = kwRank.get(id);
    const tiebreak = kw !== undefined ? 0.001 / (RRF_K + kw + 1) : 0;
    fused.set(id, score * (receiptBoost.get(id) ?? 1) + tiebreak);
  }
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (ranked.length === 0) return [];

  const ids = ranked.map(([id]) => id);
  const placeholders = ids.map(() => "?").join(",");
  const docs = await env.DB.prepare(`SELECT id, content FROM resumes WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; content: string }>();
  const byId = new Map((docs.results ?? []).map((d) => [d.id, d.content]));

  const now = Date.now();
  const stmts = ids.map((id) =>
    env.DB.prepare("INSERT INTO query_log (resume_id, at) VALUES (?, ?)").bind(id, now)
  );
  await env.DB.batch(stmts);

  return ranked.map(([id, score]) => ({ id, score: Number(score.toFixed(6)), resume: stripEmails(byId.get(id) ?? "").clean }));
}

async function reindex(env: Env): Promise<{ indexed: number; emailsFound: number }> {
  const gh = (path: string) =>
    `https://api.github.com/repos/${env.GITHUB_REPO}/${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hires-md-indexer",
  };

  const treeRes = await fetch(`${gh("git/trees")}/${env.GITHUB_BRANCH}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`tree fetch failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree: { path: string; type: string }[] };
  const files = tree.tree.filter((t) => t.type === "blob" && /^resumes\/[^/]+\.md$/.test(t.path));
  const liveIds = new Set(files.map((f) => f.path.replace(/^resumes\//, "").replace(/\.md$/, "")));

  const existing = await env.DB.prepare("SELECT id FROM resumes").all<{ id: string }>();
  const ghostIds = (existing.results ?? []).map((r) => r.id).filter((id) => !liveIds.has(id));
  if (ghostIds.length > 0) {
    const stmts = ghostIds.flatMap((id) => [
      env.DB.prepare("DELETE FROM resumes WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM resumes_fts WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM query_log WHERE resume_id = ?").bind(id),
    ]);
    await env.DB.batch(stmts);
  }

  let indexed = 0;
  let emailsFound = 0;

  for (const file of files) {
    const cRes = await fetch(`${gh("contents")}/${file.path}?ref=${env.GITHUB_BRANCH}`, { headers });
    if (!cRes.ok) continue;
    const cJson = (await cRes.json()) as { content: string; encoding: string };
    let raw: string;
    if (cJson.encoding === "base64") {
      // atob() yields latin-1; re-encode bytes as UTF-8 so non-ASCII survives
      const bin = atob(cJson.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      raw = new TextDecoder("utf-8").decode(bytes);
    } else {
      raw = cJson.content;
    }
    if (!raw.trim()) continue;

    const id = file.path.replace(/^resumes\//, "").replace(/\.md$/, "");
    const { clean, emails } = stripEmails(raw);
    const now = Date.now();
    const receipts = (clean.match(/https?:\/\/[^\s)]+/g) ?? []).length;

    if (emails.length > 0) {
      await env.DB.prepare(
        "INSERT INTO emails (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email"
      )
        .bind(id, emails[0])
        .run();
      emailsFound++;
    }

    const vec = await embed(env, clean.slice(0, 8000));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO resumes (id, content, updated_at, receipts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, receipts = excluded.receipts"
      ).bind(id, clean, now, receipts),
      env.DB.prepare("DELETE FROM resumes_fts WHERE id = ?").bind(id),
      env.DB.prepare("INSERT INTO resumes_fts (id, content) VALUES (?, ?)").bind(id, clean),
      env.DB.prepare("UPDATE resumes SET embedding = ? WHERE id = ?").bind(toBlob(vec), id),
    ]);
    indexed++;
  }
  return { indexed, emailsFound };
}

async function sendMail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `hires.md <${env.MAIL_FROM}>`,
        to: [to],
        subject,
        text,
      }),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

const MCP_TOOLS = [
  {
    name: "search",
    description:
      "Hybrid semantic+keyword search over a registry of candidate resumes (raw markdown). Returns ranked resumes. Ask naturally, e.g. 'staff engineer who scaled payments infrastructure'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for, in plain language" },
        top_n: { type: "number", description: "How many resumes to return (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get",
    description: "Fetch one full resume by its id (the id returned from search).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "contact",
    description:
      "Get the email address for a candidate (kept server-side, never in the repo). Rate-limited and logged.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function handleMcp(
  env: Env,
  body: { method: string; params?: unknown },
  tokenLabel: string
): Promise<unknown> {
  switch (body.method) {
    case "initialize": {
      // Answer in the client's protocol version when we speak it, otherwise our newest.
      const asked = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      const version = asked && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "hires-md", version: "1.0.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: MCP_TOOLS };
    case "tools/call": {
      const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
      const textOut = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });
      if (name === "search") {
        const results = await search(env, String(args.query ?? ""), Number(args.top_n ?? 10));
        return textOut(JSON.stringify(results, null, 2));
      }
      if (name === "get") {
        const row = await env.DB.prepare("SELECT id, content FROM resumes WHERE id = ?")
          .bind(String(args.id ?? ""))
          .first<{ id: string; content: string }>();
        if (!row) return textOut(`No resume with id '${args.id}'`, true);
        return textOut(stripEmails(row.content).clean);
      }
      if (name === "contact") {
        const res = await contact(env, tokenLabel, String(args.id ?? ""));
        if (!res.ok) return textOut(res.error, true);
        return textOut(JSON.stringify({ id: res.id, email: res.email }));
      }
      throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
    default:
      throw new RpcError(-32601, `Unknown method: ${body.method}`);
  }
}

async function lookupEmail(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT email FROM emails WHERE id = ?").bind(id).first<{ email: string }>();
  return row?.email ?? null;
}

type ContactResult =
  | { ok: true; id: string; email: string }
  | { ok: false; status: number; error: string };

// Used by both the /contact route and the MCP contact tool, so both are rate limited and logged.
async function contact(env: Env, tokenLabel: string, id: string): Promise<ContactResult> {
  const hourAgo = Date.now() - 3600_000;
  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contact_log WHERE token_label = ? AND at > ?"
  )
    .bind(tokenLabel, hourAgo)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= CONTACT_HOURLY_LIMIT) {
    return { ok: false, status: 429, error: "hourly contact limit reached" };
  }
  const email = await lookupEmail(env, id);
  if (!email) return { ok: false, status: 404, error: `no email on file for '${id}'` };
  await env.DB.prepare("INSERT INTO contact_log (token_label, resume_id, at) VALUES (?, ?, ?)")
    .bind(tokenLabel, id, Date.now())
    .run();
  return { ok: true, id, email };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/reindex") {
      if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
      try {
        const result = await reindex(env);
        return json(result);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/admin/token") {
      if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => ({}))) as { label?: string };
      const token = randomToken();
      await env.DB.prepare("INSERT INTO api_tokens (token, label, created_at) VALUES (?, ?, ?)")
        .bind(token, body.label ?? "unnamed", Date.now())
        .run();
      return json({ token, label: body.label ?? "unnamed" });
    }

    if (request.method === "POST" && path === "/admin/email") {
      if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => ({}))) as { id?: string; email?: string };
      if (!body.id || !body.email) return json({ error: "need id and email" }, 400);
      await env.DB.prepare(
        "INSERT INTO emails (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email"
      )
        .bind(body.id, body.email)
        .run();
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/admin/stats") {
      if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
      const url2 = new URL(request.url);
      const days = Math.min(Math.max(1, Number(url2.searchParams.get("days") ?? 30)), 365);
      const since = Date.now() - days * 86400_000;
      const rows = await env.DB.prepare(
        `SELECT q.resume_id, COUNT(*) AS hits FROM query_log q
         JOIN resumes r ON r.id = q.resume_id
         WHERE q.at > ?
         GROUP BY q.resume_id ORDER BY hits DESC`
      )
        .bind(since)
        .all<{ resume_id: string; hits: number }>();
      return json({ days, stats: rows.results ?? [] });
    }

    if (request.method === "POST" && path === "/admin/digest") {
      if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
      const since = Date.now() - 30 * 86400_000;
      const rows = await env.DB.prepare(
        `SELECT q.resume_id, COUNT(*) AS hits, e.email
         FROM query_log q
         JOIN resumes r ON r.id = q.resume_id
         JOIN emails e ON e.id = q.resume_id
         WHERE q.at > ?
         GROUP BY q.resume_id, e.email
         ORDER BY hits DESC`
      )
        .bind(since)
        .all<{ resume_id: string; hits: number; email: string }>();

      let sent = 0;
      let failed = 0;
      const errors: string[] = [];
      for (const row of rows.results ?? []) {
        const subject = `Your resume appeared in ${row.hits} search${row.hits === 1 ? "" : "es"} this month`;
        const text =
          `Hi!\n\n` +
          `Your resume in the hires.md registry came back in ${row.hits} recruiter search${row.hits === 1 ? "" : "es"} over the last 30 days.\n\n` +
          `Recruiters' agents find candidates through the search endpoint - appearing in results is how you get contacted. If your numbers look low, adding proof links (repos, PRs, launches) next to your claims boosts how you rank.\n\n` +
          `You can update your resume any time: edit your .md file and open a PR.\n\n` +
          `- hires.md\n` +
          (env.MAIL_FROM ? `` : ``);
        const ok = await sendMail(env, row.email, subject, text);
        if (ok) sent++;
        else {
          failed++;
          errors.push(row.resume_id);
        }
      }
      return json({ sent, failed, errors });
    }

    // token-authed API surface
    const auth = await checkToken(env.DB, request);
    if (!auth.ok) return json({ error: "unauthorized" }, 401);

    if (request.method === "POST" && path === "/search") {
      const body = (await request.json().catch(() => ({}))) as { query?: string; top_n?: number };
      if (!body.query) return json({ error: "need query" }, 400);
      const results = await search(env, body.query, Number(body.top_n ?? 10));
      return json({ query: body.query, count: results.length, results });
    }

    if (request.method === "POST" && path === "/get") {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      const row = await env.DB.prepare("SELECT id, content FROM resumes WHERE id = ?")
        .bind(String(body.id ?? ""))
        .first<{ id: string; content: string }>();
      if (!row) return json({ error: "not found" }, 404);
      return json({ id: row.id, resume: stripEmails(row.content).clean });
    }

    if (request.method === "POST" && path === "/contact") {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      const res = await contact(env, auth.label, String(body.id ?? ""));
      if (!res.ok) return json({ error: res.error }, res.status);
      return json({ id: res.id, email: res.email });
    }

    if (path === "/mcp") {
      // There is no server-initiated stream, so the SSE GET and the session DELETE do not apply.
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body = (await request.json().catch(() => null)) as
        | { id?: number | string; method: string; params?: unknown }
        | null;
      if (!body?.method) return json({ error: "bad jsonrpc request" }, 400);
      // A notification has no id. It gets an empty 202, never a response object.
      if (body.id === undefined || body.id === null) return new Response(null, { status: 202 });
      try {
        const result = await handleMcp(env, body, auth.label);
        return json({ jsonrpc: "2.0", id: body.id, result });
      } catch (e) {
        const code = e instanceof RpcError ? e.code : -32603;
        const message = e instanceof Error ? e.message : String(e);
        return json({ jsonrpc: "2.0", id: body.id, error: { code, message } });
      }
    }

    return json({ error: "not found" }, 404);
  },
};
