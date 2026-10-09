# Grok Build

A plugin folder: `.mcp.json`, `hooks/hooks.json`, and `hooks/stop-hook.sh` (the same script as the Claude Code hook).

- Local `grok` session: the `rundown` stdio entry.
- Remote `grok` session: the `rundown-remote` HTTP entry pointing at `https://<host>/mcp`. Remove whichever you do not use.

The Stop hook posts to `$RUNDOWN_URL/generate` when `RUNDOWN_URL` is set, otherwise runs `rundown hook --local`. It prints the replay URL and always exits 0.
