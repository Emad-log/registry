# GATES — hires.md build

## gate 1: repo scaffold complete
- CHECK: test -f /home/ubuntu/hires-md/README.md && test -f /home/ubuntu/hires-md/wrangler.jsonc && test -d /home/ubuntu/hires-md/resumes && ls /home/ubuntu/hires-md/resumes/*.md | wc -l
- EXPECT: 5

## gate 2: worker deploys and answers health check
- CHECK: curl -s https://HIRESWORKER.workers.dev/health
- EXPECT: {"ok":true}

## gate 3: reindex pulls repo and indexes all resumes
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/reindex -H "Authorization: Bearer $ADMIN_TOKEN" | grep -o '"indexed":[0-9]*'
- EXPECT: "indexed":5

## gate 4: semantic search finds the right person
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/search -H "Authorization: Bearer $SEARCH_TOKEN" -H "Content-Type: application/json" -d '{"query":"staff engineer who scaled payments infrastructure"}' | grep -c 'maya-chen'
- EXPECT: 1

## gate 5: keyword search works
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/search -H "Authorization: Bearer $SEARCH_TOKEN" -H "Content-Type: application/json" -d '{"query":"rust compiler"}' | grep -c 'arjun-patel'
- EXPECT: 1

## gate 6: contact tool returns email server-side
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/contact -H "Authorization: Bearer $SEARCH_TOKEN" -H "Content-Type: application/json" -d '{"id":"maya-chen"}'
- EXPECT: {"email":"maya@example.dev"}

## gate 7: MCP protocol responds to tools/list
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/mcp -H "Authorization: Bearer $SEARCH_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"search"'
- EXPECT: "name":"search"

## gate 8: search results never leak emails
- CHECK: curl -s -X POST https://HIRESWORKER.workers.dev/search -H "Authorization: Bearer $SEARCH_TOKEN" -H "Content-Type: application/json" -d '{"query":"machine learning"}' | grep -vi 'contact' | grep -c '@'
- EXPECT: 0
