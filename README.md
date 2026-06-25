# pepe-brain — opencode-go multi-agent bridge

Bridge that lets **Claude Code orchestrate `opencode` workers** as tools, hard-locked
to the **OpenCode Go** provider (`opencode-go/*`: Qwen, GLM, Kimi, DeepSeek, MiniMax, MiMo).

Claude Code is the orchestrator (Opus). Each worker is a headless `opencode run`
forced onto an `opencode-go/<model>`. It is impossible to reach OpenCode Zen,
OpenAI, or any other provider through these tools — every model string funnels
through `normalizeModel()`, which throws on any non-`opencode-go` prefix.

## Quickstart (teammates)

**Prerequisites:** Claude Code, plus [bun](https://bun.sh) and the [opencode](https://opencode.ai)
CLI on your `PATH`. **Each person needs their own OpenCode Go credential** — it is NOT shared via the
repo. Run `opencode auth list`; it must show `opencode-go` (else `opencode auth login`).

```bash
git clone git@github.com:PepesTech/pepe-brain.git
cd pepe-brain
bun install
bun run check          # lists the 3 tools + models -> everything wired
```

Then in Claude Code:
1. Open the `pepe-brain` folder.
2. Approve the **`opencode-go`** MCP server when prompted (registered by [.mcp.json](.mcp.json), project
   scope, relative path — no machine-specific paths).
3. **Restart Claude Code** so it loads the server.

That's it. You don't need to remember the tool names: the bundled **`delegate-to-go`** skill
([.claude/skills](.claude/skills/delegate-to-go/SKILL.md)) auto-orchestrates — **just describe the task
in plain language** ("get a consensus from a few Go models on X", "refactor these files"). Type
**`/delegate <task>`** to force delegation explicitly. The `opencode` binary is auto-resolved from
`OPENCODE_BIN`, then `~/.bun/bin/opencode`, then `PATH`.

## Tools (MCP, stdio)

| Tool | Purpose |
|------|---------|
| `opencode_go_run` | Run **one** worker. |
| `opencode_go_fanout` | Run **many** workers in parallel + optional `reduce` (consensus / map-reduce). |
| `opencode_go_models` | List available OpenCode Go models (live from the CLI). |

**Output convention:** the **last content block** of every tool is **pure JSON**
(`{ ok, errorKind?, sessionID, model, mode, cost, tokens, ... }`) so one call's
output pipes cleanly into the next. Human-readable text comes in earlier blocks.

### `opencode_go_run` params
`prompt` (req), `model` (default `glm-5.2`), `mode`, `agent`, `variant`, `cwd`,
`files[]`, `session`, `continueSession`, `fork`, `title`, `timeoutMs`.

### Worker modes (the safety knob)

| mode | agent | permissions | use for |
|------|-------|-------------|---------|
| **`ask`** (default) | `plan` | read-only (can read files, can't write/bash) | questions, analysis, planning, consensus — the safe default |
| **`edit`** | `build` | auto-approves edits/bash | autonomous file changes — **requires `cwd`** |

`mode` is the single place the agent × permission matrix lives. It designs out the
**no-TTY permission deadlock**: an edit-capable agent without auto-approved
permissions would block forever on an approval that can't arrive over stdio. So
outside `edit` mode the agent must be a known read-only one — an explicit
edit-capable agent (or an unset agent that would fall back to opencode's default,
often the edit-capable `build`) is rejected up front (`errorKind: permission_deadlock`)
instead of hanging until timeout.

### Curated model stack & role aliases

The stack is **frozen** at 6 models (one per role), chosen from 13 via capability
research + a live coding/cost benchmark (`STACK` in [mcp/lib.ts](mcp/lib.ts)).
Discarded models stay callable by full id — the provider lock is the only hard
boundary — they're just not the recommended set. Pass a **role alias** as `model`
instead of memorizing ids:

| alias | → model | role |
|-------|---------|------|
| `reason` / `smart` | `deepseek-v4-pro` | heavy reasoning / hardest agentic coding |
| `code` | `glm-5.2` | top coding quality, long-horizon |
| `code-fast` / `kimi` | `kimi-k2.7-code` | token-efficient coding throughput |
| `fast` / `cheap` / `reduce` | `deepseek-v4-flash` | cheap bulk + **default reducer** |
| `longctx` | `minimax-m3` | reasoning + long-context synthesis |
| `bulk` | `qwen3.7-plus` | abundant generalist / overflow |

Discarded: `glm-5.1`, `kimi-k2.6`, `qwen3.6-plus`, `qwen3.7-max`, `minimax-m2.7`,
`mimo-v2.5-pro`, `mimo-v2.5` (redundant or strictly dominated). The `fanout` `reduce`
step now defaults to **`deepseek-v4-flash`** (was glm-5.2) — ~50× faster and ~17× cheaper
as a synthesizer in benchmarks, with no loss of accuracy on the tested reductions.

### Evaluating new models (the benchmark)

When the gateway adds models, decide whether a newcomer should replace a stack
incumbent with the repeatable harness in [scripts/benchmark.ts](scripts/benchmark.ts).
It runs a standard suite (2 coding tasks graded against **hidden** test cases the
worker never saw, + reasoning + a reducer task) and scores quality / cost / latency.

```bash
bun run bench --detect                          # find live models not yet evaluated, bench vs incumbents
bun run bench --role code --candidate <model>   # candidate vs the role's incumbent -> REPLACE/KEEP verdict
bun run bench --models a,b,c                     # ad-hoc leaderboard (ids or aliases)
bun run bench --models a,b --quick              # reason+reduce only (skips edit-mode cost)
#   --tasks code,reason,reduce   --concurrency N   --keep (don't delete worker artifacts)
```

`--detect` diffs the live model list against `EVALUATED_MODELS` (stack ∪ discarded);
a model in neither is a newcomer. The verdict is **advisory** — to promote, swap the
role's id in `STACK` and move the displaced model into `DISCARDED_MODELS`, then re-run
`bun run test`. Every code answer is independently verified, so a model can't pass by
self-reporting success.

### Recipes

**Continue a worker (stateful):** grab `sessionID` from a run's JSON block, then
`{ prompt: "...follow-up...", session: "<id>", continueSession: true }`. Reuse the
same `model`+`mode` the session was created with (sessions are model/agent-bound).

**Autonomous edit:** `{ prompt, mode: "edit", cwd: "/abs/path/to/repo" }`. `cwd` is
mandatory so a worker can never silently mutate this bridge's own repo. Parallel
edit workers must each get a **distinct** `cwd`/worktree (shared cwd →
`errorKind: edit_collision`, rejected without spawning).

**Consensus / map-reduce (fanout `reduce`):**
```jsonc
{
  "tasks": [
    { "id": "glm",  "prompt": "<question>", "model": "glm-5.2" },
    { "id": "qwen", "prompt": "<question>", "model": "qwen3.7-max" },
    { "id": "kimi", "prompt": "<question>", "model": "kimi-k2.7-code" }
  ],
  "reduce": { "prompt": "Given these answers:\n{{answers}}\nReconcile into one best answer.", "model": "qwen3.7-max" }
}
```
The reducer is itself a read-only Go worker — **all raw answers are returned too**,
so the orchestrator can override its verdict. `{{answers}}` is replaced with the
labelled worker outputs.

## errorKind (machine-stable, English)
`timeout` · `nonzero_exit` · `model_error` · `no_output` · `provider_lock` ·
`permission_deadlock` · `cwd_required` · `bad_flags` · `edit_collision` · `spawn_error`

## Layout
```
mcp/lib.ts            core: spawn opencode, parse JSON events, resolveMode, STACK, the opencode-go lock
mcp/server.ts         MCP server wiring (low-level SDK, plain JSON Schema)
scripts/check-server.ts  MCP handshake smoke test
scripts/selftest.ts   guardrails (free) + live ask/edit/consensus proofs
scripts/benchmark.ts  model-evaluation harness (hidden-case grading, REPLACE/KEEP verdicts)
.mcp.json             Claude Code project-scoped registration
```

## Verify
```bash
bun run check                       # list tools + models (no model cost)
bun run test                        # guardrails only (free)
bun run scripts/selftest.ts --live  # + cheap ask/edit proofs (small cost)
bun run bench --detect              # any new models to evaluate? (free)
bun run models                      # print the opencode-go model list
```

## Notes
- **Auth:** OpenCode Go is an **API key** credential (`opencode auth list` → `api`,
  provider id `opencode-go`) — not OAuth. The only OAuth credential present is
  OpenAI. Re-auth Go with `opencode auth login`.
- **Cost/timeout:** every result carries `tokens` + `cost`; `fanout` adds
  `totalCost`/`totalTokens`. Workers are killed after `timeoutMs` (default 300s);
  `sessionID` is still returned on timeout so a run can be resumed.
- **Lock scope:** the boundary is the *provider*. `agent`/`mode` never change it;
  `reduce.model` and every fanout task model funnel through `normalizeModel()`.

## License

MIT — see [LICENSE](LICENSE).
