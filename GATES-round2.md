# GATES — hires.md hardening round (round 2)

## gate r1: MCP initialize handshake works
- CHECK: curl -s -X POST $BASE/mcp -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | grep -o '"serverInfo"'
- EXPECT: "serverInfo"

## gate r2: get tool returns full resume and 404s cleanly on unknown id
- CHECK: curl -s -X POST $BASE/get -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"id":"maya-chen"}' | grep -c 'Stripe'
- EXPECT: 1

## gate r3: unknown id returns 404
- CHECK: curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/get -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"id":"nobody-here"}'
- EXPECT: 404

## gate r4: bad token rejected with 401
- CHECK: curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/search -H "Authorization: Bearer wrong-token" -H "Content-Type: application/json" -d '{"query":"x"}'
- EXPECT: 401

## gate r5: contact rate limit fires at 20/hour
- CHECK: for i in $(seq 1 22); do curl -s -o /dev/null -w "%{http_code} " -X POST $BASE/contact -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"id":"maya-chen"}'; done | grep -c "429"
- EXPECT: 1

## gate r6: emails never appear in any surface (search, get, mcp search)
- CHECK: (curl -s -X POST $BASE/search -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"query":"engineer","top_n":30}'; curl -s -X POST $BASE/get -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"id":"maya-chen"}') | grep -vc '@' 
- EXPECT: 2

## gate r7: 10 diverse queries each return the expected top candidate
- CHECK: bash /home/ubuntu/hires-md/test/ranking.sh
- EXPECT: PASS 10/10

## gate r8: reindex is idempotent (no dupes, same count)
- CHECK: ADMIN=$ADMIN bash -c 'curl -s -X POST $BASE/reindex -H "Authorization: Bearer $ADMIN" | grep -o "indexed.:[0-9]*"' 
- EXPECT: "indexed":5
