# Codex

Stdio (local checkout):

```sh
codex mcp add rundown -- rundown mcp
```

HTTP (remote Rundown server), in `~/.codex/config.toml`:

```toml
[mcp_servers.rundown]
url = "https://<host>/mcp"
bearer_token_env_var = "RUNDOWN_TOKEN"
```

Codex then has `explain_change` and `export_replay`. Pass `pr_url` when there is no local checkout.
