# hires.md — domain day runbook

Everything is built, deployed, and tested. This runs the moment you own hires.md.

## What's live right now

- **Worker:** https://hires-md.hires-md.workers.dev (health, search, get, contact, MCP, reindex, admin endpoints)
- **D1:** `hires-md` (id `0ca63b8b-14a7-4b6a-9b13-ed0968f60c52`) — 5 seed resumes indexed, embeddings working
- **Repo:** github.com/Emad-log/registry (PRIVATE — your public-GitHub-is-Iolit-only rule; flip when ready)
- **GitHub Action:** auto-reindex on merge to `resumes/**` (secrets `HIRES_ENDPOINT` + `HIRES_ADMIN_TOKEN` set)
- **Tokens:** in vault (`hires-md-tokens.asc`, `workers-deploy-token.asc`); PAT-backed deploys via `~/.git-pat`
- **Search quality:** verified — right candidate ranks #1 with clear margin on every test query

## Day-you-buy-the-domain (3 commands)

```bash
# 1. attach the domain (after adding hires.md zone to Cloudflare)
#    wrangler.jsonc: add "routes": [{"pattern": "hires.md/*", "custom_domain": true}]

# 2. update github secret HIRES_ENDPOINT to https://hires.md
# 3. curl https://hires.md/health  ->  {"ok":true}
```

Email routing (resumes@hires.md → gmail) is a Cloudflare dashboard toggle, same as iolit.dev.

## Full endpoint surface

| route | auth | what |
|-------|------|------|
| `GET /health` | none | liveness |
| `POST /search` `{query, top_n}` | bearer | hybrid vector+keyword search, returns ranked raw md (emails stripped) |
| `POST /get` `{id}` | bearer | one full resume |
| `POST /contact` `{id}` | bearer | candidate email (20/hr rate limit, logged) |
| `POST /mcp` | bearer | JSON-RPC MCP server: initialize / tools/list / tools/call (search, get, contact) |
| `POST /reindex` | admin | pull repo → embed → index (the Action calls this on merge) |
| `POST /admin/token` `{label}` | admin | mint a recruiter token |
| `POST /admin/email` `{id, email}` | admin | register a candidate email server-side |

## Known limits (v1, deliberate)

- No auth flow for recruiter tokens — hand-issued, as planned
- Query log exists (`query_log` table) but the monthly "you appeared in N searches" email isn't wired — cron or manual, later
- README example emails (`maya@example.dev` etc.) are fake seeds
- Repo private until you say public

## Deploy from this box

```bash
cd /home/ubuntu/hires-md
export CLOUDFLARE_API_TOKEN=$(gpg --decrypt ~/.hermes/vault/workers-deploy-token.asc)
node ./node_modules/wrangler/bin/wrangler.js deploy
```
