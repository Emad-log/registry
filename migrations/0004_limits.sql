CREATE TABLE request_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX request_limits_window ON request_limits(scope, key, at);
CREATE INDEX request_limits_expiry ON request_limits(at);
