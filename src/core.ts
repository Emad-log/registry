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

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "invalid_params", "expected an object");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new AppError(400, "invalid_params", `${field} must be nonblank text of at most ${max} characters without control characters`);
  }
  return value;
}

export function privateText(value: string): boolean {
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    decoded = decoded.replace(/&#(x[\da-f]+|\d+);?/gi, (_, code: string) => {
      const number = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
      return number <= 0x10ffff ? String.fromCodePoint(number) : "";
    }).replace(/&commat;/gi, "@").replace(/&period;/gi, ".");
    decoded = decoded.replace(/%[0-9a-f]{2}/gi, pair => String.fromCharCode(parseInt(pair.slice(1), 16)));
  }
  return decoded.includes("@") || /mailto:/i.test(decoded) || decoded.includes(String.fromCharCode(0x2014));
}

export async function rateLimit(env: Env, scope: string, key: string, max: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO request_limits(scope, key, at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM request_limits WHERE scope = ? AND key = ? AND at > ?) < ?"
  ).bind(scope, key, now, scope, key, now - windowMs, max).run();
  if (!result.success) throw new AppError(503, "unavailable", "quota storage unavailable");
  if (result.meta.changes !== 1) throw new AppError(429, "rate_limited", "request limit reached; try again later");
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  if (!/^[-a-zA-Z0-9_.]+\/[-a-zA-Z0-9_.]+$/.test(env.GITHUB_REPO) || !path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path)) {
    throw new AppError(500, "configuration_error", "invalid repository path");
  }
  const url = new URL(base + path);
  if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/repos/${env.GITHUB_REPO}/`)) {
    throw new AppError(500, "configuration_error", "repository path escaped its scope");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "hires-md");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  try {
    return await fetch(url.toString(), { ...init, headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    throw new AppError(503, "github_unavailable", "GitHub request failed; retry this request later");
  }
}

export function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new AppError(400, "invalid_params", "name must be a lowercase slug of 1 to 64 letters, digits or internal hyphens");
  }
  return value;
}
