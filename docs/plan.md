# Implementation plan: what to take from Chronosphere, and what else to fix

Chronosphere (getchronosphere.com) replays a pull request as steps and then lets you review and merge it on GitHub. Rundown's position is narrower and should stay that way: it explains a change, it does not review, score, or approve. This plan adopts the parts of Chronosphere that make a change easier to understand, skips the parts that make it a review tool, and adds a few fixes that make every later phase safer to ship.

Phases are ordered so each one is useful on its own and later phases build on earlier ones. Each phase lists the files it touches, the data it adds, how it is tested, and what it deliberately leaves out.

| Phase | What | Size |
| --- | --- | --- |
| 0 | Foundations: eval harness, prompt version in the cache key, truncation banner, citation check | Small, mostly new files |
| 1 | Viewed tracking and diff context expansion | Small to moderate, viewer plus one endpoint |
| 2 | Step dependencies ("builds on") | Moderate: schema, prompt, facts, viewer |
| 3 | Ask about a line | Moderate: new endpoint, prompt, viewer panel, MCP tool |
| 4 | Connect your own OpenRouter account | Moderate: OAuth (PKCE), encrypted cookie, CSRF guard |
| 5 | Recorded replays | Large: recording format, CLI, hooks, generation path, viewer |

Not planned: GitHub sign-in, review comments, approve and merge, AI review findings, "send to agent". Reasons are at the end.

---

## Phase 0: Foundations

These are small, and phases 2, 3 and 5 all change the prompt or the schema, so they need to be in place first.

### 0.1 Eval harness

Today, prompt changes are checked by hand against one fixture. Phases 2 and 5 change the prompt, so there needs to be a way to see whether quality went up or down.

- New `eval/` directory:
  - `eval/corpus/*.patch` plus `eval/corpus/*.meta.json` (title, body, commits): 15 to 25 public PRs saved as patches at pinned SHAs, so results do not drift as the PRs change. Pick a spread: small bugfix, dependency bump, new feature with tests, refactor across many files, a PR big enough to be truncated, and at least one each in Python, Go and Rust (the languages `facts.ts` handles).
  - `eval/run.ts`: for each case, runs `prepareDiff` and `buildMessages` and calls the configured model through `complete()`, bypassing the cache. Writes `eval/out/<date>-<model>.json` plus a one-screen summary.
- Scores, all computed with no model:
  - JSON parse rate on the first attempt and after the repair call.
  - Share of evidence values (`path:line`) that land inside a hunk of the diff (use `parseEvidence` and `hunkSpan`).
  - Allowed-name compliance: dependency names, function names and test files that appear in the closed sets from `limitsFor`.
  - Shape: step count between 3 and 8, no more than two critical steps, `logic.step_id` pointing at real steps, a diagram only when `hasChain` is true.
  - From phase 2: `builds_on` ids that exist and come earlier.
  - Prompt and completion tokens per case.
- `pnpm eval` script. It is not part of `pnpm test`, because it costs model calls. CI only runs a smoke version of the scorer against `fixtures/sample.replay.json`.
- Rule from here on: a prompt change ships with an eval run attached to the PR, comparing scores before and after.

### 0.2 Prompt version in the cache key

`cacheKey` hashes `diff_hash + SCHEMA_VERSION + model`. Changing `SYSTEM_PROMPT` or `SCHEMA_TEXT` without bumping `SCHEMA_VERSION` keeps serving replays written under the old prompt.

- `src/prompt.ts`: `export const PROMPT_VERSION = sha256(SYSTEM_PROMPT + SCHEMA_TEXT).slice(0, 8)`.
- `src/generate.ts`: `cacheKey(diffHash, model, extra = '')` hashes `${diffHash}:${SCHEMA_VERSION}:${PROMPT_VERSION}:${model}:${extra}`. `extra` is used by phase 5 for the recording hash.
- Store `prompt_version` on `StoredReplay`, and show it in the viewer footer next to the model.
- Old documents stay readable by id. A new generation for the same diff is a cache miss, which is the intended behavior.
- Test: change the prompt text in a test and check that the cache key changes.

### 0.3 Truncation banner

`truncateDiff` drops files once the 80k budget is used up and tells the model so, but the reader is never told. A replay can look complete when the model never saw some files.

- `src/prompt.ts`: have `truncateDiff` also return `{ text, omitted: string[], summarised: string[] }`. `summarised` lists large new files shown to the model only as signatures plus their first and last 40 lines.
- `src/generate.ts`: store `prompt_coverage: { omitted, summarised }` on `StoredReplay`.
- `web/src/Viewer.tsx`: a banner like the existing stale-head banner: "The model did not see 3 files: …" (each file a link that opens it in "Files not in this step"), plus a quieter line for summarised files.
- Test: a patch over budget produces `omitted`, and the viewer renders the banner. Use the existing server test pattern and assert on `/r/:id.json`.

### 0.4 Citation check, as a view only

Commit `e3b8f77` deliberately stores the model's JSON unchanged. The check below changes nothing stored. It only changes how a citation is drawn.

- `src/schema.ts`: `citationInDiff(files, evidence): boolean`, which is true when the `path:line` lands inside a hunk on the new side, or on the old side for a deleted file.
- `Viewer.tsx`, inside `Cite`: when the citation is not in the diff, draw it muted with the title "This line is not in the diff". Clicking it still tries to jump there.
- Footer: "2 citations point outside the diff" when the count is above zero. This matches the score from 0.1, so what readers see and what the eval measures agree.
- Test: unit test `citationInDiff` against `fixtures/sample.patch`.

---

## Phase 1: Viewed tracking and diff context expansion

### 1.1 Viewed tracking

This makes a large replay easier to work through and needs no server change.

- Storage: `localStorage['rundown-viewed:' + doc.id]` holds a JSON array of step ids. Keying by replay id means a regenerated replay (new head, so a new id) starts fresh, which is correct because its steps differ.
- `Viewer.tsx`:
  - `viewed: Set<string>` state, loaded on mount and saved on change. Wrap access in `try` as the theme code does, because exported files opened from `file://` may have no storage.
  - Sequence list: a check mark in place of the step number for viewed steps.
  - Step head: a "Viewed" checkbox button.
  - Header: "4 of 7 viewed". This counts only steps visible at the current depth, so switching depth changes the denominator, never the stored set.
  - Keys: `v` toggles the current step, `n` goes to the next unviewed step and wraps around. Add both to the help list.
  - When every visible step is viewed, `n` says "All steps viewed" through the existing `say()`.
- Not doing: marking steps viewed automatically when you navigate away. Chronosphere makes it manual, and automatic marking turns "viewed" into "scrolled past".
- Test: there are no viewer component tests today. Add `@testing-library/preact` with `happy-dom` to vitest for this and later phases, rendering `ReplayView` with the sample fixture. Cover toggling, `n` wrapping, and the count changing with depth.

### 1.2 Diff context expansion

Steps show cited windows with three lines of context, and "Rest of this file" reveals whole hunks. Neither shows code outside the hunks, such as the function a hunk sits in.

- Server: `GET /r/:id/file?path=<path>&side=new|old` returns `{ lines: string[] }`.
  - The path must be in `doc.facts.files`. The server never reads arbitrary paths or arbitrary repos, because it looks up the source from the stored document. This keeps the endpoint safe on a hosted server.
  - `source.kind === 'pr'`: GitHub contents API `GET /repos/{o}/{r}/contents/{path}?ref={facts.head}` (the old side uses `facts.base`), with `accept: application/vnd.github.raw`. Add a `fetchFile(ref, path, sha, token)` to `src/github.ts` next to `fetchHead`. It uses the request's GitHub token, the same rule as `/generate`.
  - `source.kind === 'local'`, and the server is not hosted: read `join(source.root, path)` from the working tree, because local diffs include uncommitted changes. Normalize the path and refuse anything that resolves outside `root`. The old side is `git show {facts.base}:{path}`.
  - `diff` and `fixture` sources, and exported pages: return 404, and the viewer hides the buttons.
  - An in-process LRU cache keyed by `id:path:side`, capped at about 200 files. Files over 1 MB return 413.
- `web/src/DiffView.tsx`:
  - Gap rows between hunks and at the top and bottom of a file: "Show 20 lines above", "Show 20 lines below", and "Show all N hidden lines" when the gap is 40 lines or fewer.
  - Expanded lines are context lines. New-side numbers come from the fetched file. Old-side numbers are computed from the offset between the neighbouring hunks' `oldStart` and `newStart`.
  - Expanded rows carry `data-loc`, so citations that point just outside a hunk (see 0.4) can scroll to them once expanded.
  - Expansion state lives per file, keyed by path, in `Viewer.tsx`, and survives step changes.
- `web/src/data.ts`: `fetchFileLines(id, path, side)` with a module-level promise cache.
- Test: extend the mock server in `test/server.test.ts` to answer `/repos/acme/api/contents/...`. Cover a 404 for a path that is not in the diff, a 404 for a diff source, path traversal refused for a local source, and a component test that a gap row expands.

---

## Phase 2: Step dependencies ("builds on")

Readers need to know what to read first, and a flat sequence does not say which steps are prerequisites and which are independent. Rundown can ground these links in the call edges from its facts, which Chronosphere does not appear to do.

### 2.1 Facts: local module edges

- `src/facts.ts`: add `local_imports: Array<{ from: string; to: string; line: number }>`. For each `imports_added` entry whose specifier is relative (`./`, `../`), or a Python, Go or Rust module that resolves to a path in the diff, resolve it to a file in `facts.files`. Try the extensions for its language and `index.*`. Keep it conservative: resolve only exact matches and leave everything else out, the same rule the rest of `facts.ts` follows.
- Shown to the model in the facts JSON, and used by the viewer in 2.3.
- Test: `test/facts.test.ts` cases for a TypeScript relative import, `index.ts` resolution, a Python relative import, and an unresolvable specifier that is left out.

### 2.2 Schema and prompt

- `src/schema.ts`: `Step.builds_on: string[]`. In `PresentedStep`, `buildsOn` keeps only ids that exist and come earlier in the sequence. That guarantees no cycles and no forward references whatever the model wrote, and the stored JSON is unchanged.
- `SCHEMA_VERSION` becomes 2. `presentReplay` already treats missing fields as empty, so version 1 documents render with no dependencies.
- `src/prompt.ts`, `SCHEMA_TEXT`: add `"builds_on": ["s1"]` to the step shape, plus one rule: "builds_on lists the earlier step ids a reader must understand first: a step that calls, imports, or configures something an earlier step adds. [] for a self-contained step. Only earlier ids." Also add to the ordering rule: "Put self-contained steps before the steps that build on them."
- Run the eval from 0.1 before and after. Score the share of `builds_on` links that are grounded (see 2.3), and check that ordering did not get worse.

### 2.3 Grounding, as a view only

- `src/schema.ts`: `groundDependency(view, facts, a, b)` returns the reason step `b` builds on step `a`, or null:
  - `b` cites a function that has a `call_edges` entry to a function `a` cites, so the reason is "calls `validateToken`".
  - `b` cites a file with a `local_imports` entry into a file `a` cites, so the reason is "imports `src/limiter.ts`".
  - A file both steps cite, where `b`'s lines come after `a`'s within one function, so the reason is "extends `handleLogin`".
- Viewer: a grounded link shows its reason. A link only the model claims shows without one, in a muted style, the same treatment as in 0.4.
- Not doing: adding links the model did not write. A grounded link that the model missed can show as a quiet suggestion, but only at deep depth.

### 2.4 Viewer

- Step head: a "Builds on" row of chips (`s1 · Add the limiter`), each with its reason. Clicking a chip selects that step. A chip for a step hidden at the current depth (`visibleSteps` may drop it) reads "hidden at shallow", and clicking it raises the depth by one and selects it.
- Sequence list: steps with no `builds_on` get a small "self-contained" mark. Steps that later steps depend on show a count, for example "2 steps build on this".
- A diff-scope toggle in the step head: "This step" or "With prerequisites". With prerequisites shows the union of `citedHunks` over the transitive `buildsOn` closure, with each file section labelled by the step it comes from.
- A "Map" view (optional, last): a toggle in the sequence column that lays steps out in levels, with self-contained steps at the bottom and dependents above, similar to Chronosphere's tree. It reuses the existing nav buttons and needs no graph library.
- Keys: `p` toggles "With prerequisites".
- Test: component tests for chips, hidden-at-depth chips, and the prerequisite scope. A schema unit test for `buildsOn` filtering forward references, self references and unknown ids.

---

## Phase 3: Ask about a line

This lets a reader get an explanation on demand. It stays inside "explain": answers say what the code does and where, not whether it is good.

### 3.1 Server

- `POST /r/:id/ask` with `{ path, line, question, thread? }`:
  - Validation: the document is ready, `path` is in `facts.files`, `line` is inside a hunk (or an expanded context line from 1.2, which the server re-reads from the file endpoint's cache), and the question is 1 to 500 characters. `thread` is an earlier ask id for follow-ups, with at most 4 turns.
  - Context, kept small on purpose to stay cheap on the free model:
    - The hunk containing the line, plus 40 lines either side from the file when it is available.
    - The PR title, `intent.text`, and the summary of every step that cites the line.
    - Facts filtered to that file: `functions_touched`, `call_edges` touching those functions, and `imports_added` in the file.
    - Earlier turns of the thread.
  - `src/prompt.ts`, `ASK_SYSTEM_PROMPT`: "You explain one line of a diff to a reader. Say what it does, what reaches it, and what it reaches, citing path:line from the diff or facts. If the diff does not show the answer, say so in one sentence. Do not review, praise, or suggest changes." It returns `{ "answer": "", "evidence": ["path:line"] }`. Parse it with `parseModelJson`. If the reply is not JSON, store the raw text as `answer` with no evidence, with no repair call.
  - Storage: `<cache>/asks/<replay id>.json` holds `[{ id, path, line, question, thread, answer, evidence, model, at }]`, written atomically like `writeReplay`. The cache key is `sha256(replay id + path + line + normalized question + thread)`, so a repeated question is free.
  - `GET /r/:id/asks` lists them. The viewer loads it with the replay and shows earlier answers inline.
  - Limits: anonymous callers on a hosted server get a separate quota of 30 asks per IP per day (`limiter` already has the shape for this). Callers with `RUNDOWN_TOKEN` or their own OpenRouter key (phase 4) are not limited.
- MCP: an `ask_about_line({ id, path, line, question })` tool, so an agent can ask the same thing. It returns `{ answer, evidence }`.

### 3.2 Viewer

- `DiffView.tsx`: clicking a line number selects that line, highlights it, and puts `?L42` in the URL hash after the step id. A selected line shows an "Ask" button in the gutter, and `a` opens it from the keyboard.
- The ask panel renders inline under the line, like logic notes do today (the `aside` with class `s.note`):
  - Preset buttons: "What calls this?", "What does this reach?", "What happens if this fails?", "Why is this here?". Chronosphere's "Is this necessary?" is left out because it is a review question.
  - A free-text field and an answer with clickable citations (reusing `Cite`).
  - "Ask a follow-up" continues the thread.
- Earlier asks on visible lines show as a small marker in the gutter, which expands to show the question and answer.
- Answers render as plain text. Preact already escapes strings, and no markdown is rendered, so a diff that contains instructions aimed at the model can at worst change the answer's wording.
- Exported HTML: `buildExportHtml` inlines existing asks read-only, with no Ask button.
- Hosted servers: shared replays mean shared asks. Say so in the panel ("Questions on this replay are visible to anyone with the link"). Add `RUNDOWN_ASK=off` to turn the feature off.
- Test: extend the mock model to answer ask prompts. Cover validation errors, a cached second ask making no model call, the quota, a prose reply stored as the answer, and the MCP tool over HTTP.

---

## Phase 4: Connect your own OpenRouter account

The hosted server depends on the free model and a limit of 10 replays per IP per day. Spec section 12 asks for per-user model keys and rules out a user database. OpenRouter's PKCE flow gives a per-user key without one.

- Enabled only when `RUNDOWN_SECRET` (32 or more bytes) is set. Without it the button is hidden and nothing changes.
- Routes in `src/server.ts`:
  - `GET /auth/openrouter`: generates a PKCE verifier, stores it in a short-lived signed cookie (`rd_pkce`, 10 minutes), and redirects to `https://openrouter.ai/auth?callback_url=<origin>/auth/openrouter/callback&code_challenge=<S256>&code_challenge_method=S256`.
  - `GET /auth/openrouter/callback?code=`: `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method: "S256" }`, which returns `{ key }`. The key is encrypted with AES-256-GCM under `RUNDOWN_SECRET` into the cookie `rd_or` (HttpOnly, Secure on hosted, SameSite=Lax, 30 days), then the server redirects back to the page the user came from.
  - `POST /auth/logout`: clears the cookie.
  - `POST /settings/model`: stores a chosen model id in a plain cookie, `rd_model`. Defaults to `cfg.model`.
- New `src/session.ts`: `seal(value)`, `open(cookie)` and cookie parsing, all on `node:crypto`, with no new dependency.
- Request handling: when `rd_or` opens, `/generate`, `/r/:id/ask` and `/r/:id/file` use `{ ...cfg, apiKey: userKey, model: userModel }` and skip the IP quota.
- CSRF: once cookies grant capability, POST routes need a check. For cookie-authenticated requests, require `Origin` (or `Referer`) to match `origin(req)`, plus `content-type: application/json`. Bearer-authenticated agent calls are unaffected.
- Viewer and home page: "Connect OpenRouter" or "Connected · model ▾" in the top bar. A failed generation on the free model offers "Connect OpenRouter and retry".
- Caching: replays stay keyed by model, not by user. A replay generated with one user's key is served from cache to the next person who asks for the same diff and model, the same as today. Document this.
- Logging: the key never reaches logs, replays or the asks store. Extend the existing "never writes the key into the replay or the log" test to cover the cookie path.
- Test: mock `openrouter.ai` through a new `OPENROUTER_URL` override. Cover the full callback flow, a tampered cookie being ignored, a cross-origin POST with a cookie returning 403, the quota being skipped with a key, and logout.

---

## Phase 5: Recorded replays

This is the largest gain. Rundown would replay what the agent actually did, in the order it happened, with its reasoning and commands, instead of reconstructing an order afterwards. Rundown's hooks and adapters for seven agents are already the delivery channel.

### 5.1 Recording format (`rundown-recording/1`)

```json
{
  "format": "rundown-recording/1",
  "agent": { "name": "claude-code", "model": "…" },
  "repo_root_name": "api",
  "base": "<sha the session started from>",
  "started_at": "…",
  "checkpoints": [
    {
      "id": "c1",
      "at": "…",
      "title": "Add the limiter module",
      "note": "Why the agent did this, in its words, at most 1,000 characters",
      "tree": "<git tree sha>",
      "patch": "<unified diff from the previous checkpoint's tree, or base for c1>",
      "commands": [{ "cmd": "pnpm test", "exit": 1, "output_tail": "last 2 KB, redacted" }]
    }
  ],
  "final_tree": "<tree sha>"
}
```

- Stored at `.git/rundown/recording.json`, inside `.git` so it is never committed and needs no `.gitignore` entry.
- Snapshots must not touch the user's index or working tree. Run `GIT_INDEX_FILE=<tmp> git read-tree HEAD`, then `GIT_INDEX_FILE=<tmp> git add -A`, then `git write-tree`, which gives a tree sha. `git diff-tree -p <prev> <tree>` gives the checkpoint patch. The patch text is stored, so the tree objects can be garbage-collected later without breaking anything.
- Limits: at most 50 checkpoints, 200 commands, a 2 KB output tail per command, and 5 MB in total. Past those, the oldest command output is dropped first, never checkpoints.
- Redaction (new `src/redact.ts`), applied when the recording is written, not when it is sent:
  - Values of environment variables whose names match `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` and are 8 characters or longer.
  - Patterns such as `ghp_…`, `github_pat_…`, `sk-…`, `sk-or-…`, `AKIA…`, `xox[bp]-…`, and private key blocks.
  - Replaced with `[redacted]`. Unit tests cover every pattern.

### 5.2 Capture

- New `src/record.ts` and CLI subcommands in `src/cli.ts`:
  - `rundown record start [--base main]` begins a session at the merge base.
  - `rundown record checkpoint "<title>" [--note "<why>"]` snapshots the tree. If nothing changed since the last checkpoint, it updates that checkpoint's note in place.
  - `rundown record command` reads a hook payload on stdin and appends the command to the pending list, which the next checkpoint takes.
  - `rundown record finish` writes `final_tree` and prints the path.
  - `rundown record status` shows the checkpoints so far.
  - Like `rundown hook`, every `record` subcommand exits 0 and logs failures to `hook.log`, so a recording problem never breaks the agent's turn.
- MCP tools on the stdio server only (they need the checkout): `record_checkpoint({ title, note, commands? })` and `record_finish()`.
- Adapters:
  - Claude Code and Grok Build: a `PostToolUse` hook on `Bash` calling `rundown record command`, and the existing Stop hook gains `rundown record checkpoint "<last user prompt, first line>"`, so every agent turn produces at least one checkpoint.
  - A `rundown-record` skill (`adapters/skills/rundown-record/SKILL.md`): tells the agent to call `record_checkpoint` after each coherent unit of work, with a title and a one-paragraph note on why, and to keep checkpoints to one idea each.
  - Cursor, Codex, Hermes and VS Code: the MCP tool plus the skill. Where an agent has a post-shell hook, wire `record command` the same way. Otherwise the agent passes commands to `record_checkpoint`.

### 5.3 Delivery

Stage 1 sends the recording with the request:

- `POST /generate` accepts `{ diff, recording }` or `{ repo, base, recording: true }` (local only, read from `.git/rundown/recording.json`).
- `rundown hook --recording` and the stop hooks send it when a recording exists.
- The MCP `explain_change` tool gains `use_recording?: boolean`.

Stage 2 attaches the recording to a PR:

- `rundown record publish --pr <url>` uploads the recording as a secret gist with the user's `GITHUB_TOKEN`, then posts or updates a sticky PR comment: `<!-- rundown-recording gist=<id> sha256=<hash> -->`. This uses the same sticky-comment pattern as `adapters/github/rundown.yml`.
- `preparePr` lists PR comments and looks for the marker. It accepts it only when the comment's author is the PR's author, fetches the gist, and checks the hash.
- A gist is not the only option. Chronosphere also accepts a file attached to the comment. Gists come first because they need only the token the user already has.

### 5.4 Generation from a recording

- `src/generate.ts`, `prepareDiff(diff, { recording })`: validate the format, run redaction again (defense in depth), and compute `recording_hash`. Then check consistency: apply the checkpoint patches in order and compare the result with the final diff. Record which files changed after the last checkpoint (`unrecorded_files`). Never fail on a mismatch; report it instead.
- Cache key: `cacheKey(diff_hash, model, recording_hash)`, using `extra` from 0.2.
- Prompt, in `src/prompt.ts` (`buildRecordedMessages`):
  - The same facts and limits as today, plus the checkpoints (title, note, command summaries) and each checkpoint's patch, shortened by the same budget rules.
  - The model must keep checkpoint order. It writes one step per checkpoint and may merge adjacent trivial checkpoints. Each step gets `checkpoint_ids: ["c1"]`.
  - The intent can come from the notes, so `intent.source` gains the value `"recording"`.
  - Dependencies, logic, tests, open questions and functions are written as today, against the final diff.
- With no API key, a replay can still be built from the recording alone: steps come directly from the checkpoint titles and notes, and there is no narrative. The fixture path proves this works.

### 5.5 Viewer

- Header badge: "Recorded by claude-code · 6 checkpoints" or "Reconstructed by `<model>`", using the same `SOURCE_MARK` treatment.
- A recorded step shows:
  - The agent's note, labelled "Agent's note" so it is distinct from the model's summary.
  - Commands run during the step, collapsed by default, with the exit code and output tail. Failed commands are visible, because a failing test followed by a fix is often the most useful part of the story.
  - The step's own patch, rendered with the existing `HunkView` (`parseDiff` already handles any unified diff).
  - Lines that the final PR no longer contains are marked "changed later", found by matching added lines' text against the final diff for that path. A toggle switches between "As recorded" and "As in the final PR", which uses the existing windowed view.
- A banner when the recording and the PR disagree: "4 files changed after the last checkpoint", listing them. Those files appear as a final synthetic step, "After the recording".
- Fixture: `fixtures/sample.recording.json` next to `sample.patch`, so `--fixture` shows a recorded replay with no key.

### 5.6 Tests

- `record.ts` against a temporary git repo: checkpoints never change `git status` or the index, patches compose to the final diff, the caps hold, and redaction removes planted secrets from command output.
- `/generate` with a recording: the cache key differs from the same diff without one, `unrecorded_files` is detected, and the no-key path builds steps from the checkpoints.
- `preparePr` finds the gist marker only from the PR author's comment, and rejects a hash mismatch. The mock serves the comments and gist APIs.
- Component tests: the recorded badge, collapsed commands, the "changed later" marker, and the toggle between as-recorded and final.

---

## Other improvements worth doing alongside

These are small and independent, so they can be scheduled into any phase:

- **README and help:** each phase updates the HTTP table, MCP section, keys list and `rundown --help`. The viewer's `?` overlay stays the source of truth for keys.
- **Mobile:** the step column and rail already collapse under 901 px. Check that the ask panel and gap rows from phases 1 and 3 work on touch: tapping a line number selects the line, with no hover-only buttons.
- **Accessibility:** step chips, viewed toggles and gap rows are buttons with labels. The ask panel moves focus to its input when it opens and back to the line when it closes. `aria-live` is used for "All steps viewed".
- **Large PRs, later:** when `prompt_coverage.omitted` is not empty, offer "Write a second pass for the omitted files". That would be a second model call over only those files, merged as extra steps. This is noted here, not planned, until the eval shows how often truncation happens.

## Not planned, and why

- **GitHub sign-in, review comments, approve, merge:** this needs OAuth, write access to repositories and session storage, which the spec rules out. GitHub already does review well, and Rundown would become a weaker Chronosphere.
- **AI review (scout and reviewer findings):** findings and verdicts are review. Rundown's "does not cover" notes and failure modes keep the useful part without making judgments.
- **"Send to agent":** this closes a review loop Rundown is not part of. Revisit after phase 5. If recordings make Rundown part of the agent's working loop, a "copy for agent" with step context (which exists today) may be enough.

## Order of work and dependencies

1. Phase 0 comes first. 0.2 and 0.1 are prerequisites for any prompt change.
2. Phase 1 is independent and can run in parallel with phase 0.
3. Phase 2 needs 0.1 and 0.2.
4. Phase 3 needs 1.2 for context lines beyond the hunk, though it works without them. Phase 4 makes it affordable on a hosted server.
5. Phase 4 is independent, but best shipped before phase 3 reaches a hosted server.
6. Phase 5 needs 0.2's `extra` key component and benefits from 1.1 (viewed) and 2.4 (scope toggle, which it reuses for the as-recorded and final toggle). Stage 1 of delivery ships before stage 2.

Each phase ships as its own pull request, or as several for phases 3 and 5, with tests and the README update in the same pull request.
