CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at INTEGER NOT NULL,
  pending_request TEXT,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE candidate_versions (
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  blob_sha TEXT NOT NULL,
  PRIMARY KEY(candidate_id, blob_sha)
);

CREATE TABLE candidate_requests (
  request_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  email TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'remove')),
  content TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  branch TEXT NOT NULL UNIQUE,
  pr_url TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  base_commit TEXT,
  base_sha TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
