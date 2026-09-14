# hires.md agent rules

Branch, PR, squash merge, delete branch. Never push main. Commits are Emad Ghasemyarmaki <ghasemyemad@gmail.com>, no trailers.
No em dash (U+2014) in code, comments, docs, chat.
Stdlib first, no new deps, no plugin systems, no speculative architecture.
Resumes are free-form markdown, no required layout. Privacy is separate: never put contact addresses in git content, metadata, or PR text.
Worker fetch uses redirect manual, never error. Reject 3xx without following.
Secrets only via bindings, never in code, logs, or commands.
Tests where they earn it: trust surface, real logic, schema boundaries. Comments explain why, never what.
Public MCP stays tokenless: search, get, contact, submit. Abuse control is quotas, not tokens.
