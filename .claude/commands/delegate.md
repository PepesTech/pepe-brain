---
description: Force-delegate a task to opencode-go workers (applies the delegate-to-go rubric with delegation ON)
argument-hint: "[consensus|fanout|edit:] <task> — e.g. /delegate consensus: which caching strategy for X?"
---

Apply the **delegate-to-go** skill's decision rubric to the task below, but with **delegation forced ON**
— skip Gate A's "do it myself" default and delegate even if you'd normally handle it inline. Still honor
every other gate (mode, shape, count/concurrency, role→model, the conservative cost posture, and the
>~8-worker confirm gate).

If `$ARGUMENTS` starts with a shape keyword, pin that shape:
- `consensus:` or `fanout:` → fan out across diverse models (add `reduce` for consensus).
- `edit:` → autonomous `edit` workers in per-file git worktrees.
Otherwise infer the best shape from the task.

Always finish by reporting `N workers, $X total` from the tools' JSON output.

Task: $ARGUMENTS
