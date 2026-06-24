// Core logic for the opencode-go bridge.
// Every worker run is forced to the `opencode-go` provider. Nothing here can
// reach OpenCode Zen, OpenAI, or any other provider — that is the hard guarantee.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const PROVIDER = "opencode-go";
export const DEFAULT_MODEL = "glm-5.2";
// Reducer default: fast + cheap + accurate-enough synthesizer. Won both the live
// coding benchmark (8/8 hidden cases at ~1/20th the cost of the others) and the
// capability research's reducer ranking. Replaces the old slow glm-5.2 reducer.
export const DEFAULT_REDUCER_MODEL = "deepseek-v4-flash";

// ── Frozen worker stack ─────────────────────────────────────────────────────
// The active roster: 6 models, one per role, chosen via capability research + a
// live coding/cost benchmark (scripts/benchmark.ts). FROZEN — change it only by
// benchmarking a candidate and promoting it into a role below.
export const STACK = [
  { id: "deepseek-v4-pro", role: "reason", note: "heavy reasoning / hardest agentic coding" },
  { id: "glm-5.2", role: "code", note: "top coding quality, long-horizon" },
  { id: "kimi-k2.7-code", role: "code", note: "token-efficient coding throughput" },
  { id: "deepseek-v4-flash", role: "reduce", note: "primary reducer + cheap bulk" },
  { id: "minimax-m3", role: "longctx", note: "reasoning + long-context synthesis" },
  { id: "qwen3.7-plus", role: "bulk", note: "abundant generalist / overflow" },
] as const;

export type StackRole = (typeof STACK)[number]["role"];

// Evaluated-and-discarded models (redundant or strictly dominated). Kept for
// newcomer diffing and transparency — NOT blocked; the provider prefix lock is the
// only HARD boundary, so any opencode-go model stays callable by full id.
export const DISCARDED_MODELS = [
  "glm-5.1", "kimi-k2.6", "qwen3.6-plus", "qwen3.7-max",
  "minimax-m2.7", "mimo-v2.5-pro", "mimo-v2.5",
];

// The frozen stack ids. Offline fallback / enum hint only — `listGoModels()` is the
// live source of truth and is NOT used to reject models.
export const KNOWN_GO_MODELS = STACK.map((s) => s.id);

// Everything already evaluated (stack ∪ discarded). A LIVE model not in here is a
// newcomer worth benchmarking against the incumbents.
export const EVALUATED_MODELS = [...KNOWN_GO_MODELS, ...DISCARDED_MODELS];

/** Live (bare) model ids we have never evaluated — candidates for benchmarking. */
export function detectNewModels(liveBareIds: string[]): string[] {
  const seen = new Set<string>(EVALUATED_MODELS);
  return liveBareIds.filter((m) => !seen.has(m));
}

/** Incumbent stack model id(s) occupying a role. */
export function incumbentsForRole(role: string): string[] {
  return STACK.filter((s) => s.role === role).map((s) => s.id);
}

// Semantic role aliases -> model id, resolved BEFORE the provider lock so an
// orchestrator can say model:"code" / "reason" / "fast" instead of memorizing ids.
export const MODEL_ALIASES: Record<string, string> = {
  reason: "deepseek-v4-pro",
  smart: "deepseek-v4-pro",
  code: "glm-5.2",
  "code-fast": "kimi-k2.7-code",
  kimi: "kimi-k2.7-code",
  fast: "deepseek-v4-flash",
  cheap: "deepseek-v4-flash",
  reduce: "deepseek-v4-flash",
  longctx: "minimax-m3",
  bulk: "qwen3.7-plus",
};

/** Map a role alias (case-insensitive bare name) to its model id; pass through otherwise. */
export function resolveAlias(model?: string): string | undefined {
  if (!model) return model;
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

// Agents that can mutate the filesystem / run bash. Without auto-approved
// permissions these block on an approval prompt that can never arrive over
// stdio (no TTY), then die at timeout — the "permission deadlock" foot-gun.
export const EDIT_CAPABLE_AGENTS = new Set(["build"]);

export type Mode = "ask" | "edit";

export type ErrorKind =
  | "timeout"
  | "nonzero_exit"
  | "model_error"
  | "no_output"
  | "provider_lock"
  | "permission_deadlock"
  | "cwd_required"
  | "bad_flags"
  | "edit_collision"
  | "spawn_error";

export interface RunOptions {
  prompt: string;
  model?: string; // bare ("glm-5.2") or fully-qualified ("opencode-go/glm-5.2")
  mode?: Mode; // safe agent+permission bundle. Default "ask" (read-only).
  agent?: string; // escape hatch: override the agent chosen by mode
  variant?: string; // reasoning effort: minimal | low | medium | high | max
  cwd?: string; // working dir -> --dir. REQUIRED when mode === "edit".
  files?: string[]; // attach paths -> repeated --file <f>
  session?: string; // resume an opencode session -> --session <id>
  continueSession?: boolean; // -> --continue (requires session)
  fork?: boolean; // -> --fork (requires session || continueSession)
  title?: string; // -> --title
  timeoutMs?: number;
  id?: string; // caller label (used by fanout for addressable results)
}

export interface RunResult {
  ok: boolean;
  errorKind?: ErrorKind;
  model: string;
  mode: Mode;
  agent?: string; // effective agent
  skipPermissions: boolean;
  cwd?: string; // resolved working dir (blast radius for edit mode)
  text: string;
  reasoning?: string;
  sessionID?: string; // present even on timeout, so the run can be resumed
  tokens?: { input: number; output: number; reasoning: number; total: number };
  cost?: number;
  tools: string[];
  durationMs: number;
  error?: string; // free-form display text (may be localized)
  exitCode?: number | null;
  id?: string;
}

/** Resolve the opencode binary, preferring an explicit env override. */
export function resolveOpencodeBin(): string {
  const fromEnv = process.env.OPENCODE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const bunBin = join(homedir(), ".bun", "bin", "opencode");
  if (existsSync(bunBin)) return bunBin;
  return "opencode"; // fall back to PATH
}

/**
 * Normalize and HARD-LOCK a model id to the opencode-go provider.
 * - bare name        -> opencode-go/<name>
 * - opencode-go/<n>  -> unchanged
 * - any other prefix -> throws (cannot escape the Go provider)
 */
export function normalizeModel(model?: string): string {
  const raw = (resolveAlias(model) ?? DEFAULT_MODEL).trim();
  if (!raw) return `${PROVIDER}/${DEFAULT_MODEL}`;

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const name = rest.join("/");
    if (provider !== PROVIDER) {
      throw new Error(
        `Modelo "${raw}" rechazado: este puente solo permite el proveedor "${PROVIDER}". ` +
          `Usa "opencode-go/<modelo>" o un nombre suelto. Modelos: ${KNOWN_GO_MODELS.join(", ")}`,
      );
    }
    return `${PROVIDER}/${name}`;
  }
  return `${PROVIDER}/${raw}`;
}

export interface ModeResolution {
  agent?: string;
  skipPermissions: boolean;
  errorKind?: ErrorKind;
  error?: string;
}

/**
 * Map a high-level `mode` (+ optional explicit agent) to a safe
 * (agent, skipPermissions) pair. This is the single place the agent × permission
 * matrix lives, so the read-only default can never accidentally mutate and the
 * no-TTY permission deadlock is designed out.
 *
 *   ask  (DEFAULT) -> agent "plan",  skip=false   (read-only planning/answering)
 *   edit           -> agent "build", skip=true    (autonomous edit + bash)
 */
export function resolveMode(mode: Mode = "ask", agentOverride?: string): ModeResolution {
  let agent: string | undefined;
  let skipPermissions: boolean;

  switch (mode) {
    case "ask":
      agent = "plan";
      skipPermissions = false;
      break;
    case "edit":
      agent = "build";
      skipPermissions = true;
      break;
    default:
      return { skipPermissions: false, errorKind: "bad_flags", error: `Modo desconocido: ${mode}` };
  }

  // Explicit agent overrides the agent choice; mode still governs skip.
  if (agentOverride) agent = agentOverride;

  // Invariant: only edit mode may auto-approve permissions.
  if (mode !== "edit") skipPermissions = false;

  // Invariant: outside edit mode the worker must never be able to trigger a
  // permission prompt — there is no TTY to answer it, so it would hang until the
  // timeout. Reject BOTH an explicit edit-capable agent AND an unset agent (which
  // would fall back to opencode's default agent — often the edit-capable `build`).
  // Only a known read-only agent (e.g. "plan") is allowed outside edit mode.
  if (mode !== "edit" && (!agent || EDIT_CAPABLE_AGENTS.has(agent))) {
    return {
      agent,
      skipPermissions: false,
      errorKind: "permission_deadlock",
      error:
        `Fuera de mode:"edit" el agente debe ser de solo-lectura conocido (p.ej. "plan"); ` +
        `"${agent ?? "(default de opencode)"}" puede editar/ejecutar y se colgaría sin TTY. Usa mode:"edit".`,
    };
  }

  return { agent, skipPermissions };
}

/** Validate flag combinations the opencode CLI enforces, before spawning. */
export function validateFlags(o: RunOptions): { errorKind?: ErrorKind; error?: string } {
  if (o.continueSession && !o.session) {
    return {
      errorKind: "bad_flags",
      error: "continueSession requiere un `session` explícito (continuar 'la última' es una carrera bajo concurrencia).",
    };
  }
  if (o.fork && !(o.session || o.continueSession)) {
    return { errorKind: "bad_flags", error: "fork requiere `session` o `continueSession`." };
  }
  return {};
}

interface Spawned {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

function spawnOpencode(args: string[], cwd: string | undefined, timeoutMs: number): Promise<Spawned> {
  return new Promise((resolve) => {
    const child = spawn(resolveOpencodeBin(), args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // no TTY -> permission prompts can't hang us
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

/** Parse the newline-delimited JSON event stream from `opencode run --format json`. */
function parseEvents(stdout: string) {
  const textParts = new Map<string, string>();
  const textOrder: string[] = [];
  const reasoningParts = new Map<string, string>();
  const reasoningOrder: string[] = [];
  const tools = new Set<string>();
  let sessionID: string | undefined;
  let cost = 0;
  const tok = { input: 0, output: 0, reasoning: 0, total: 0 };
  let sawStepFinish = false;
  const errors: string[] = [];

  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let ev: any;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const part = ev.part ?? {};
    if (ev.sessionID) sessionID = ev.sessionID;

    const ptype = part.type ?? ev.type;
    if (ptype === "text" && typeof part.text === "string") {
      if (!textParts.has(part.id)) textOrder.push(part.id);
      textParts.set(part.id, part.text);
    } else if (ptype === "reasoning" && typeof part.text === "string") {
      if (!reasoningParts.has(part.id)) reasoningOrder.push(part.id);
      reasoningParts.set(part.id, part.text);
    } else if (ptype === "tool") {
      const name = part.tool ?? part.name ?? part.state?.name;
      if (name) tools.add(String(name));
    }

    if (ev.type === "step_finish" || part.type === "step-finish") {
      sawStepFinish = true;
      // cost/tokens may live on the nested part (step-finish) OR the top-level
      // event (step_finish) depending on which shape opencode emits — harvest both.
      const cst = typeof part.cost === "number" ? part.cost : ev.cost;
      if (typeof cst === "number") cost += cst;
      const t = part.tokens ?? ev.tokens;
      if (t) {
        tok.input += t.input ?? 0;
        tok.output += t.output ?? 0;
        tok.reasoning += t.reasoning ?? 0;
        tok.total += t.total ?? 0;
      }
    }
    if (ev.type === "error" || ptype === "error") {
      errors.push(part.message ?? ev.message ?? JSON.stringify(ev).slice(0, 300));
    }
  }

  const text = textOrder.map((id) => textParts.get(id) ?? "").join("");
  const reasoning = reasoningOrder.map((id) => reasoningParts.get(id) ?? "").join("");
  return { text, reasoning, tools: [...tools], sessionID, cost, tokens: tok, sawStepFinish, errors };
}

function failResult(o: RunOptions, mode: Mode, agent: string | undefined, skip: boolean, kind: ErrorKind, error: string): RunResult {
  return {
    ok: false,
    errorKind: kind,
    model: `${PROVIDER}/${(o.model ?? DEFAULT_MODEL).replace(/^opencode-go\//, "")}`,
    mode,
    agent,
    skipPermissions: skip,
    cwd: o.cwd,
    text: "",
    tools: [],
    durationMs: 0,
    error,
    id: o.id,
  };
}

/** Run a single opencode-go worker and return a structured result. */
export async function runOpencodeGo(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const mode: Mode = opts.mode ?? "ask";

  // 1) Resolve mode -> agent + permissions (with invariant checks).
  const resolved = resolveMode(mode, opts.agent);
  if (resolved.errorKind) {
    return failResult(opts, mode, resolved.agent, resolved.skipPermissions, resolved.errorKind, resolved.error!);
  }

  // 2) edit mode requires an explicit cwd (never silently mutate the server cwd).
  if (mode === "edit" && !opts.cwd) {
    return failResult(opts, mode, resolved.agent, resolved.skipPermissions, "cwd_required",
      "mode:\"edit\" requiere un `cwd` explícito para acotar dónde puede escribir/ejecutar el worker.");
  }

  // 3) CLI-enforced flag combinations.
  const flags = validateFlags(opts);
  if (flags.errorKind) {
    return failResult(opts, mode, resolved.agent, resolved.skipPermissions, flags.errorKind, flags.error!);
  }

  // 4) Provider hard-lock.
  let model: string;
  try {
    model = normalizeModel(opts.model);
  } catch (e: any) {
    return failResult(opts, mode, resolved.agent, resolved.skipPermissions, "provider_lock", e?.message ?? String(e));
  }

  const timeoutMs = opts.timeoutMs ?? 300_000;

  // 5) Build argv (never via a shell — no injection surface).
  const args = ["run", "--model", model, "--format", "json"];
  if (resolved.agent) args.push("--agent", resolved.agent);
  if (opts.variant) args.push("--variant", opts.variant);
  if (resolved.skipPermissions) args.push("--dangerously-skip-permissions");
  if (opts.cwd) args.push("--dir", opts.cwd);
  for (const f of opts.files ?? []) args.push("--file", f);
  if (opts.session) args.push("--session", opts.session);
  if (opts.continueSession) args.push("--continue");
  if (opts.fork) args.push("--fork");
  if (opts.title) args.push("--title", opts.title);
  args.push("--", opts.prompt); // `--` keeps the prompt positional even if it starts with a dash

  // 6) Spawn + parse.
  const { stdout, stderr, exitCode, timedOut, spawnError } = await spawnOpencode(args, opts.cwd, timeoutMs);
  const parsed = parseEvents(stdout);
  const durationMs = Date.now() - started;

  let ok = false;
  let errorKind: ErrorKind | undefined;
  let error: string | undefined;
  if (spawnError) {
    errorKind = "spawn_error";
    error = `No se pudo lanzar opencode: ${spawnError}`;
  } else if (timedOut) {
    errorKind = "timeout";
    error = `Timeout tras ${timeoutMs}ms`;
  } else if (parsed.errors.length) {
    errorKind = "model_error";
    error = parsed.errors.join(" | ");
  } else if (exitCode !== 0) {
    errorKind = "nonzero_exit";
    error = `opencode salió con código ${exitCode}: ${stderr.trim().slice(0, 500)}`;
  } else if (!parsed.sawStepFinish) {
    errorKind = "no_output";
    error = `Sin respuesta del modelo. stderr: ${stderr.trim().slice(0, 500)}`;
  } else {
    ok = true;
  }

  return {
    ok,
    errorKind,
    model,
    mode,
    agent: resolved.agent,
    skipPermissions: resolved.skipPermissions,
    cwd: opts.cwd,
    text: parsed.text,
    reasoning: parsed.reasoning || undefined,
    sessionID: parsed.sessionID, // present even on timeout
    tokens: parsed.tokens,
    cost: parsed.cost,
    tools: parsed.tools,
    durationMs,
    error,
    exitCode,
    id: opts.id,
  };
}

/** Run many workers concurrently with a bounded pool. */
export async function fanout(tasks: RunOptions[], concurrency = 4): Promise<RunResult[]> {
  const results: RunResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = await runOpencodeGo(tasks[i]);
      } catch (e: any) {
        const mode: Mode = tasks[i].mode ?? "ask";
        results[i] = failResult(tasks[i], mode, undefined, false, "spawn_error", e?.message ?? String(e));
      }
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker);
  await Promise.all(pool);
  return results;
}

/**
 * Canonicalize a path so equivalent spellings collide: trailing slash, "."
 * segments, symlinks, and case on case-insensitive macOS filesystems.
 */
function canonicalCwd(p: string): string {
  let out: string;
  try {
    out = realpathSync(resolve(p));
  } catch {
    out = resolve(p); // dir may not exist yet
  }
  return process.platform === "darwin" ? out.toLowerCase() : out;
}

/**
 * Detect parallel edit-mode tasks that would share a working dir and stomp each
 * other's edits / git state. Returns the set of task indexes to reject.
 * cwd-less edit tasks are NOT flagged here — they fall through to runOpencodeGo,
 * which reports the accurate `cwd_required` error.
 */
export function detectEditCollisions(tasks: RunOptions[]): Set<number> {
  const byCwd = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    if ((t.mode ?? "ask") !== "edit") return;
    if (!t.cwd) return; // -> cwd_required downstream, not a collision
    const key = canonicalCwd(t.cwd);
    (byCwd.get(key) ?? byCwd.set(key, []).get(key)!).push(i);
  });
  const collisions = new Set<number>();
  for (const idxs of byCwd.values()) {
    if (idxs.length > 1) for (const i of idxs) collisions.add(i);
  }
  return collisions;
}

/** Live list of opencode-go models from the CLI (falls back to KNOWN list). */
export async function listGoModels(): Promise<string[]> {
  const res = await spawnOpencode(["models"], undefined, 30_000);
  const live = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${PROVIDER}/`))
    .map((l) => l.slice(PROVIDER.length + 1));
  return live.length ? live : KNOWN_GO_MODELS;
}

// CLI helper: `bun run mcp/lib.ts --list-models`
if (import.meta.main && process.argv.includes("--list-models")) {
  listGoModels().then((m) => {
    console.log(m.map((x) => `${PROVIDER}/${x}`).join("\n"));
  });
}
