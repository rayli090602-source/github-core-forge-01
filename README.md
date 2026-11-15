# GitHub Core Forge

Standalone, dependency-free GitHub-compatible forge for the make.fun `github-core-clone-01` bounty.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rayli090602-source/github-core-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rayli090602-source/github-core-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

See the [make.fun bounty page](https://make.fun/bounty/github-core-clone-01).

## Run

Node.js **22.x** is required.

```powershell
node --experimental-strip-types main.ts
```

The server reads `MAKEFUN_SHOP_TOKEN` and binds through the starter lifecycle. It exposes:

- Git smart HTTP upload-pack and receive-pack, including protocol v2 discovery, v0 receive-pack, packs, refs, tags, incremental and shallow fetches.
- GitHub-style REST endpoints under `/api/v3` for repositories, contents, issues, labels, pull requests, commits, and branches.
- GitHub v4-compatible GraphQL endpoint at `/api/graphql`.
- JSON-RPC MCP endpoint at `/mcp`.

## Verification

The implementation is checked against the supplied conformance harness. The Git suite currently passes all 30 direct protocol checks locally, including object hash verification, pack integrity, push/ref handling, incremental fetch, and shallow clone/deepen behavior.

## Public source

<https://github.com/rayli090602-source/github-core-forge-01>
