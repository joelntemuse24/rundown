# Implementation prompt

Paste the block below into a coding agent, once per phase. Replace `<PHASE>` with one item from `docs/plan.md`, for example `0`, `1.1`, `2`, or `5 (stage 1: sections 5.1 to 5.4 with request delivery)`. Run phases in the order the plan's "Order of work and dependencies" section gives.

```text
You are implementing phase <PHASE> of docs/plan.md in the Rundown repository.

Read first, before writing code:
- README.md, for what Rundown is. It explains a diff. It does not review, score, or approve. Nothing you build may produce verdicts, findings, or suggestions about code quality.
- docs/plan.md, the whole file, then the section for phase <PHASE> again closely. The plan names the files, data shapes, routes, limits, and tests. Follow it. If the code has moved on and the plan no longer fits, do the smallest thing that meets the plan's intent and say what you changed in the PR description.
- The source files the phase touches, end to end, plus src/schema.ts, src/generate.ts, and test/server.test.ts to learn the patterns.

Rules the codebase already follows. Keep them:
- The model's JSON is stored exactly as returned. Never validate, rewrite, or drop fields in a stored replay. Grounding, filtering, and checks happen only in view code (presentReplay and the viewer).
- The facts extractor is conservative. When a fact cannot be determined exactly, leave it out instead of guessing.
- The API key and any user key never appear in logs, replays, asks, exports, or error messages.
- Hosted mode (RUNDOWN_BIND=any) never reads local paths and never uses a shared GITHUB_TOKEN for caller-supplied repos. Any new endpoint looks up its source from a stored replay, never from request input.
- `rundown hook` and every new `rundown record` subcommand print one line and exit 0. Failures go to ~/.cache/rundown/logs/hook.log.
- No new runtime dependency unless the plan names one. Use node:crypto, node:fs, and fetch.
- Match the surrounding style: Preact with CSS modules, small pure functions in src/, comments only for constraints the code cannot show.

Process:
1. Create a branch named for the phase.
2. Write the tests the plan lists for this phase first, and watch them fail. Use the existing mock server in test/server.test.ts for model, GitHub, and OpenRouter calls. Never call real network services from tests.
3. Implement until `pnpm typecheck` and `pnpm test` pass.
4. If the phase changes SYSTEM_PROMPT or SCHEMA_TEXT and the eval harness exists, run `pnpm eval` before and after the change, and put both summaries in the PR description. If a score gets worse, fix the prompt or explain why the trade is worth it.
5. Update README.md (HTTP routes, MCP tools, CLI help, keys, environment variables) and the viewer's `?` help overlay for anything user-visible.
6. For viewer changes, run `pnpm fixture` and check the change by hand at all three depths, in light and dark mode, at desktop and phone widths (under 901 px).
7. Commit in logical steps, push, and open one pull request for the phase. The description says what changed, how it was tested, and any departures from the plan.

Do not start the next phase. Stop after the pull request is open and report:
- What shipped.
- Anything in the plan you changed or skipped, and why.
- Test results, and eval results if there are any.
- Open questions for the next phase.
```
