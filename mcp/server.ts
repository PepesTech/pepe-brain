#!/usr/bin/env bun
// MCP server (stdio) that exposes opencode workers to Claude Code as first-class
// tools. Every tool is hard-locked to the `opencode-go` provider.
//
//   opencode_go_run     -> one worker (modes: ask/edit/chat, sessions, files)
//   opencode_go_fanout  -> N workers in parallel + optional reduce (consensus/map-reduce)
//   opencode_go_models  -> list available OpenCode Go models
//
// Output convention: the LAST content block of every tool is PURE JSON (machine
// block) so one tool's output pipes cleanly into the next (esp. sessionID).
//
// Run:  bun run mcp/server.ts   (registered via .mcp.json)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REDUCER_MODEL,
  MODEL_ALIASES,
  PROVIDER,
  STACK,
  detectEditCollisions,
  fanout,
  listGoModels,
  runOpencodeGo,
  type Mode,
  type RunOptions,
  type RunResult,
} from "./lib.ts";

const server = new Server(
  { name: "opencode-go", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

const STACK_HINT = STACK.map((s) => `${s.id} (${s.role})`).join(", ");
const ALIAS_HINT = Object.keys(MODEL_ALIASES).join(", ");
const MODES: Mode[] = ["ask", "edit"];
const VARIANTS = ["minimal", "low", "medium", "high", "max"];

// Reusable description of the per-worker fields (run params == fanout task fields).
const WORKER_PROPS = {
  prompt: { type: "string", description: "Instruction / task for the worker model." },
  model: {
    type: "string",
    description:
      `OpenCode Go model — bare id, opencode-go/<id>, or a ROLE ALIAS (hard-locked to opencode-go). Default ${DEFAULT_MODEL}. ` +
      `Curated stack: ${STACK_HINT}. Aliases: ${ALIAS_HINT}. Call opencode_go_models for the live list.`,
  },
  mode: {
    type: "string",
    enum: MODES,
    description:
      "Safe agent+permission bundle. ask=plan/read-only (DEFAULT), edit=build + auto-approved " +
      "edits/bash (autonomous; REQUIRES a distinct cwd per worker).",
  },
  agent: {
    type: "string",
    description: "Override the agent chosen by `mode` (e.g. a custom agent). `mode` still governs permissions.",
  },
  variant: { type: "string", enum: VARIANTS, description: "Reasoning effort -> --variant." },
  cwd: { type: "string", description: "Working dir -> --dir. REQUIRED when mode='edit'." },
  files: { type: "array", items: { type: "string" }, description: "Paths to attach -> repeated --file." },
  session: { type: "string", description: "Resume this opencode session id (from a prior run's JSON block)." },
  continueSession: { type: "boolean", description: "-> --continue. Requires `session`." },
  fork: { type: "boolean", description: "-> --fork. Requires `session` or `continueSession`." },
  title: { type: "string", description: "-> --title. Makes the spawned session greppable." },
  timeoutMs: { type: "number", description: "Kill the worker after N ms. Default 300000. sessionID still returned on timeout." },
} as const;

const RUN_SCHEMA = {
  type: "object",
  properties: WORKER_PROPS,
  required: ["prompt"],
  additionalProperties: false,
} as const;

const FANOUT_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      description: "Tasks to run concurrently. Each becomes one independent opencode-go worker.",
      minItems: 1,
      items: {
        type: "object",
        properties: { id: { type: "string", description: "Caller label for addressable results." }, ...WORKER_PROPS },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    concurrency: { type: "number", description: "Max workers running at once. Default 4." },
    reduce: {
      type: "object",
      description:
        "Optional map-reduce / consensus. After the workers finish, ONE read-only Go worker reduces all " +
        "answers. Put {{answers}} in the prompt where the worker outputs should be injected.",
      properties: {
        prompt: { type: "string", description: "Reducer instruction. Use {{answers}} placeholder." },
        model: { type: "string", description: `Reducer model (id or alias). Default ${DEFAULT_REDUCER_MODEL} (fast + cheap).` },
        variant: { type: "string", enum: VARIANTS },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  required: ["tasks"],
  additionalProperties: false,
} as const;

const TOOLS = [
  {
    name: "opencode_go_run",
    description:
      "Run ONE opencode worker backed by the OpenCode Go provider (Qwen, GLM, Kimi, DeepSeek, MiniMax, " +
      `MiMo). Hard-locked to opencode-go/*; default model ${DEFAULT_MODEL}, default mode 'ask' (read-only). ` +
      "Use mode:'edit' (+ cwd) for autonomous file edits/bash. Pass session+continueSession to resume a " +
      "prior worker. Last content block is pure JSON { ok, errorKind?, sessionID, model, mode, cost, tokens, ... }.",
    inputSchema: RUN_SCHEMA,
  },
  {
    name: "opencode_go_fanout",
    description:
      "Run MANY opencode-go workers in parallel (one per task) — the multi-agent primitive. Optional `reduce` " +
      "step folds all answers through one more Go worker (consensus / best-of-N / map-reduce). All raw answers " +
      "are always returned so you can override the reducer. Last block is a pure-JSON summary.",
    inputSchema: FANOUT_SCHEMA,
  },
  {
    name: "opencode_go_models",
    description: "List the available OpenCode Go models (live from the opencode CLI).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function meta(r: RunResult) {
  return {
    ok: r.ok,
    errorKind: r.errorKind,
    model: r.model,
    mode: r.mode,
    agent: r.agent,
    skipPermissions: r.skipPermissions,
    cwd: r.cwd,
    sessionID: r.sessionID,
    tokens: r.tokens,
    cost: r.cost,
    durationMs: r.durationMs,
    tools: r.tools,
    exitCode: r.exitCode,
    ...(r.id ? { id: r.id } : {}),
  };
}

function humanBlock(r: RunResult, label: string) {
  const flag = r.ok ? "✓" : `✗ ${r.errorKind}`;
  const body = r.text || (r.error ? `(${r.error})` : "(sin texto)");
  return { type: "text" as const, text: `### ${label} · ${r.model} · ${flag}\n${body}` };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs = {} } = req.params;
  const args = rawArgs as any;

  try {
    if (name === "opencode_go_run") {
      const r = await runOpencodeGo(args as RunOptions);
      return {
        isError: !r.ok,
        content: [
          { type: "text", text: r.text || (r.error ? `(error: ${r.error})` : "(sin texto de salida)") },
          { type: "text", text: JSON.stringify(meta(r)) }, // pure-JSON machine block (last)
        ],
      };
    }

    if (name === "opencode_go_fanout") {
      const tasks: RunOptions[] = args.tasks ?? [];
      const concurrency: number = args.concurrency ?? 4;
      const reduce = args.reduce as { prompt: string; model?: string; variant?: string } | undefined;

      // Pre-empt parallel edit workers sharing a cwd (would corrupt each other).
      const collisions = detectEditCollisions(tasks);
      const runnable = tasks.map((t, i) => ({ t, i })).filter(({ i }) => !collisions.has(i));
      const ran = await fanout(runnable.map((x) => x.t), concurrency);

      const results: RunResult[] = new Array(tasks.length);
      runnable.forEach((x, k) => (results[x.i] = ran[k]));
      for (const i of collisions) {
        results[i] = {
          ok: false,
          errorKind: "edit_collision",
          model: `${PROVIDER}/${(tasks[i].model ?? DEFAULT_MODEL).replace(/^opencode-go\//, "")}`,
          mode: "edit",
          skipPermissions: true,
          cwd: tasks[i].cwd,
          text: "",
          tools: [],
          durationMs: 0,
          error: "Varios workers mode:'edit' comparten el mismo cwd. Dale a cada uno un cwd/worktree distinto.",
          id: tasks[i].id,
        };
      }

      const content: any[] = results.map((r, i) => humanBlock(r, `worker[${r.id ?? i}]`));

      // Optional reduce (consensus / map-reduce) — always read-only.
      let reducer: RunResult | undefined;
      if (reduce) {
        const digest = results
          .map((r, i) => {
            const label = r.id ?? `#${i}`;
            const tag = r.ok ? "" : ` (FALLÓ: ${r.errorKind})`;
            return `### ${label} [${r.model}]${tag}\n${(r.text || "(sin texto)").slice(0, 4000)}`;
          })
          .join("\n\n");
        const rp = reduce.prompt.includes("{{answers}}")
          ? reduce.prompt.replaceAll("{{answers}}", digest)
          : `${reduce.prompt}\n\n--- RESPUESTAS DE LOS WORKERS ---\n${digest}`;
        reducer = await runOpencodeGo({ prompt: rp, model: reduce.model ?? DEFAULT_REDUCER_MODEL, variant: reduce.variant, mode: "ask" });
        content.push(humanBlock(reducer, "reduce"));
      }

      const okCount = results.filter((r) => r.ok).length;
      const totalCost = results.reduce((a, r) => a + (r.cost ?? 0), 0) + (reducer?.cost ?? 0);
      const totalTokens = results.reduce((a, r) => a + (r.tokens?.total ?? 0), 0) + (reducer?.tokens?.total ?? 0);
      const byModel: Record<string, number> = {};
      for (const r of results) byModel[r.model] = (byModel[r.model] ?? 0) + 1;

      const summary = {
        okCount,
        total: results.length,
        totalCost,
        totalTokens,
        byModel,
        sessionIDs: results.map((r) => r.sessionID).filter(Boolean),
        reduce: reducer ? meta(reducer) : undefined,
        results: results.map((r, i) => ({
          id: r.id ?? i,
          index: i,
          ok: r.ok,
          errorKind: r.errorKind,
          model: r.model,
          mode: r.mode,
          cost: r.cost,
          tokens: r.tokens?.total,
          sessionID: r.sessionID,
        })),
      };
      content.push({ type: "text", text: JSON.stringify(summary) }); // pure-JSON summary (last)

      return { isError: okCount === 0 && !reducer?.ok, content };
    }

    if (name === "opencode_go_models") {
      const models = await listGoModels();
      return { content: [{ type: "text", text: models.map((m) => `${PROVIDER}/${m}`).join("\n") }] };
    }

    return { isError: true, content: [{ type: "text", text: `unknown_tool: ${name}` }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[opencode-go] MCP server v0.2 listo · default ${PROVIDER}/${DEFAULT_MODEL} · mode 'ask'`);
