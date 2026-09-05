#!/bin/bash
# handshake test: the exact sequence an MCP client runs before it will use the server
set -u
BASE="${BASE:-https://hires-md.hires-md.workers.dev}"
TOK="${TOK:?need TOK}"
AUTH="Authorization: Bearer $TOK"
JSON="Content-Type: application/json"

PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS+1)); echo "PASS  $1"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $1 -> got '$2' want '$3'"
  fi
}
post() { curl -s --max-time 60 -X POST "$BASE/mcp" -H "$AUTH" -H "$JSON" -d "$1"; }
field() { python -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo NONE; }

# 1. initialize answers in the version the client asked for
V=$(post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | field "d['result']['protocolVersion']")
check "initialize echoes client protocol version" "$V" "2024-11-05"

# 2. the post-initialize notification: no id, so it must get an empty 202 and no response object
CODE=$(curl -s -o /tmp/mcp-notif.txt -w "%{http_code}" --max-time 60 -X POST "$BASE/mcp" -H "$AUTH" -H "$JSON" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
check "notifications/initialized status" "$CODE" "202"
check "notifications/initialized body is empty" "$(cat /tmp/mcp-notif.txt)" ""

# 3. tools are listed
N=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | field "len(d['result']['tools'])")
check "tools/list returns 3 tools" "$N" "3"

# 4. ping is answered
P=$(post '{"jsonrpc":"2.0","id":3,"method":"ping"}' | field "d['result'] == {}")
check "ping returns empty result" "$P" "True"

# 5. protocol error codes are the JSON-RPC ones, not a blanket internal error
C=$(post '{"jsonrpc":"2.0","id":4,"method":"resources/list"}' | field "d['error']['code']")
check "unknown method is -32601" "$C" "-32601"
C=$(post '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope","arguments":{}}}' | field "d['error']['code']")
check "unknown tool is -32602" "$C" "-32602"

# 6. no SSE stream here, so GET must say so rather than 404
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 "$BASE/mcp" -H "$AUTH")
check "GET /mcp is 405" "$CODE" "405"

# 7. auth is still required
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 -X POST "$BASE/mcp" -H "$JSON" -d '{"jsonrpc":"2.0","id":6,"method":"tools/list"}')
check "no token is 401" "$CODE" "401"

echo "PASS $PASS/9"
[ "$FAIL" -eq 0 ]
