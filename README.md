# Rundown

Rundown writes a median replay of a diff: one page a human can read to follow what landed, in what order, which libraries it depends on, where the logic branches, and what the tests lock. It explains. It does not review, score, or approve.

A person pastes a GitHub PR link on the site. An agent, hook, or MCP client posts the same link (or a diff) to the same server. Local and hosted are the same binary with the same API.

## Quick start

```sh
pnpm install
pnpm build
node bin/rundown.js --fixture fixtures/sample.patch   # no key, no model call; opens the sample replay
```

The page is served from `http://127.0.0.1:5200`. `pnpm fixture` does the same from source without building the server.

To replay real changes, give it any OpenAI-compatible endpoint. The default is OpenRouter's free model:

```sh
export RUNDOWN_API_KEY=sk-or-...                 # OpenRouter key
node bin/rundown.js https://github.com/owner/repo/pull/123
node bin/rundown.js --local main                 # this repo's working tree vs main
node bin/rundown.js --diff change.patch
```

Install the `rundown` command globally with `pnpm link --global` (or `npm i -g .`).

## CLI

```
rundown <pr-url>
rundown --local [base]
rundown --diff file.patch
rundown --fixture fixtures/sample.patch
rundown --export <id> --output replay.html
rundown --depth median|shallow|deep
rundown --no-open
rundown serve          # HTTP server
rundown mcp            # stdio MCP server
rundown hook [...]     # for agent hooks: prints a URL or one failure line, always exits 0
```

Human invocations exit 1 when generation fails. `rundown hook` always exits 0 and appends errors to `~/.cache/rundown/logs/hook.log`.

## Configuration

`~/.config/rundown/config.json`:

```json
{ "baseURL": "", "apiKey": "", "model": "", "depth": "median", "port": 5200 }
```

| Variable | Meaning |
| --- | --- |
| `RUNDOWN_BASE_URL` | OpenAI-compatible base URL. Default `https://openrouter.ai/api/v1` |
| `RUNDOWN_API_KEY` | Model key. Never logged, never written into a replay |
| `RUNDOWN_MODEL` | Model id. Default `openrouter/free` |
| `RUNDOWN_DEPTH` | Depth the page opens at |
| `RUNDOWN_TOKEN` | Shared bearer for agents on `/generate` and `/mcp`. Empty means open |
| `RUNDOWN_BIND` | `any` to listen on `0.0.0.0` (hosting). Anything else stays on `127.0.0.1` |
| `PORT` | Port. Default 5200 |
| `GITHUB_TOKEN` | Self-hosted single-user installs only: lets the server read private repos |
| `RUNDOWN_CACHE_DIR` | Cache location. Default `~/.cache/rundown` |
| `RUNDOWN_URL` | For hooks: the server to post to |

Replays live in `~/.cache/rundown/<id>.json` with their facts and canonical diff. The cache key is diff hash + schema version + model id, so the same diff replays for free. Token counts per call are in `~/.cache/rundown/logs/<diff_hash>.json`.

## How a replay is made

1. **Facts** (`src/facts.ts`): files, added/removed imports, manifest dependency changes, test files, touched functions, and call edges, extracted statically from the diff (conservative regexes for JS/TS, Python, Go, Rust, Ruby). No model.
2. **Model** (`src/prompt.ts`, `src/model.ts`): one call with the fixed system prompt, the facts, PR title/body and commit subjects, and the diff truncated to 80k characters (manifests and tests kept whole).
3. **Validation** (`src/schema.ts`): zod for shape, then grounding. Every path must be in the diff, every evidence line must fall inside a hunk's new-file range, dependencies must come from the facts, at most two critical steps, a diagram only when the call edges form a three-edge chain. Prose is rejected. One repair call gets the validator messages; a second failure stores no replay.
4. **Viewer** (`web/`): a pure function of the stored JSON, the depth, and the diff. Shallow, median, and deep are views over one document, so switching depth never calls the model.

## HTTP

| Route | |
| --- | --- |
| `GET /` | Paste field and the replays on this server |
| `POST /generate` | `{ pr_url }`, `{ diff }`, or `{ repo, base }` (local only); optional `depth`, and `wait: true` to block until done. Returns `{ id, url, text, status }` |
| `GET /r/:id` | Viewer |
| `GET /r/:id.json` | Replay plus facts; the page polls this while `status` is `pending` |
| `POST /export` | `{ id, output? }` writes one HTML file and returns `{ path }`. With `Accept: text/html` it returns the file |
| `POST /mcp`, `GET /mcp` | Streamable HTTP MCP |

## MCP

Two tools, over stdio (`rundown mcp`) or HTTP (`/mcp`):

- `explain_change({ repo, pr_url | base | patch_path, depth? })` returns `{ url, summary, id }`. Over HTTP only `pr_url` is accepted, which needs no checkout.
- `export_replay({ id, output? })` returns `{ path }`.

Configs for Claude Code, Cursor (local and cloud), Codex, Grok Build, Hermes, VS Code, and a GitHub Action are in [`adapters/`](adapters/).

## Hosting

```sh
pnpm install && pnpm build
RUNDOWN_BIND=any PORT=8080 RUNDOWN_API_KEY=sk-or-... node bin/rundown.js serve
```

One process and the on-disk cache; give it a persistent volume for `RUNDOWN_CACHE_DIR`. Anonymous `/generate` calls are limited to 10 new replays per IP per day; cached replays are free. Callers with `RUNDOWN_TOKEN` are not limited. The server never falls over to a paid model: if the free model is unavailable, the page says so. Do not set a shared `GITHUB_TOKEN` on a public server.

## Viewer keys

`j`/`k` steps, `[`/`]` depth, `d` dark, `e` export, `y` copy URL, `?` help.

## Development

```sh
pnpm test        # builds the viewer, then runs the unit and server tests
pnpm typecheck
pnpm serve       # server from source on 127.0.0.1:5200
pnpm dev:web     # Vite dev server on 5201, proxying the API to 5200
```

## Not in v1

GitHub sign-in, per-user model keys, and personal tokens are not built. The spec asks for them in section 12 and rules out OAuth login and a user database in the same section, so this build takes the smaller reading. Private repos work on a self-hosted server with `GITHUB_TOKEN`, or by sending your own GitHub token as `Authorization: Bearer` (any bearer that is not `RUNDOWN_TOKEN` is used only as that request's GitHub token).
