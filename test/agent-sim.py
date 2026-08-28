#!/usr/bin/env python
"""simulate a recruiter agent: MCP initialize -> tools/list -> search -> get -> contact,
verifying the full JSON-RPC flow a real MCP client would run."""
import json, urllib.request

BASE = "https://hires-md.hires-md.workers.dev"
TOK = open("/tmp/search-token.txt").read().strip()

def rpc(method, params=None, req_id=1):
    payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    req = urllib.request.Request(
        f"{BASE}/mcp",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {TOK}",
            "Content-Type": "application/json",
            "User-Agent": "recruiter-agent/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

# 1. initialize
r = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "recruiter-agent", "version": "1.0"}})
print("1. initialize ->", r["result"]["serverInfo"])

# 2. tools/list
r = rpc("tools/list", req_id=2)
tools = [t["name"] for t in r["result"]["tools"]]
print("2. tools/list ->", tools)
assert tools == ["search", "get", "contact"], "wrong tools"

# 3. search like a recruiter would
r = rpc("tools/call", {"name": "search", "arguments": {"query": "we need someone who has scaled a payments team and knows Go", "top_n": 3}}, req_id=3)
results = json.loads(r["result"]["content"][0]["text"])
print(f"3. search -> {len(results)} results, top: {results[0]['id']} (score {results[0]['score']})")
assert results[0]["id"] == "maya-chen", f"expected maya-chen, got {results[0]['id']}"

# 4. get the full resume
r = rpc("tools/call", {"name": "get", "arguments": {"id": results[0]["id"]}}, req_id=4)
resume = r["result"]["content"][0]["text"]
print(f"4. get -> {len(resume)} chars, starts: {resume[:60]!r}")
assert "Stripe" in resume

# 5. contact
r = rpc("tools/call", {"name": "contact", "arguments": {"id": results[0]["id"]}}, req_id=5)
contact = json.loads(r["result"]["content"][0]["text"])
print(f"5. contact -> {contact}")

# 6. error handling: unknown tool
r = rpc("tools/call", {"name": "nonexistent", "arguments": {}}, req_id=6)
print("6. unknown tool -> error code", r["error"]["code"], "-", r["error"]["message"][:60])

print()
print("AGENT SIMULATION: PASS - full MCP client flow works end to end")
