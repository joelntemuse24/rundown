# Eval corpus

23 public pull requests, each saved as `<case>.patch` at the merge-base and head
SHAs in `<case>.meta.json`, with the title, body, and commit subjects the prompt uses.
The cases are pinned, so a run does not drift as the upstream pull requests change.

| Case | Repository | Pull request | Base | Head | License |
| --- | --- | --- | --- | --- | --- |
| `cobra-completion-args` | `spf13/cobra` | https://github.com/spf13/cobra/pull/2356 | `61968e893eee2f27696c2fbc8e34fa5c4afaf7c4` | `a36b43475f0a868310fdce4ead976a0cfb8173ea` | Apache-2.0 |
| `cobra-unique-args` | `spf13/cobra` | https://github.com/spf13/cobra/pull/2397 | `f2878bab8c96afd6e36968af96343b35dbb82a82` | `fbf2bdf5304548e4348c89b92e0e8067834c26fe` | Apache-2.0 |
| `express-dep-bump` | `expressjs/express` | https://github.com/expressjs/express/pull/7563 | `1c6f1b0fe4000977b9a7b4f34097e4d527dd9824` | `b403cf7a9fda8e4cdf563448f4c4f4469bcaae22` | MIT |
| `express-docs-triage` | `expressjs/express` | https://github.com/expressjs/express/pull/7529 | `a419aa7350389a275ab45fde2e849ed1f02449ef` | `7382480e21da43937ec74fb8930c95ef0f67c9e7` | MIT |
| `express-request-tests` | `expressjs/express` | https://github.com/expressjs/express/pull/7112 | `0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8` | `058e230c351f3338d4dfccff737352cb11e2192e` | MIT |
| `flask-app-query` | `pallets/flask` | https://github.com/pallets/flask/pull/6133 | `3596b1ab61cea85edb8970e83ff61daa073facf8` | `89992954ec71b594b1b911f98977cdc8ad46a057` | BSD-3-Clause |
| `flask-ipv6-partition` | `pallets/flask` | https://github.com/pallets/flask/pull/6096 | `514fc6b3e8402e4c646d5284e97a4f0ab50a7c4b` | `7203feabf723edae0286ae5dc64fec8ac4c91735` | BSD-3-Clause |
| `gin-context-copy` | `gin-gonic/gin` | https://github.com/gin-gonic/gin/pull/4854 | `3b08cd7235bd5ad2f055aa9e38135f111f6c5926` | `18ac953cb3a9ac9a790509c97a44abdaa998d823` | MIT |
| `gin-skipped-nodes` | `gin-gonic/gin` | https://github.com/gin-gonic/gin/pull/4852 | `1bd0ecf2d3e08da37efa270bb7be20c1eddb0d68` | `742c541a91ceb6d177429f24b87bc4d81abb3868` | MIT |
| `gin-value-panic` | `gin-gonic/gin` | https://github.com/gin-gonic/gin/pull/4819 | `d8f2d588d7573b3438cfc95b7a47f9ec8966273c` | `2c2068ff3dc45b128962514179f075bc4a70be43` | MIT |
| `preact-event-handlers` | `preactjs/preact` | https://github.com/preactjs/preact/pull/5349 | `4bfd080333c55d7df795f2815d373ed93ceadf79` | `91315713cdcd2212a056183a59eb3122e43cd7af` | MIT |
| `preact-layout-effect` | `preactjs/preact` | https://github.com/preactjs/preact/pull/5321 | `697666724ad6f9a992fc61f3b36d94de483602de` | `d9a50d799e03b6b6605206e7426ef33c6867a8ad` | MIT |
| `preact-pnpm-migration` | `preactjs/preact` | https://github.com/preactjs/preact/pull/5246 | `e3e2658c46e53f2171c670f6e9f6fd7c0005f948` | `d56de153f39f5da92570fe8580c5944cb6897f85` | MIT |
| `preact-vnode-recognition` | `preactjs/preact` | https://github.com/preactjs/preact/pull/5335 | `1c0f1f82340f096e5850386d617d6a3885693001` | `aa9775892996c74af0bd99046e9bdfeca2041a22` | MIT |
| `requests-netloc-leak` | `psf/requests` | https://github.com/psf/requests/pull/6963 | `7bc45877a86192af77645e156eb3744f95b47dae` | `92bab7d1142db0c807060577233568e5f7734c9b` | Apache-2.0 |
| `requests-ssl-context` | `psf/requests` | https://github.com/psf/requests/pull/6767 | `8ff173b186f135670879db9fbe1e68a6b5209c89` | `11d68c17bcd66bd3e2c5137b0a7aad7f59967102` | Apache-2.0 |
| `ripgrep-globset-basenames` | `BurntSushi/ripgrep` | https://github.com/BurntSushi/ripgrep/pull/3561 | `9d07a922605313dc47b78b802c7b0616fd76d409` | `bc036bd28ec0a35e2e0bd42acd302600a005b290` | MIT OR Unlicense |
| `ripgrep-incremental-ignore` | `BurntSushi/ripgrep` | https://github.com/BurntSushi/ripgrep/pull/3472 | `fc3dd04b7ca18ec8be97704dc098bbd062bad244` | `250fe3603946430aa034cd63426da916db4af431` | MIT OR Unlicense |
| `ripgrep-revert-index` | `BurntSushi/ripgrep` | https://github.com/BurntSushi/ripgrep/pull/3573 | `7cc9c2f33cff3f027d42509489bae9942f833dae` | `ced122bcbf1f9b2e4f701085bb195cfbebbd0deb` | MIT OR Unlicense |
| `serde-field-i` | `serde-rs/serde` | https://github.com/serde-rs/serde/pull/3038 | `5fd91333c7dc942a2f54539b17982f0c5bbc0790` | `ea04847eef1683aea818f2b6382b29b07cc1344b` | MIT OR Apache-2.0 |
| `sinatra-markdown-tests` | `sinatra/sinatra` | https://github.com/sinatra/sinatra/pull/2182 | `0c88089be7668326ec5ed52671732f8565a16353` | `fff72e8311aaaae5787ba827059483101c7f4e98` | MIT |
| `tokio-barrier-reset` | `tokio-rs/tokio` | https://github.com/tokio-rs/tokio/pull/8645 | `4890d027f8a566ccf081e7f019ed766f780df1af` | `e8fd5eb7bbd5358e9db8f8d42b7cdd8c6cec970b` | MIT |
| `tokio-taskdump-borrow` | `tokio-rs/tokio` | https://github.com/tokio-rs/tokio/pull/8728 | `b980c95d4755697ee376f5e19b95c328e173e304` | `60bc59ddac34d8c0773cf38a04c98c7cf82e357d` | MIT |

The patches are upstream code, reproduced unmodified for evaluation under those licenses.
Each license was read from the repository at the pinned head SHA, not from memory; the exact
file is recorded as `license_file` in each meta file. All of them permit redistribution.

## Rebuilding

`build-meta.mjs` reads `repo` and `number` from the existing `*.meta.json` files, so the meta
files are the single source of truth. It refreshes the title, body, commits, SHAs, patch, and
license:

```sh
node eval/corpus/build-meta.mjs --check    # report what would change, write nothing; exits 1 if anything would
node eval/corpus/build-meta.mjs            # every case
node eval/corpus/build-meta.mjs flask-app-query   # one case
```

Run `--check` first: a refresh re-downloads each patch, and the corpus is only useful for
comparing runs if it stays the same. The license comes from GitHub's license API at the pinned
head. Dual-licensed repositories (ripgrep, serde) have no single SPDX id there, so those cases
keep their hand-checked value and the script lists them for a manual look.

It needs `gh` on `PATH`. It is not part of the build, and no test calls it.
