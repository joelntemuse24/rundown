# Claude Code

Local stdio MCP: copy `.mcp.json` to your project root. Claude Code can then call `explain_change` and `export_replay`. The stdio server also starts the viewer on `127.0.0.1:5200` if nothing is running there.

When Claude Code is not on the same machine as Rundown, use the HTTP server instead:

```sh
claude mcp add --transport http rundown https://<host>/mcp
# with a server token:
claude mcp add --transport http rundown https://<host>/mcp --header "Authorization: Bearer $RUNDOWN_TOKEN"
```

Stop hook: copy `stop-hook.sh` to `.claude/rundown-stop-hook.sh` and merge `settings.json` into `.claude/settings.json`. With `RUNDOWN_URL` set it posts the PR URL (`RUNDOWN_PR_URL`) or the working-tree diff to that server. Without it, it runs `rundown hook --local`. It prints the replay URL and always exits 0.
