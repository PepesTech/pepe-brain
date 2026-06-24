#!/usr/bin/env bun
// Repeatable model-evaluation harness for the OpenCode Go stack.
//
// When a new model appears in the gateway, benchmark it against the FROZEN STACK
// incumbents to decide whether it should replace one. Every code answer is graded
// against HIDDEN test cases the worker never saw (catches overfitting/self-report).
//
//   bun run scripts/benchmark.ts --detect                 # find new live models, bench vs incumbents
//   bun run scripts/benchmark.ts --role code --candidate <model>   # candidate vs the 'code' incumbent
//   bun run scripts/benchmark.ts --models a,b,c           # ad-hoc leaderboard (ids or aliases)
//   bun run scripts/benchmark.ts --models a,b --quick     # reason+reduce only (no edit-mode cost)
//   flags: --tasks code,reason,reduce  --concurrency N
//
// Output: a per-model leaderboard (quality / cost / latency) and, for --role/--detect,
// a REPLACE / KEEP verdict vs the incumbent with the margin.

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOpencodeGo,
  normalizeModel,
  resolveAlias,
  listGoModels,
  detectNewModels,
  incumbentsForRole,
  STACK,
  type RunOptions,
  type RunResult,
} from "../mcp/lib.ts";

// ─────────────────────────────── suite ───────────────────────────────
// Code tasks: worker writes <file> exporting <fn>; we grade <fn> on hidden cases.
// reason/reduce tasks: ask-mode; graded objectively on the returned text.

interface CodeTask {
  id: string;
  type: "code";
  file: string;
  fn: string;
  prompt: (file: string, fn: string) => string;
  hidden: { args: unknown[]; expect: unknown }[];
}
interface TextTask {
  id: string;
  type: "reason" | "reduce";
  prompt: string;
  grade: (text: string) => boolean;
}
type Task = CodeTask | TextTask;

const firstInt = (s: string) => {
  const m = s.replace(/,/g, "").match(/-?\d+/);
  return m ? parseInt(m[0], 10) : NaN;
};

const SUITE: Task[] = [
  {
    id: "parse-duration",
    type: "code",
    file: "duration.js",
    fn: "parseDuration",
    prompt: (file, fn) =>
      `Create a single Node.js file \`${file}\` (no deps) defining and exporting function ${fn}(str) that parses ` +
      `compound duration strings into TOTAL SECONDS. Units: s,m,h,d. Compound like '1h30m','2d4h','1h30m15s'. ` +
      `Trim whitespace. A BARE number with no unit = seconds ('120'->120). Invalid (empty, unknown unit, leftover ` +
      `garbage like 'abc','10x') -> return null. Add console.assert checks for ${fn}('1h30m')===5400, ${fn}('45s')===45, ` +
      `${fn}('2d')===172800 then console.log('OK'); run \`node ${file}\` and fix until it prints OK with no assert ` +
      `failures. Only create ${file}.`,
    hidden: [
      { args: ["2d4h"], expect: 187200 },
      { args: ["1d1h1m1s"], expect: 90061 },
      { args: ["  1h  "], expect: 3600 },
      { args: ["0"], expect: 0 },
      { args: ["100s"], expect: 100 },
      { args: ["h"], expect: null },
      { args: ["1h2y"], expect: null },
      { args: ["12"], expect: 12 },
    ],
  },
  {
    id: "roman-to-int",
    type: "code",
    file: "roman.js",
    fn: "romanToInt",
    prompt: (file, fn) =>
      `Create a single Node.js file \`${file}\` (no deps) defining and exporting function ${fn}(s) that converts a ` +
      `Roman numeral string (I,V,X,L,C,D,M with subtractive forms IV,IX,XL,XC,CD,CM) to an integer. Return null for ` +
      `an empty string or any string containing non-Roman characters. Add console.assert for ${fn}('IV')===4, ` +
      `${fn}('MCMXCIV')===1994, ${fn}('')===null then console.log('OK'); run \`node ${file}\` and fix until OK. Only create ${file}.`,
    hidden: [
      { args: ["III"], expect: 3 },
      { args: ["IX"], expect: 9 },
      { args: ["LVIII"], expect: 58 },
      { args: ["MCMXCIV"], expect: 1994 },
      { args: ["XLII"], expect: 42 },
      { args: ["DCCCXC"], expect: 890 },
      { args: [""], expect: null },
      { args: ["ABC"], expect: null },
    ],
  },
  {
    id: "pow",
    type: "reason",
    prompt: "¿Cuánto es 2^17? Responde SOLO el número, sin texto ni comas.",
    grade: (t) => firstInt(t) === 131072,
  },
  {
    id: "typeof-null",
    type: "reason",
    prompt: "En JavaScript, ¿qué devuelve exactamente `typeof null`? Responde SOLO ese valor.",
    grade: (t) => /\bobject\b/i.test(t) && !/\bnull\b/i.test(t.replace(/typeof\s+null/gi, "")),
  },
  {
    id: "reduce-majority",
    type: "reduce",
    prompt:
      "Tres asistentes resolvieron 7×8. A respondió 54, B respondió 56, C respondió 56. " +
      "Da SOLO el valor correcto (corrige errores y usa mayoría). Sin explicación.",
    grade: (t) => firstInt(t) === 56,
  },
];

// ───────────────────────────── grading ─────────────────────────────

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Load a named function from a worker-written file, robust to export style. */
function loadFn(file: string, fnName: string): Function | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  // Drop the worker's own console.* lines so they don't run/throw during load.
  const clean = src
    .split("\n")
    .filter((l) => !/^\s*console\.(assert|log|error|warn|info)/.test(l))
    .join("\n");
  const wrapped =
    `const module={exports:{}};const exports=module.exports;\n${clean}\n` +
    `;return (typeof ${fnName}!=='undefined')?${fnName}:(module.exports.${fnName}||module.exports);`;
  try {
    const fn = new Function(wrapped)();
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

function gradeCode(task: CodeTask, cwd: string): { score: number; detail: string } {
  const fn = loadFn(join(cwd, task.file), task.fn);
  if (!fn) return { score: 0, detail: `no ${task.fn} loadable` };
  let pass = 0;
  const fails: string[] = [];
  for (const c of task.hidden) {
    let got: unknown;
    try {
      got = fn(...c.args);
    } catch (e: any) {
      got = `THREW:${e?.message}`;
    }
    if (eq(got, c.expect)) pass++;
    else fails.push(`${JSON.stringify(c.args)}=>${JSON.stringify(got)}≠${JSON.stringify(c.expect)}`);
  }
  return { score: pass / task.hidden.length, detail: fails.length ? fails.slice(0, 3).join(" ") : "all pass" };
}

// ───────────────────────────── runner ─────────────────────────────

interface Scored {
  model: string; // normalized opencode-go/<id>
  bare: string;
  perTask: Record<string, { score: number; cost: number; ms: number; ok: boolean; detail?: string }>;
  code: number | null;
  reason: number | null;
  reduce: number | null;
  overall: number;
  totalCost: number;
  avgMs: number;
}

async function benchModel(bare: string, tasks: Task[], base: string): Promise<Scored> {
  const model = normalizeModel(bare);
  const perTask: Scored["perTask"] = {};
  for (const t of tasks) {
    let r: RunResult;
    let score: number;
    let detail: string | undefined;
    if (t.type === "code") {
      const cwd = join(base, bare.replace(/[^a-z0-9]+/gi, "_"), t.id);
      mkdirSync(cwd, { recursive: true });
      const opts: RunOptions = { prompt: t.prompt(t.file, t.fn), model: bare, mode: "edit", cwd, timeoutMs: 220_000 };
      r = await runOpencodeGo(opts);
      const g = gradeCode(t, cwd);
      score = g.score;
      detail = g.detail;
    } else {
      r = await runOpencodeGo({ prompt: t.prompt, model: bare, mode: "ask", timeoutMs: 120_000 });
      score = r.ok && t.grade(r.text) ? 1 : 0;
      detail = r.ok ? (score ? "ok" : `bad: ${r.text.slice(0, 40).replace(/\n/g, " ")}`) : r.errorKind;
    }
    perTask[t.id] = { score, cost: r.cost ?? 0, ms: r.durationMs, ok: r.ok, detail };
  }
  const avg = (type: string) => {
    const xs = tasks.filter((t) => t.type === type).map((t) => perTask[t.id].score);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const all = Object.values(perTask);
  return {
    model,
    bare,
    perTask,
    code: avg("code"),
    reason: avg("reason"),
    reduce: avg("reduce"),
    overall: all.reduce((a, b) => a + b.score, 0) / (all.length || 1),
    totalCost: all.reduce((a, b) => a + b.cost, 0),
    avgMs: all.reduce((a, b) => a + b.ms, 0) / (all.length || 1),
  };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (true) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// ───────────────────────────── verdict ─────────────────────────────
// Per-role primary metric + tiebreak. REPLACE only if the candidate does not lose
// on the primary metric AND wins the role's secondary axis (cost for cheap roles).

const ROLE_METRIC: Record<string, "code" | "reason" | "reduce"> = {
  reason: "reason",
  code: "code",
  reduce: "reduce",
  longctx: "reason",
  bulk: "reason",
};
const CHEAP_ROLES = new Set(["reduce", "bulk"]);

function verdict(cand: Scored, inc: Scored, role: string) {
  const metric = ROLE_METRIC[role] ?? "overall";
  const cm = (cand as any)[metric] ?? cand.overall;
  const im = (inc as any)[metric] ?? inc.overall;
  const qualityOK = cm >= im - 1e-9;
  const cheaper = cand.totalCost < inc.totalCost;
  const faster = cand.avgMs < inc.avgMs;
  let replace = false;
  let why = "";
  if (cm > im + 1e-9) {
    replace = true;
    why = `higher ${metric} (${cm.toFixed(2)} vs ${im.toFixed(2)})`;
  } else if (qualityOK && CHEAP_ROLES.has(role) && cheaper) {
    replace = true;
    why = `ties on ${metric} but cheaper ($${cand.totalCost.toFixed(4)} vs $${inc.totalCost.toFixed(4)})`;
  } else if (qualityOK && cheaper && faster) {
    replace = true;
    why = `ties on ${metric}, cheaper AND faster`;
  } else {
    why = qualityOK
      ? `ties quality but not cheaper+faster enough to justify churn`
      : `loses on ${metric} (${cm.toFixed(2)} < ${im.toFixed(2)})`;
  }
  return { replace, why, metric };
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    detect: a.includes("--detect"),
    quick: a.includes("--quick"),
    models: get("--models")?.split(",").map((s) => s.trim()).filter(Boolean),
    role: get("--role"),
    candidate: get("--candidate"),
    tasks: get("--tasks")?.split(",").map((s) => s.trim()),
    concurrency: parseInt(get("--concurrency") ?? "4", 10),
  };
}

function pct(x: number | null) {
  return x === null ? "  – " : `${Math.round(x * 100)}%`.padStart(4);
}

async function main() {
  const args = parseArgs();
  let tasks = SUITE;
  if (args.quick) tasks = tasks.filter((t) => t.type !== "code");
  if (args.tasks) tasks = tasks.filter((t) => args.tasks!.includes(t.type) || args.tasks!.includes((t as any).id));
  if (!tasks.length) {
    console.error("No tasks selected.");
    process.exit(1);
  }

  // Decide model set + (optional) comparison context.
  let models: string[] = [];
  let compare: { candidate: string; incumbent: string; role: string }[] = [];

  if (args.detect) {
    const live = await listGoModels();
    const newcomers = detectNewModels(live);
    if (!newcomers.length) {
      console.log(`✅ No new OpenCode Go models. Live count: ${live.length}. Stack frozen at ${STACK.length}.`);
      console.log(`   (Discarded/known are all accounted for. Nothing to benchmark.)`);
      process.exit(0);
    }
    console.log(`🔎 Newcomers detected: ${newcomers.join(", ")}`);
    console.log(`   Benchmarking newcomers + all ${STACK.length} incumbents on ${tasks.length} tasks...\n`);
    models = [...new Set([...newcomers, ...STACK.map((s) => s.id)])];
    // Each newcomer is compared to EVERY role's incumbent to find a best-fit replacement.
    for (const nm of newcomers) for (const s of STACK) compare.push({ candidate: nm, incumbent: s.id, role: s.role });
  } else if (args.role) {
    const incs = incumbentsForRole(args.role);
    if (!incs.length) {
      console.error(`Unknown role '${args.role}'. Roles: ${[...new Set(STACK.map((s) => s.role))].join(", ")}`);
      process.exit(1);
    }
    const cand = args.candidate ? resolveAlias(args.candidate)! : null;
    if (!cand) {
      console.error("--role needs --candidate <model>.");
      process.exit(1);
    }
    models = [...new Set([cand, ...incs])];
    for (const inc of incs) compare.push({ candidate: cand, incumbent: inc, role: args.role });
  } else if (args.models) {
    models = args.models.map((m) => resolveAlias(m)!);
  } else {
    console.error("Specify --detect, --role <r> --candidate <m>, or --models a,b,c. Add --quick to skip code tasks.");
    process.exit(1);
  }

  const base = mkdtempSync(join(tmpdir(), "ocgo-suite-"));
  console.log(`models: ${models.join(", ")}`);
  console.log(`tasks:  ${tasks.map((t) => `${t.id}[${t.type}]`).join(", ")}`);
  console.log(`(edit-mode code tasks run in ${base})\n`);

  const scored = await pool(models, args.concurrency, (m) => benchModel(m, tasks, base));
  const byBare = new Map(scored.map((s) => [s.bare, s]));

  // Leaderboard
  console.log("── LEADERBOARD ".padEnd(72, "─"));
  console.log("model".padEnd(26) + "code reason reduce  overall   cost     avg-latency");
  for (const s of [...scored].sort((a, b) => b.overall - a.overall || a.totalCost - b.totalCost)) {
    console.log(
      s.bare.padEnd(26) +
        `${pct(s.code)}  ${pct(s.reason)}  ${pct(s.reduce)}   ${pct(s.overall)}   ` +
        `$${s.totalCost.toFixed(4)}  ${(s.avgMs / 1000).toFixed(1)}s`,
    );
  }
  // surface failing hidden-case details
  for (const s of scored)
    for (const [tid, r] of Object.entries(s.perTask))
      if (r.score < 1) console.log(`   · ${s.bare} ${tid}: ${r.detail}`);

  // Verdicts
  if (compare.length) {
    console.log("\n── VERDICTS ".padEnd(72, "─"));
    const seen = new Set<string>();
    for (const c of compare) {
      const cand = byBare.get(resolveAlias(c.candidate)!);
      const inc = byBare.get(c.incumbent);
      if (!cand || !inc) continue;
      const key = `${cand.bare}->${c.role}`;
      const v = verdict(cand, inc, c.role);
      const line = `${v.replace ? "🔁 REPLACE" : "✋ KEEP   "}  role:${c.role.padEnd(7)} ${cand.bare} vs ${inc.bare}  — ${v.why}`;
      if (!seen.has(line)) {
        console.log(line);
        seen.add(line);
      }
    }
    console.log(
      `\nNote: REPLACE is advisory. To promote, edit STACK in mcp/lib.ts (swap the role's id) and move the ` +
        `displaced model into DISCARDED_MODELS.`,
    );
  }

  if (!process.argv.includes("--keep")) {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  } else {
    console.log(`\n(kept worker artifacts in ${base})`);
  }
  process.exit(0);
}

main();
