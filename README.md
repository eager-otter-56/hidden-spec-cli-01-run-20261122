[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eager-otter-56/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/eager-otter-56/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format ([bounty][b]).

Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. `mend` reads all four, finds the
lines an edit names even when the model drifted their whitespace or indentation (three matching
tiers), and changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`main.ts` is the CLI (Node 22, standard library alone); `runner.ts` beside it is the trial runner
that hands each check to the CLI in a fresh directory.

[b]: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
