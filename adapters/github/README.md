# GitHub Actions

`rundown.yml` runs on every pull request, posts the PR URL to `$RUNDOWN_URL/generate`, and writes the replay URL and three-line summary into the job summary. It does not post a review. A single sticky comment is opt-in with the repository variable `RUNDOWN_COMMENT=1`.

This is the hook a cloud agent already has: it does not depend on the agent remembering to call `explain_change`.

Private repositories: the hosted public server only reads public repos. Run your own server with `GITHUB_TOKEN` set in its environment.
