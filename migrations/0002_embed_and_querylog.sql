-- add embedding column and query log
ALTER TABLE resumes ADD COLUMN embedding BLOB;
CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id TEXT,
  at INTEGER NOT NULL
);
