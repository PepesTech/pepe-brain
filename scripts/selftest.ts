#!/usr/bin/env bun
// Self-test for the opencode-go bridge: guardrails (no model cost) + a few cheap
// real runs, including an autonomous edit proof.
//
//   bun run scripts/selftest.ts          # guardrails only (free)
//   bun run scripts/selftest.ts --live    # + cheap real runs (small cost)

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveMode,
  validateFlags,
  detectEditCollisions,
  normalizeModel,
  runOpencodeGo,
  DEFAULT_REDUCER_MODEL,
} from "../mcp/lib.ts";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

console.log("== resolveMode ==");
{
  const a = resolveMode("ask");
  check("ask -> plan, no skip", a.agent === "plan" && a.skipPermissions === false && !a.errorKind);
  const e = resolveMode("edit");
  check("edit -> build, skip", e.agent === "build" && e.skipPermissions === true && !e.errorKind);
  const c = resolveMode("chat" as any);
  check("removed mode (chat) -> bad_flags", c.errorKind === "bad_flags");
  const d = resolveMode("ask", "build");
  check("ask + build override -> permission_deadlock", d.errorKind === "permission_deadlock");
  const u = resolveMode("ask", "");
  check("ask + empty agent override -> stays plan (falsy override ignored, safe)", u.agent === "plan" && !u.errorKind);
  const o = resolveMode("edit", "plan");
  check("edit + plan override -> agent plan, still skip", o.agent === "plan" && o.skipPermissions === true && !o.errorKind);
}

console.log("== validateFlags ==");
{
  check("continueSession w/o session -> bad_flags", validateFlags({ prompt: "x", continueSession: true }).errorKind === "bad_flags");
  check("fork w/o session -> bad_flags", validateFlags({ prompt: "x", fork: true }).errorKind === "bad_flags");
  check("session + continue ok", !validateFlags({ prompt: "x", session: "s", continueSession: true }).errorKind);
  check("session + fork ok", !validateFlags({ prompt: "x", session: "s", fork: true }).errorKind);
}

console.log("== detectEditCollisions ==");
{
  const same = detectEditCollisions([
    { prompt: "a", mode: "edit", cwd: "/tmp/x" },
    { prompt: "b", mode: "edit", cwd: "/tmp/x" },
    { prompt: "c", mode: "edit", cwd: "/tmp/y" },
    { prompt: "d", mode: "ask" },
  ]);
  check("two edit tasks sharing cwd flagged", same.has(0) && same.has(1) && !same.has(2) && !same.has(3), `got ${[...same]}`);

  const cwdless = detectEditCollisions([
    { prompt: "a", mode: "edit" },
    { prompt: "b", mode: "edit" },
  ]);
  check("cwd-less edit tasks NOT flagged (fall through to cwd_required)", cwdless.size === 0, `got ${[...cwdless]}`);

  const equiv = detectEditCollisions([
    { prompt: "a", mode: "edit", cwd: "/tmp/ocgo-equiv" },
    { prompt: "b", mode: "edit", cwd: "/tmp/ocgo-equiv/" },
  ]);
  check("equivalent cwd spellings collide (trailing slash)", equiv.has(0) && equiv.has(1), `got ${[...equiv]}`);
}

console.log("== normalizeModel lock ==");
{
  check("bare -> opencode-go/", normalizeModel("glm-5.2") === "opencode-go/glm-5.2");
  let threw = false;
  try { normalizeModel("openai/gpt-5"); } catch { threw = true; }
  check("openai/* rejected", threw);
}

console.log("== model aliases + reducer default ==");
{
  check("alias code -> glm-5.2", normalizeModel("code") === "opencode-go/glm-5.2");
  check("alias reason -> deepseek-v4-pro", normalizeModel("reason") === "opencode-go/deepseek-v4-pro");
  check("alias fast & reduce -> deepseek-v4-flash",
    normalizeModel("fast") === "opencode-go/deepseek-v4-flash" && normalizeModel("reduce") === "opencode-go/deepseek-v4-flash");
  check("alias case-insensitive (CODE)", normalizeModel("CODE") === "opencode-go/glm-5.2");
  check("full id not clobbered by alias", normalizeModel("opencode-go/glm-5.2") === "opencode-go/glm-5.2");
  let aliasLock = false;
  try { normalizeModel("openai/x"); } catch { aliasLock = true; }
  check("alias path doesn't bypass provider lock", aliasLock);
  check("reducer default = deepseek-v4-flash (fast/cheap)", DEFAULT_REDUCER_MODEL === "deepseek-v4-flash");
}

console.log("== runOpencodeGo pre-spawn guards (no cost) ==");
{
  const cwdReq = await runOpencodeGo({ prompt: "x", mode: "edit" });
  check("edit w/o cwd -> cwd_required, no spawn", cwdReq.errorKind === "cwd_required" && cwdReq.durationMs === 0);
  const lock = await runOpencodeGo({ prompt: "x", model: "openai/gpt-5" });
  check("provider lock -> provider_lock, no spawn", lock.errorKind === "provider_lock" && lock.durationMs === 0);
  const dead = await runOpencodeGo({ prompt: "x", mode: "ask", agent: "build" });
  check("ask+build -> permission_deadlock, no spawn", dead.errorKind === "permission_deadlock" && dead.durationMs === 0);
  const bad = await runOpencodeGo({ prompt: "x", continueSession: true });
  check("continue w/o session -> bad_flags, no spawn", bad.errorKind === "bad_flags" && bad.durationMs === 0);
}

if (process.argv.includes("--live")) {
  console.log("== live: ask run (deepseek-v4-flash) ==");
  const r = await runOpencodeGo({ prompt: "Reply with exactly: ASK_OK", model: "deepseek-v4-flash", mode: "ask", timeoutMs: 90000 });
  check("ask run ok + text", r.ok && r.text.includes("ASK_OK"), `text=${JSON.stringify(r.text)} err=${r.error ?? ""}`);
  check("ask run reports nonzero cost + tokens", (r.cost ?? 0) > 0 && (r.tokens?.total ?? 0) > 0, `cost=${r.cost} tokens=${JSON.stringify(r.tokens)}`);
  console.log(`    cost=$${r.cost} tokens=${r.tokens?.total} agent=${r.agent} skip=${r.skipPermissions} session=${r.sessionID}`);

  console.log("== live: autonomous EDIT proof (kimi-k2.7-code) ==");
  const dir = mkdtempSync(join(tmpdir(), "ocgo-edit-"));
  const target = join(dir, "proof.txt");
  const er = await runOpencodeGo({
    prompt: "Create a file named proof.txt in the current directory containing exactly the text EDIT_OK (no quotes, no trailing newline). Then stop.",
    model: "kimi-k2.7-code",
    mode: "edit",
    cwd: dir,
    timeoutMs: 180000,
  });
  const made = existsSync(target);
  const fileContent = made ? readFileSync(target, "utf8").trim() : "(missing)";
  check("edit run reported ok", er.ok, `err=${er.error ?? ""} kind=${er.errorKind ?? ""}`);
  check("edit actually created the file", made, `dir=${dir}`);
  check("edit file content == EDIT_OK", fileContent === "EDIT_OK", `got=${JSON.stringify(fileContent)}`);
  console.log(`    cwd=${er.cwd} agent=${er.agent} skip=${er.skipPermissions} tools=${JSON.stringify(er.tools)} cost=$${er.cost}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
