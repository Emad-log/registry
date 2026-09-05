import { AppError, Env, github, object, privateText, rateLimit, sha256, text, validId } from "./core";

function validate(args: Record<string, unknown>): void {
  object(args);
  if (Object.keys(args).some(key => !["name", "email", "action", "content"].includes(key))) {
    throw new AppError(400, "invalid_params", "Unexpected submission field");
  }
  validId(args.name);
  const email = text(args.email, "email", 254);
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(email)) {
    throw new AppError(400, "invalid_params", "email must be a plain email address");
  }
  if (args.action !== undefined && args.action !== "upsert" && args.action !== "remove") {
    throw new AppError(400, "invalid_params", "action must be upsert or remove");
  }
  if (args.action === "remove") {
    if (args.content !== undefined) throw new AppError(400, "invalid_params", "remove must not include content");
    return;
  }
  const content = text(args.content, "content", 32768);
  if (privateText(content) || /[\uD800-\uDFFF]/u.test(content) || new TextEncoder().encode(content).length > 32768) {
    throw new AppError(400, "invalid_params", "Public content must be valid UTF-8, at most 32768 bytes, without contact emails or forbidden punctuation");
  }
}

function codeHash(requestId: string, code: string): Promise<string> {
  return sha256(`${requestId}:${code}`);
}

type CandidateRequest = {
  request_id: string; candidate_id: string; email: string; action: "upsert" | "remove";
  content: string; code_hash: string; branch: string; pr_url: string | null; expires_at: number; base_commit: string | null; base_sha: string | null; superseded: number; completed: number;
};

function invalidGithub(): AppError {
  return new AppError(502, "github_invalid", "GitHub returned invalid submission metadata");
}

function gitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw invalidGithub();
  return value;
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw invalidGithub(); }
}

async function githubJson(env: Env, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await github(env, path, init);
  if (!response.ok) throw new AppError(503, "github_unavailable", "GitHub request failed; retry this request later");
  const value = await responseJson(response);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidGithub();
  return value as Record<string, unknown>;
}

async function blobHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(header.length + bytes.length);
  data.set(header); data.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function prUrl(env: Env, row: CandidateRequest, value: unknown): string {
  const pr = object(value);
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1 ||
      pr.html_url !== `https://github.com/${env.GITHUB_REPO}/pull/${pr.number}` ||
      object(pr.head).ref !== row.branch || object(pr.base).ref !== env.GITHUB_BRANCH) throw invalidGithub();
  return pr.html_url as string;
}

async function checkOwner(env: Env, id: string, email: string, action: string): Promise<void> {
  const owner = await env.DB.prepare("SELECT email FROM candidates WHERE id = ?").bind(id).first<{ email: string }>();
  if (owner && owner.email !== email) throw new AppError(409, "owner_mismatch", "This name is reserved to a different verified mailbox; contact support");
  if (!owner && action === "remove") throw new AppError(404, "not_found", "No registered candidate to remove");
}

function pending(row: CandidateRequest) {
  let status = "pending_review";
  if (!row.pr_url) status = row.action === "remove" ? "removed" : "unchanged";
  return { status, id: row.candidate_id, pr_url: row.pr_url };
}

async function confirm(env: Env, args: Record<string, unknown>): Promise<unknown> {
  if (Object.keys(args).some(key => !["request_id", "code"].includes(key)) || typeof args.request_id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.request_id) ||
      typeof args.code !== "string" || !/^\d{8}$/.test(args.code)) {
    throw new AppError(400, "invalid_params", "Confirmation requires request_id and an eight-digit code only");
  }
  const hash = await codeHash(args.request_id, args.code);
  await env.DB.prepare(`UPDATE candidate_requests SET attempts = attempts + 1
    WHERE request_id = ? AND code_hash != ? AND attempts < 5 AND verified = 0 AND sent = 1 AND expires_at > ?`)
    .bind(args.request_id, hash, Date.now()).run();
  const row = await env.DB.prepare(`UPDATE candidate_requests SET verified = 1
    WHERE request_id = ? AND code_hash = ? AND sent = 1 AND
    ((verified = 1 AND (completed = 1 OR pr_url IS NOT NULL OR created_at > ?)) OR (attempts < 5 AND expires_at > ?)) RETURNING *`)
    .bind(args.request_id, hash, Date.now() - 86400000, Date.now()).first<CandidateRequest>();
  if (!row) throw new AppError(400, "invalid_code", "Invalid or expired verification code");
  if (row.pr_url || row.completed) return pending(row);
  if (row.superseded) throw new AppError(409, "request_superseded", "A removal superseded this request; start a new request");
  await env.DB.prepare("INSERT INTO candidates(id, email, active, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING")
    .bind(row.candidate_id, row.email, Date.now()).run();
  await checkOwner(env, row.candidate_id, row.email, row.action);
  if (row.action === "remove") {
    await env.DB.batch([
      env.DB.prepare("UPDATE candidates SET active = 0 WHERE id = ? AND email = ?").bind(row.candidate_id, row.email),
      env.DB.prepare("UPDATE candidate_requests SET superseded = 1 WHERE candidate_id = ? AND request_id != ? AND pr_url IS NULL")
        .bind(row.candidate_id, row.request_id),
    ]);
  }
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare("UPDATE candidates SET lock_token = ?, lock_until = ? WHERE id = ? AND lock_until <= ?")
    .bind(token, Date.now() + 120000, row.candidate_id, Date.now()).run();
  if (lock.meta.changes !== 1) throw new AppError(409, "submission_busy", "Another confirmation is in progress; retry this request");
  try {
    const fresh = await env.DB.prepare("SELECT * FROM candidate_requests WHERE request_id = ?").bind(row.request_id).first<CandidateRequest>();
    if (fresh?.pr_url || fresh?.completed) return pending(fresh);
    const guard = async () => {
      const held = await env.DB.prepare(`SELECT 1 FROM candidates c JOIN candidate_requests r ON r.candidate_id = c.id
        WHERE c.id = ? AND c.lock_token = ? AND c.lock_until > ? AND r.request_id = ? AND r.superseded = 0`)
        .bind(row.candidate_id, token, Date.now(), row.request_id).first();
      if (!held) throw new AppError(409, "submission_busy", "Confirmation lease expired; retry this request");
    };
    await reservePending(env, fresh ?? row, guard);
    await guard();
    return await publish(env, fresh ?? row, guard, token);
  } finally {
    await env.DB.prepare("UPDATE candidates SET lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?")
      .bind(row.candidate_id, token).run();
  }
}

async function findPr(env: Env, row: CandidateRequest): Promise<Record<string, unknown> | null> {
  const response = await github(env, `/pulls?state=all&head=${encodeURIComponent(`${env.GITHUB_REPO.split("/")[0]}:${row.branch}`)}&base=${encodeURIComponent(env.GITHUB_BRANCH)}`);
  if (!response.ok) throw new AppError(503, "github_unavailable", "Could not inspect submission PR");
  const found = await responseJson(response);
  if (!Array.isArray(found) || found.length > 1) throw invalidGithub();
  if (!found.length) return null;
  prUrl(env, row, found[0]);
  if (found[0].state !== "open" && found[0].state !== "closed") throw invalidGithub();
  return found[0];
}

async function reservePending(env: Env, row: CandidateRequest, guard: () => Promise<void>): Promise<void> {
  const candidate = await env.DB.prepare("SELECT pending_request FROM candidates WHERE id = ?")
    .bind(row.candidate_id).first<{ pending_request: string | null }>();
  if (candidate?.pending_request && candidate.pending_request !== row.request_id) {
    const previous = await env.DB.prepare("SELECT * FROM candidate_requests WHERE request_id = ?")
      .bind(candidate.pending_request).first<CandidateRequest>();
    const pr = previous ? await findPr(env, previous) : null;
    if (!pr && previous?.superseded) {
      await cleanupBranch(env, previous, guard);
      const reserved = await env.DB.prepare("SELECT pending_request FROM candidates WHERE id = ?").bind(row.candidate_id).first<{ pending_request: string | null }>();
      if (reserved?.pending_request === previous.request_id) throw new AppError(503, "github_unavailable", "Could not clean the previous submission; retry");
    } else if (previous && pr?.state === "open" && row.action === "remove") {
      await guard();
      await githubJson(env, `/pulls/${pr.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      const closed = await findPr(env, previous);
      if (closed?.state !== "closed") throw new AppError(503, "github_unavailable", "Previous PR did not close; retry removal");
    } else if (!pr || pr.state !== "closed") {
      throw new AppError(409, "pending_submission", "Resolve the previous submission PR before confirming this request");
    }
  }
  await env.DB.prepare("UPDATE candidates SET pending_request = ? WHERE id = ?")
    .bind(row.request_id, row.candidate_id).run();
}

async function cleanupBranch(env: Env, row: CandidateRequest, guard: () => Promise<void>): Promise<void> {
  if (await findPr(env, row)) return;
  await guard();
  const deleted = await github(env, `/git/refs/heads/${encodeURIComponent(row.branch)}`, { method: "DELETE" });
  if (deleted.status !== 204 && deleted.status !== 404) return;
  const check = await github(env, `/git/ref/heads/${encodeURIComponent(row.branch)}`);
  if (check.status !== 404) return;
  await guard();
  await env.DB.batch([
    env.DB.prepare("UPDATE candidates SET pending_request = NULL WHERE id = ? AND pending_request = ?").bind(row.candidate_id, row.request_id),
    env.DB.prepare("UPDATE candidate_requests SET base_commit = NULL, base_sha = NULL WHERE request_id = ?").bind(row.request_id),
  ]);
}

async function publish(env: Env, row: CandidateRequest, guard: () => Promise<void>, token: string): Promise<unknown> {
  const gh = async (path: string, init?: RequestInit) => {
    await guard();
    const response = await github(env, path, init);
    await guard();
    return response;
  };
  const ghJson = async (path: string, init?: RequestInit) => {
    const response = await gh(path, init);
    if (!response.ok) {
      if (init?.method && [400, 401, 403, 422].includes(response.status)) {
        await cleanupBranch(env, row, guard);
      }
      throw new AppError(503, "github_unavailable", "GitHub request failed; retry this request later");
    }
    return object(await responseJson(response));
  };
  if (!row.base_commit) {
    const ref = await ghJson(`/git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`);
    row.base_commit = gitSha(object(ref.object).sha);
    const baseFile = await gh(`/contents/resumes/${row.candidate_id}.md?ref=${row.base_commit}`);
    if (baseFile.status === 404) row.base_sha = null;
    else {
      if (!baseFile.ok) throw new AppError(503, "github_unavailable", "Could not inspect base file");
      row.base_sha = gitSha(object(await responseJson(baseFile)).sha);
      const allowed = await env.DB.prepare("SELECT 1 FROM candidate_versions WHERE candidate_id = ? AND blob_sha = ?")
        .bind(row.candidate_id, row.base_sha).first();
      if (!allowed) throw new AppError(409, "source_conflict", "Public source is not an approved candidate version; contact support");
    }
    await env.DB.prepare("UPDATE candidate_requests SET base_commit = ?, base_sha = ? WHERE request_id = ?")
      .bind(row.base_commit, row.base_sha, row.request_id).run();
  }
  const unchanged = row.action === "upsert" && row.base_sha === await blobHash(row.content);
  if ((row.action === "remove" && !row.base_sha) || unchanged) {
    await guard();
    await env.DB.batch([
      env.DB.prepare("UPDATE candidate_requests SET completed = 1 WHERE request_id = ?").bind(row.request_id),
      env.DB.prepare("UPDATE candidates SET pending_request = NULL WHERE id = ? AND pending_request = ?").bind(row.candidate_id, row.request_id),
    ]);
    return pending(row);
  }
  const candidate = await env.DB.prepare("SELECT active FROM candidates WHERE id = ?").bind(row.candidate_id).first<{ active: number }>();
  if (row.action === "upsert" && candidate?.active === 0) {
    if (row.base_sha) throw new AppError(409, "removal_pending", "Source deletion must be merged before a new upsert can restore this candidate");
    await guard();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM candidate_versions WHERE candidate_id = ?").bind(row.candidate_id),
      env.DB.prepare(`UPDATE candidates SET active = 1 WHERE id = ? AND lock_token = ? AND lock_until > ?
        AND EXISTS (SELECT 1 FROM candidate_requests WHERE request_id = ? AND superseded = 0)`)
        .bind(row.candidate_id, token, Date.now(), row.request_id),
    ]);
  }
  const branch = await gh(`/git/ref/heads/${encodeURIComponent(row.branch)}`);
  if (branch.status === 404) {
    await ghJson("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${row.branch}`, sha: row.base_commit }) });
  } else if (!branch.ok) throw new AppError(503, "github_unavailable", "Could not inspect submission branch");
  const encoded = btoa(Array.from(new TextEncoder().encode(row.content), byte => String.fromCharCode(byte)).join(""));
  const path = `/contents/resumes/${row.candidate_id}.md`;
  const current = await gh(`${path}?ref=${encodeURIComponent(row.branch)}`);
  if (!current.ok && current.status !== 404) throw new AppError(503, "github_unavailable", "Could not inspect submission file");
  let file = current.status === 404 ? null : object(await current.json());
  if (row.action === "remove") {
    if (file) {
      if (file.sha !== row.base_sha) throw new AppError(409, "submission_conflict", "Submission branch was changed; contact support");
      await ghJson(path, { method: "DELETE", body: JSON.stringify({
        message: `remove resume: ${row.candidate_id}`, branch: row.branch, sha: row.base_sha,
      }) });
      const removed = await gh(`${path}?ref=${encodeURIComponent(row.branch)}`);
      if (removed.status !== 404) throw invalidGithub();
    }
  } else if (typeof file?.content !== "string" || file.content.replace(/\s/g, "") !== encoded) {
    if ((file?.sha ?? null) !== row.base_sha) throw new AppError(409, "submission_conflict", "Submission branch was changed; contact support");
    file = object((await ghJson(path, { method: "PUT", body: JSON.stringify({
      message: `resume: ${row.candidate_id}`, content: encoded, branch: row.branch,
      ...(row.base_sha ? { sha: row.base_sha } : {}),
    }) })).content);
  }
  await guard();
  if (row.action === "upsert" && file) {
    const expected = await blobHash(row.content);
    if (gitSha(file.sha) !== expected) throw invalidGithub();
    const observed = await gh(`${path}?ref=${encodeURIComponent(row.branch)}`);
    if (!observed.ok) throw invalidGithub();
    const savedFile = object(await responseJson(observed));
    if (savedFile.sha !== expected || savedFile.encoding !== "base64" ||
        typeof savedFile.content !== "string" || savedFile.content.replace(/\s/g, "") !== encoded) throw invalidGithub();
    await env.DB.prepare(`INSERT OR IGNORE INTO candidate_versions(candidate_id, blob_sha)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM candidates c JOIN candidate_requests r ON r.candidate_id = c.id
      WHERE c.id = ? AND c.lock_token = ? AND c.lock_until > ? AND r.request_id = ? AND r.superseded = 0)`)
      .bind(row.candidate_id, file.sha, row.candidate_id, token, Date.now(), row.request_id).run();
  }
  const existingPr = await findPr(env, row);
  await guard();
  const pr = existingPr ?? await ghJson("/pulls", { method: "POST", body: JSON.stringify({
    title: `resume: ${row.candidate_id}`, head: row.branch, base: env.GITHUB_BRANCH,
    body: "Submitted through hires.md after email-control verification. This is not identity or employment attestation. Maintainer review is required.",
  }) });
  await guard();
  row.pr_url = prUrl(env, row, pr);
  const observedPr = await findPr(env, row);
  if (!observedPr || prUrl(env, row, observedPr) !== row.pr_url) throw invalidGithub();
  await guard();
  const saved = await env.DB.prepare(`UPDATE candidate_requests SET pr_url = ? WHERE request_id = ? AND superseded = 0
    AND EXISTS (SELECT 1 FROM candidates WHERE id = ? AND lock_token = ? AND lock_until > ?)`)
    .bind(row.pr_url, row.request_id, row.candidate_id, token, Date.now()).run();
  if (saved.meta.changes !== 1) throw new AppError(409, "submission_busy", "Confirmation lease expired; retry this request");
  return pending(row);
}

export async function cleanupCandidates(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM candidate_requests WHERE request_id IN (
    SELECT r.request_id FROM candidate_requests r
    WHERE ((r.verified = 0 AND r.created_at < ?) OR ((r.pr_url IS NOT NULL OR r.completed = 1) AND r.created_at < ?))
    AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.pending_request = r.request_id)
    ORDER BY r.created_at LIMIT 100
  )`).bind(Date.now() - 86400000, Date.now() - 30 * 86400000).run();
}

export async function contact(env: Env, id: string, requesterKey: string): Promise<{ id: string; email: string }> {
  validId(id);
  await rateLimit(env, "contact", requesterKey, 20, 3600000);
  const row = await env.DB.prepare(`SELECT c.id, c.email FROM candidates c
    JOIN candidate_versions v ON v.candidate_id = c.id
    JOIN registry_resumes r ON r.id = c.id AND r.sha = v.blob_sha
    JOIN registry_state s ON s.id = 1 AND r.generation = s.current_generation
    WHERE c.id = ? AND c.active = 1 LIMIT 1`).bind(id).first<{ id: string; email: string }>();
  if (!row) throw new AppError(404, "not_found", "No active published contact for this candidate");
  return row;
}

export async function submit(env: Env, args: Record<string, unknown>, _requesterKey: string): Promise<unknown> {
  object(args);
  if (args.request_id !== undefined) return confirm(env, args);
  validate(args);
  const [local, domain] = String(args.email).split("@");
  args = { ...args, email: `${local}@${domain.toLowerCase()}` };
  await checkOwner(env, String(args.name), String(args.email), String(args.action ?? "upsert"));
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new AppError(503, "mail_unavailable", "Verification email is unavailable");
  const fingerprint = await sha256(JSON.stringify([args.name, args.email, args.action ?? "upsert", args.content ?? "", _requesterKey]));
  const requestId = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, "0");
  const expiresAt = Date.now() + 900000;
  await env.DB.prepare(`INSERT INTO candidate_requests
    (request_id, candidate_id, email, action, content, code_hash, expires_at, created_at, branch, fingerprint)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
      (SELECT 1 FROM candidate_requests WHERE fingerprint = ? AND expires_at > ?)`)
    .bind(requestId, args.name, args.email, args.action ?? "upsert", args.content ?? "", await codeHash(requestId, code), expiresAt, Date.now(), `resume/${crypto.randomUUID()}`, fingerprint, fingerprint, Date.now()).run();
  const existing = await env.DB.prepare("SELECT request_id, expires_at FROM candidate_requests WHERE fingerprint = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(fingerprint, Date.now()).first<{ request_id: string; expires_at: number }>();
  if (existing && existing.request_id !== requestId) return { status: "verification_required", request_id: existing.request_id, expires_at: existing.expires_at };
  try {
    await rateLimit(env, "submission-email", await sha256(String(args.email).toLowerCase()), 3, 3600000);
    await rateLimit(env, "submission-ip", _requesterKey, 5, 3600000);
    await rateLimit(env, "submission-global", "all", 100, 86400000);
  } catch (error) {
    await env.DB.prepare("DELETE FROM candidate_requests WHERE request_id = ?").bind(requestId).run();
    throw error;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [args.email], subject: "Verify your hires.md request",
        text: `Action: ${args.action ?? "upsert"} for ${args.name}\nRequest ${requestId}\nVerification code: ${code}\nExpires in 15 minutes. Do not share this code. Confirm only a request you initiated. Upsert publishes the submitted resume on public GitHub for review and shares this email through the contact tool after publication. Remove immediately hides the registry contact and requests public file deletion, not Git history deletion. This verifies control of your email, not your identity.` }),
    });
    const receipt = await response.json() as { id?: unknown };
    if (response.status !== 200 || typeof receipt?.id !== "string" || !receipt.id) throw new Error("Mail not accepted");
    await env.DB.prepare("UPDATE candidate_requests SET sent = 1 WHERE request_id = ?").bind(requestId).run();
  } catch {
    await env.DB.prepare("DELETE FROM candidate_requests WHERE request_id = ?").bind(requestId).run();
    throw new AppError(502, "mail_failed", "Verification email could not be sent; start a new request");
  }
  return { status: "verification_required", request_id: requestId, expires_at: expiresAt };
}
