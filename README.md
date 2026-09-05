# hires.md

Your resume is a markdown file. You own it. Agents find you through it.

An open registry of resumes as plain `.md` files - queryable by any recruiter's AI agent. No accounts, no forms, no lock-in. Free.

## Add your resume

**If you use git:**
1. Add `resumes/your-name.md` - write it however you want. It's just markdown.
2. Open a PR. That's the whole signup.

**If you don't:**
Paste this into ChatGPT / Claude / any chat agent:

```text
I want to create a resume as a markdown file. Ask me questions about my
work history, skills, and impact, then write a clean markdown resume.
Ask me for links that prove my biggest claims (repos, PRs, launches)
and add them next to those claims. When done, output the final file
ready to submit to the hires.md registry.
```

It interviews you, writes the file, and hands it back. Then [open a PR](../../compare) with it - or email it to `resumes@hires.md`.

## The rules (all of them)

1. **One `.md` file per person**, in `/resumes`
2. **No contact info in the file.** Your email goes in the PR description (or via email submission) and is stored server-side only. Recruiters get it through an authenticated, rate-limited API call - never from scraping the repo.
3. **Claims are unverified.** This is an open registry, not an attestation service. Which is why you should:
4. **Link your proof.** Put the repo, PR, or launch URL right next to the claim it backs. Proof-linked claims rank higher in search results - trust is literally self-interest here.
5. **Leave any time.** Delete your file in a PR; you're out of the index and the store within minutes. Note: deleting removes you from the index and the live repo, but public git history retains past versions. Use an email you don't mind being public.

No format. No schema. No minimum. Write it like a person, not a database row.

## For recruiters (agents)

Get a token by emailing `resumes@hires.md` (free, hand-issued for now).

Three tools at `https://hires.md/mcp`:

- `search(query, top_n)` - hybrid semantic + keyword search, returns ranked raw markdown
- `get(id)` - one full resume
- `contact(id)` - the candidate's email (rate-limited, logged)

Your agent reads the resumes and does the judging - that's the design. The endpoint gives you recall and receipts; the reasoning stays in your agent, where you're already paying for it.

### Add to your agent

**Claude Code:**
```bash
claude mcp add hires-md --transport http https://hires.md/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.hires-md]
url = "https://hires.md/mcp"
http_headers = { Authorization = "Bearer YOUR_TOKEN" }
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "hires-md": {
      "url": "https://hires.md/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Run locally

```bash
npm install
wrangler dev
```

Requires a Cloudflare account with D1 + Workers AI enabled. Copy `wrangler.jsonc`, set your `database_id`, and create the secrets (`ADMIN_TOKEN`, `GITHUB_TOKEN`, `RESEND_API_KEY`, `MAIL_FROM`).

## Why this exists

Hiring is going agent-native. When a recruiter's agent goes looking for candidates, it should find *your file* - a file you own, that renders anywhere, that you can fork and take with you - not rows in a closed database.

Resumes are ads, not secrets. The only private thing (your email) never touches the repo.

## License

- Resumes: CC0 (submit yours under whatever you want, this is our default)
- Code: MIT

Fork it. If we ever enshittify this, fork it and take the corpus with you - that's the point.
