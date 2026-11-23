[![node](https://img.shields.io/badge/node-22)][b]
[![score](https://img.shields.io/badge/score-1000)][b]
[![license](https://img.shields.io/badge/license-MIT)][b]

mend — one patch tool for every AI edit format ([bounty][b]).

Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. `mend` reads all four, finds the
lines an edit names even when the model drifted their whitespace or indentation (three matching
tiers), and changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`main.ts` is the CLI (Node 22, standard library alone); `runner.ts` beside it is the trial runner
that hands each check to the CLI in a fresh directory.

[b]: https://make.fun/bounty/hidden-spec-cli-01-run-20261122
