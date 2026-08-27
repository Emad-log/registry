# hires.md — the product

A public registry where resumes are plain markdown files in a git repo, queryable by recruiter agents through a search endpoint.

**Candidates:** add `resumes/your-name.md` → open a PR → merged. That's it.
**Recruiters:** point your agent at the MCP endpoint. Ask "who's scaled a payments team to 20+?" → get the best-matching raw resumes back. Your agent reads, verifies, picks.

## For candidates

Your resume is one markdown file. Write it however you want — no format, no schema, no form. Structure it in any way that reads well. Two optional conventions that help discovery:

- a `open to:` line anywhere (roles you're looking for)
- links to proof (repos, PRs, launches) right next to the claims they back

Rules that exist:
1. One `.md` file per person, in `/resumes`
2. **No contact info in the file** — recruiters get your email through the `contact` tool, never from scraping the repo. Add your email via the PR template when you submit, and it's stored server-side only
3. Delete your resume any time — just delete the file in a PR
4. Claims are **unverified** — this is an open registry, not an attestation service. Links to proof are yours to add

## For recruiter agents

MCP endpoint: `https://hires.md/mcp`

Three tools:

| tool | what it does |
|------|--------------|
| `search(query, top_n)` | Hybrid (semantic + keyword) search over the corpus. Returns ranked raw markdown |
| `get(id)` | Fetch one full resume by id |
| `contact(id)` | Returns the candidate's email. Rate-limited and logged |

Get a token: `resumes@hires.md` (free, hand-issued for now).

## For agent users (candidates without an MCP client)

Paste this into any chat agent (ChatGPT, Claude, etc.):

```text
I want to create a resume as a markdown file. Ask me questions about my
work history, skills, and impact, then write a clean markdown resume.
Ask me for links that prove my biggest claims (repos, PRs, launches)
and add them next to those claims. When done, output the final file
ready to submit to github.com/hires-md/registry.
```

## License

Corpus: CC0. Code: MIT.
