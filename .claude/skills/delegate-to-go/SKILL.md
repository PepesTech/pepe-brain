---
name: delegate-to-go
description: >-
  Delegates work to parallel opencode-go worker models (DeepSeek, GLM, Kimi, Qwen, MiniMax) via the
  opencode-go MCP tools, and decides AUTOMATICALLY how many workers to deploy, which model/role each
  gets, and which mode — so the user never has to spell out the orchestration. Use when a request is
  parallelizable or bulk (review/scan/summarize many files, run the same analysis across a list, large
  refactors spanning multiple files), when the user wants a second opinion / consensus / best-of-N across
  diverse models, when they say things like "use the Go models", "fan this out", "delegate this", "have
  the workers…", "get a few models to…", "in parallel", or when a job is cheap-but-voluminous and not
  worth Opus's own tokens. Also use for multi-file autonomous edits that split one-worker-per-file. Do
  NOT use for a single quick edit, a one-file read, a short question, or anything you can finish in one or
  two steps faster than spawning a worker would take.
---

# Delegate to opencode-go workers

You (Opus) are the orchestrator. This skill is the policy for handing work to `opencode-go` worker
models. Apply the rubric below to the user's instruction, build the plan, call the MCP tools, then
report results + cost. Keep model/mode facts in sync with `mcp/lib.ts` (`STACK`, `MODEL_ALIASES`,
`resolveMode`) — that file is the source of truth.

## When this fires (and when it shouldn't)

Default posture: **do it yourself.** Delegation must earn its latency and cost. Only delegate when the
work is genuinely parallelizable/bulk, the user explicitly asks, you want diverse reasoning, or a
multi-file edit splits cleanly. When borderline, do it yourself — a wrong delegation wastes a run; a
skipped one costs nothing.

## Tools (cheat sheet — full schema in repo README)

- `mcp__opencode-go__opencode_go_run({ prompt, model?, mode?, variant?, cwd?, files?, session?, continueSession?, fork?, title?, timeoutMs? })` — ONE worker.
- `mcp__opencode-go__opencode_go_fanout({ tasks:[{ id?, prompt, model?, mode?, cwd?, variant?, … }], concurrency?, reduce?:{ prompt, model?, variant? } })` — N parallel workers + optional reduce.
- `mcp__opencode-go__opencode_go_models()` — live model list.

The **last content block of every tool is pure JSON** (`{ ok, cost, tokens, sessionID, … }` / fanout
`{ okCount, total, totalCost, results }`). Read it — don't guess cost. All workers are hard-locked to
`opencode-go`. Pass `model` as a **role alias** (below), never a memorized id.

## Decision rubric

### A — Delegate, or do it myself?
Delegate only if ≥1 holds: **N≥3 independent units** doing the same op (files/docs/questions); the user
**explicitly asks**; **high-volume / low-judgment** work (mass summarize/classify/boilerplate); you want
**diverse reasoning** (contested call, "is this right?"); a multi-file **autonomous edit** that splits
one-worker-per-file. Otherwise (single file, ≤2 steps, needs this conversation's context, tightly
interactive) — **do it yourself.**

### B — Mode: `ask` (default) vs `edit`
- **`ask`** (agent `plan`, read-only): questions, analysis, review, planning, consensus, summarization.
  Cannot write/bash. **Use unless the deliverable is literally modified files.**
- **`edit`** (agent `build`, autonomous edits + bash): only when changing files. Server invariants —
  bake them in:
  - Every edit worker needs an explicit `cwd` (else `cwd_required`).
  - Parallel edit workers need a **distinct `cwd` each** (shared → `edit_collision`).
  - Never set `agent` outside edit mode (an edit-capable agent w/o a TTY hangs → `permission_deadlock`).
  - **Autonomy = ON:** for parallel edits, auto-create an isolated **git worktree per worker** and run
    without asking; review/integrate diffs after, then remove the worktrees. (Recipe below.) If the
    target isn't a git repo or worktrees fail, fall back to **sequential** edits in one `cwd` and say so.

### C — Shape
| Shape | Use when | Tool |
|---|---|---|
| Single run | one self-contained unit | `opencode_go_run` |
| Fanout | N independent units, want each result separately (per-file edit, per-doc summary) | `opencode_go_fanout` |
| Fanout + reduce | N views of the SAME question collapsed into one (consensus, best-of-N, map-reduce) | `…_fanout` + `reduce` |
| Pipeline | step K depends on K-1 (draft→critique→revise) | chained `run` via `session`+`continueSession` (same model+mode) |

Reduce: reducer is a read-only Go worker; **all raw answers are returned** so you can override its
verdict. Put `{{answers}}` in `reduce.prompt`. Default reducer = `fast` (deepseek-v4-flash); escalate to
`longctx` for very long answers or `reason` for genuinely hard reconciliation.

### D — How many workers / concurrency
Map the instruction to a **work-list first**, then count: **1** (one indivisible unit / one strong model
suffices); **2–3 diverse** (consensus/second-opinion); **N = natural units** ("review these 8 files" →
8). Default `concurrency` 4 (raise to 6–8 only for cheap `ask` work in a hurry). **Confirm before
spawning >~8 workers** — past that, chunk the list (one worker per chunk).

### E — Role → model (pass the alias as `model`)
| Subtask | alias | model |
|---|---|---|
| Hardest reasoning / hardest coding | `reason` (`smart`) | deepseek-v4-pro |
| Top-quality coding, long-horizon | `code` | glm-5.2 |
| High-throughput / token-efficient coding | `code-fast` (`kimi`) | kimi-k2.7-code |
| Cheap bulk + default reducer | `fast` (`cheap`/`reduce`) | deepseek-v4-flash |
| Long-context reasoning / synthesis | `longctx` | minimax-m3 |
| Abundant generalist / overflow | `bulk` | qwen3.7-plus |

Pick logic: coding-quality→`code`; many-files/speed→`code-fast`; hard analysis→`reason`; routine/bulk→
`fast`/`bulk`; synthesis→`reduce`; long-context→`longctx`. For **consensus pick different families on
purpose** (e.g. `reason`+`code`+`bulk`), not three of the same. Raise `variant` to `high`/`max` only for
a genuinely hard `reason` task; leave default for bulk to save cost.

### F — Cost & safety (CONSERVATIVE default)
- Smallest worker count that does the job; `ask` mode; `fast`/`bulk` for volume; default concurrency.
  Scale up only on explicit signal.
- **Confirm before spawning when:** >~8 workers; OR non-trivial spend (pricey models × many calls) when
  the user didn't ask to delegate. (Edit fan-outs do NOT need confirmation — autonomy is on — but the
  >~8 scale gate still applies.)
- **Always report cost:** read `totalCost`/`cost` from the JSON block and echo one line: "N workers, $X".
- Timeouts default 300s/worker; `sessionID` survives a timeout → resume rather than restart.

## Edit-fanout recipe (git worktrees)
1. Pick a base (the repo root). For each unit i, `git -C <repo> worktree add <tmp>/wt-i HEAD` (or a fresh
   branch `delegate/<task>-i`).
2. Run one `edit` worker per worktree: `opencode_go_fanout` tasks with `mode:"edit"`, `cwd:"<tmp>/wt-i"`,
   model `code` (or `code-fast` for many/speed), distinct cwd each.
3. After they finish: review each worktree's `git diff`, independently sanity-check (don't trust
   self-reports), and integrate the changes into the main tree.
4. **Clean up:** `git -C <repo> worktree remove <tmp>/wt-i` for each (and delete temp branches) so
   worktrees don't accumulate. Report what changed + total cost.

## Worked examples (instruction → plan)
- **"Review these files / this PR for bugs"** → `ask` fanout split by dimension (security/perf/
  correctness) or by file, models `reason`+`code`+`bulk`, then `reduce` (`fast`) → one prioritized list. No confirm.
- **"What's the best approach to X?" / "is this design right?"** → consensus: fanout 3 diverse models
  (`reason`,`code`,`longctx`) + `reduce`; return the reconciled answer AND note dissent from raw answers.
- **"Refactor module X across these 5 files"** → `edit` workers, one per file in its own worktree, model
  `code`; run autonomously, review diffs, integrate, remove worktrees. Report cost.
- **"Summarize each of these 20 docs"** → `fast` fanout, one task per doc, concurrency 4–6; confirm first
  (N>8); optional `reduce` for an exec summary; report total cost.
- **"Add a docstring to this function"** → **do it yourself.** Single trivial unit.
- **"Draft → critique → revise this spec"** → sequential pipeline (`run` draft `reason` → `run` critique
  `continueSession` → `run` revise). Not a fanout.

## Failure modes & recovery
| errorKind | meaning | do |
|---|---|---|
| `cwd_required` | edit worker without `cwd` | supply a distinct cwd/worktree |
| `edit_collision` | parallel edit workers share a cwd | give each its own worktree, or run sequentially |
| `permission_deadlock` | edit-capable agent outside edit mode | drop the `agent` override; use `mode:"edit"` |
| `timeout` | worker exceeded `timeoutMs` | resume with `session`+`continueSession` (sessionID is returned) |
| `provider_lock` | model wasn't opencode-go | use a role alias / `opencode-go/<id>` |

## Reference
Source of truth: `mcp/lib.ts` (STACK, MODEL_ALIASES, resolveMode), `mcp/server.ts` (tool schemas),
repo `README.md`. The `/delegate` command applies this same rubric with delegation forced on.
