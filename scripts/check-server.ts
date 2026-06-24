#!/usr/bin/env bun
// End-to-end smoke test: spawn the MCP server over stdio exactly as Claude Code
// would, then list tools and exercise each one.
//
//   bun run scripts/check-server.ts          # list tools + models only (no model cost)
//   bun run scripts/check-server.ts --run     # also run a cheap worker (small cost)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "mcp", "server.ts");

const transport = new StdioClientTransport({
  command: process.execPath, // bun
  args: ["run", serverPath],
});
const client = new Client({ name: "check", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

const models = await client.callTool({ name: "opencode_go_models", arguments: {} });
console.log("\nopencode_go_models ->");
console.log((models.content as any[]).map((c) => c.text).join("\n"));

if (process.argv.includes("--run")) {
  console.log("\nopencode_go_run (deepseek-v4-flash) ->");
  const r = await client.callTool({
    name: "opencode_go_run",
    arguments: { prompt: "Reply with exactly: SERVER_OK", model: "deepseek-v4-flash", timeoutMs: 90000 },
  });
  console.log("isError:", (r as any).isError);
  console.log((r.content as any[]).map((c) => c.text).join("\n"));
}

await client.close();
console.log("\n✅ check done");
process.exit(0);
