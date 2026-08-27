-- hires.md schema
CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY,            -- filename stem, e.g. 'maya-chen'
  sha TEXT,                       -- last commit sha the content was indexed from
  content TEXT NOT NULL,          -- raw markdown, contact info stripped
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS resumes_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,            -- matches resumes.id
  email TEXT NOT NULL             -- server-side only, never indexed, never in repo
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token TEXT PRIMARY KEY,         -- random secret
  label TEXT,                     -- who it belongs to
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_label TEXT,
  resume_id TEXT,
  at INTEGER NOT NULL
);
