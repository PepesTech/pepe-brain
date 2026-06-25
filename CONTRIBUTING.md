# Contributing

Thanks for working on **pepe-brain**. Keep changes small and tested.

## Setup

See the [Quickstart](README.md#quickstart-teammates): `bun install`, and have `bun` + `opencode`
on your `PATH` with the `opencode-go` provider authenticated (`opencode auth list`).

## Branch & PR flow

`main` is **protected** (PR + green CI required) and is the stable branch. Do not push to it directly.

```bash
git checkout dev && git pull
git checkout -b feat/<short-name>     # branch off dev
# …work…
bun run test                          # MUST pass before you push (free, offline)
git push -u origin feat/<short-name>
gh pr create --base main              # open a PR into main
```

CI (`.github/workflows/ci.yml`) runs `bun run test` (26 offline guardrail tests, no model calls/secrets)
plus a build check on every push/PR. Get it green; request a review; merge into `main`.

## Where things live

- `mcp/lib.ts` — core: spawn opencode, the `opencode-go` provider lock, `STACK`, `MODEL_ALIASES`, modes.
- `mcp/server.ts` — the 3 MCP tools (`opencode_go_run` / `_fanout` / `_models`).
- `scripts/` — `selftest.ts` (`bun run test`), `benchmark.ts` (`bun run bench`), `check-server.ts`.
- `.claude/skills/delegate-to-go/` — the auto-orchestration skill (the team's main interface).
- `.claude/commands/delegate.md` — the `/delegate` slash command.

## Conventions

- The provider lock is the security boundary — every model id must funnel through `normalizeModel()`.
- Changing the model stack? Justify it with `bun run bench` (see the README "Evaluating new models").
- Add a guardrail test in `scripts/selftest.ts` for any new invariant; keep CI offline (no model calls).
