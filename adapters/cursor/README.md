# Cursor, local and cloud

**Cloud agents.** Add the HTTP MCP server in the agent's MCP settings: URL `https://<host>/mcp`, plus an `Authorization: Bearer <RUNDOWN_TOKEN>` header if your server sets one. Cursor dials HTTP MCP from its backend, so nothing runs on your laptop. Never point a cloud agent at `127.0.0.1`.

Ask the agent to call `explain_change` with `repo` and `pr_url` after it opens a pull request, and to put the returned `url` in the PR body. For example, as a project rule:

> After you open or update a pull request, call the `rundown` tool `explain_change` with the PR URL and add the returned replay URL to the PR description under "Replay".

Because that depends on the agent remembering, also install the GitHub Action in `adapters/github/`. It writes the replay URL into the job summary on every pull request.

**Local.** `mcp.json` has both entries: `rundown` (HTTP) and `rundown-local` (stdio, `rundown mcp`). Copy it to `.cursor/mcp.json` and keep the one you use.

**Webview.** The VS Code extension in `adapters/vscode/` also works in Cursor. It only iframes `/r/:id`.
