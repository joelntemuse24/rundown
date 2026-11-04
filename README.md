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

Replays live in `~/.cache/rundown/<id>.json` with their facts and canonical diff. The cache key is diff hash + schema version + prompt version + model id, so the same diff replays for free, and editing any part of the prompt invalidates old entries instead of serving them. Token counts per call are in `~/.cache/rundown/logs/<diff_hash>.json`.

## How a replay is made

1. **Facts** (`src/facts.ts`): files, added/removed imports, manifest dependency changes, test files, touched functions, and call edges, extracted statically from the diff (conservative regexes for JS/TS, Python, Go, Rust, Ruby). No model.
2. **Model** (`src/prompt.ts`, `src/model.ts`): one call with the fixed system prompt, the facts, PR title/body and commit subjects, and the diff truncated to 80k characters (manifests and tests kept whole). Which files were dropped or summarised is stored on the replay and shown to the reader.
3. **Model output** (`src/schema.ts`, `src/generate.ts`): the reply is stored as parsed JSON, with no validation and no rewriting. A replay fails only when the reply is not JSON. That gets one repair call; a second unparseable reply stores no replay. The page shows a missing field as nothing, and a diagram Mermaid cannot draw as plain text.
4. **Viewer** (`web/`): a pure function of the stored JSON, the depth, and the diff. Shallow, median, and deep are views over one document, so switching depth never calls the model. A citation outside every hunk is drawn muted and counted in the footer; the stored JSON is unchanged.

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
pnpm eval        # scores the corpus against the configured model; costs model calls
```

## Eval

`eval/corpus/` holds 23 public pull requests saved as patches at the merge-base and head SHAs they were taken from, with their title, body, and commit subjects. The spread covers a dependency bump, a docs change, tests-only, a multi-file refactor, a new feature, a new crate, and one PR big enough to hit the 80k truncation; there are cases in JavaScript/TypeScript, Python, Go, Rust, and Ruby. Each meta file records the license read from the repository at that pinned head SHA, and [`eval/corpus/README.md`](eval/corpus/README.md) tabulates every case. `node eval/corpus/build-meta.mjs` refreshes a case from the repo and number already in its meta file.

`pnpm eval` runs each case through `buildMessages` and the configured model with no cache, writes `eval/out/<date>-<model>.json`, and prints a one-screen summary. Everything it scores is computed with no model:

- JSON parsed on the first attempt, and after the one repair call.
- The share of `path:line` evidence that lands inside a hunk.
- Whether dependency, function, and test names come from the closed sets `limitsFor` prints.
- Shape: 3 to 8 steps, at most two critical, `logic.step_id` pointing at a real step, a diagram only when `hasChain` says so.
- Prompt and completion tokens per case.

A case whose reply is missing, unreadable, never repaired into JSON, or whose call threw is counted as **failed**, printed with `N failed` in the headline, and excluded from every share. A run of nothing but failures therefore reports zeroes rather than looking clean.

`eval/run.ts` is not part of `pnpm test` because it costs calls. `test/eval.test.ts` runs the same scorer against `fixtures/sample.replay.json`, so CI catches a scorer that drifts. `pnpm eval --dry <dir>` scores saved `<case>.json` replies with no model calls.

Any change to the prompt ships with an eval run in its pull request, comparing scores before and after. `PROMPT_VERSION` is the first eight hex of a fingerprint over the whole rendered prompt — both text blocks, every branch of `limitsFor`, the section layout, the repair text, `DIFF_BUDGET`, and the truncation thresholds — so editing any of them is a cache miss rather than a stale replay.

## Packaging

`npm pack` builds first and ships only `bin`, `dist`, `web/dist`, `fixtures`, `adapters`, and `README.md`. `dist/` and `web/dist/` are gitignored, so `prepack` runs the build; without it an installed package has no `dist/cli.js` and `bin/rundown.js` falls back to `tsx`, which is only a dev dependency. The fixture is packed, so `rundown --fixture fixtures/sample.patch` works from an install.

## Not in v1

GitHub sign-in, per-user model keys, and personal tokens are not built. The spec asks for them in section 12 and rules out OAuth login and a user database in the same section, so this build takes the smaller reading. Private repos work on a self-hosted server with `GITHUB_TOKEN`, or by sending your own GitHub token as `Authorization: Bearer` (any bearer that is not `RUNDOWN_TOKEN` is used only as that request's GitHub token).
