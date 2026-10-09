#!/bin/sh
# Rundown Stop hook for Claude Code and Grok Build. Prints a replay URL or one failure line; always exits 0.
#   RUNDOWN_URL     server to post to (e.g. https://rundown.example.com). Unset: generate locally.
#   RUNDOWN_PR_URL  pull request to replay. Unset: the working tree against RUNDOWN_BASE (default main).
#   RUNDOWN_TOKEN   bearer for a server that sets one.

if [ -z "$RUNDOWN_URL" ]; then
  rundown hook ${RUNDOWN_PR_URL:-"--local" "${RUNDOWN_BASE:-main}"} 2>/dev/null || echo "rundown: not installed (npm i -g rundown, or set RUNDOWN_URL)"
  exit 0
fi

if [ -n "$RUNDOWN_PR_URL" ]; then
  body=$(printf '{"pr_url":"%s","wait":true}' "$RUNDOWN_PR_URL")
else
  base=$(git merge-base "${RUNDOWN_BASE:-main}" HEAD 2>/dev/null) || { echo "rundown: no merge base with ${RUNDOWN_BASE:-main}"; exit 0; }
  body=$(git diff --no-color "$base" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({diff:s,wait:true})))')
fi

out=$(printf '%s' "$body" | curl -s -X POST "$RUNDOWN_URL/generate" \
  -H 'content-type: application/json' \
  ${RUNDOWN_TOKEN:+-H "authorization: Bearer $RUNDOWN_TOKEN"} \
  --data-binary @- --max-time 240)

printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.url&&j.status!=="failed"?j.url:"rundown: "+(j.error||"generation failed"))}catch{console.log("rundown: no response from "+process.env.RUNDOWN_URL)}})'
exit 0
