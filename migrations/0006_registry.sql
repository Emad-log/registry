CREATE TABLE registry_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  current_generation INTEGER NOT NULL DEFAULT 0,
  next_generation INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO registry_state(id) VALUES(1);

CREATE TABLE registry_resumes (
  generation INTEGER NOT NULL,
  id TEXT NOT NULL,
  sha TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  PRIMARY KEY(generation, id)
);
CREATE INDEX registry_resumes_sha ON registry_resumes(sha);
CREATE VIRTUAL TABLE registry_fts USING fts5(
  generation UNINDEXED,
  id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);
