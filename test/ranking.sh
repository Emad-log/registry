#!/bin/bash
# ranking test: 10 diverse queries, each must return the expected top candidate
set -u
BASE="${BASE:-https://hires-md.hires-md.workers.dev}"
TOK="${TOK:?need TOK}"

declare -a QUERIES=(
  "machine learning engineer|sofia-reyes"
  "ML inference optimization quantization|sofia-reyes"
  "staff engineer scaled payments infrastructure|maya-chen"
  "fintech team leadership Go distributed systems|maya-chen"
  "rust compiler contributor|arjun-patel"
  "wasm runtime performance engineering|arjun-patel"
  "security engineer zero trust cryptography|petra-lindqvist"
  "OAuth OIDC threat modeling PKI|petra-lindqvist"
  "full-stack product engineer React TypeScript|daniel-okafor"
  "onboarding activation A/B testing product sense|daniel-okafor"
)

PASS=0; FAIL=0
for pair in "${QUERIES[@]}"; do
  Q="${pair%%|*}"; EXPECT="${pair##*|}"
  TOP=$(curl -s --max-time 60 -X POST "$BASE/search" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"query\":\"$Q\",\"top_n\":1}" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(r[0]['id'] if r else 'NONE')" 2>/dev/null)
  if [ "$TOP" = "$EXPECT" ]; then
    PASS=$((PASS+1)); echo "PASS  $Q -> $TOP"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $Q -> got '$TOP' want '$EXPECT'"
  fi
done
echo "PASS $PASS/10"
[ "$PASS" -eq 10 ]
