import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import { DesignTraceMcp } from "../src/mcp/design-trace-mcp.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

async function mcpFixture(): Promise<{ data: string; projectRoot: string; adapter: DesignTraceMcp }> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  return { data, projectRoot, adapter: new DesignTraceMcp(projectRoot, "death-penalty-fixture") };
}

test("MCP exposes domain operations but no approval capability", async () => {
  const setup = await mcpFixture();
  const names = setup.adapter.listTools().map((tool) => tool.name);
  assert.ok(names.includes("query_design"));
  assert.ok(names.includes("request_review"));
  assert.ok(names.includes("commit_change"));
  assert.ok(names.includes("propose_revert"));
  assert.equal(names.some((name) => /(?:^|_)(?:approve|sign)(?:_|$)/u.test(name)), false);

  const queried = await setup.adapter.callTool("query_design", {
    rule_id: "RULE-DEATH-NORMAL",
    field: "parameters.penalty_bps",
  });
  assert.equal((queried.structuredContent.rule as { version: number }).version, 1);
});

test("MCP cancellation is idempotent and preserves applied-versus-cancelled semantics", async () => {
  const setup = await mcpFixture();
  const begun = await setup.adapter.callTool("begin_change", {
    request: "取消测试",
    idempotency_key: "begin-key",
  });
  const changeId = String(begun.structuredContent.changeId);
  const first = await setup.adapter.callTool("cancel_change", {
    change_id: changeId,
    reason: "用户不再需要",
    idempotency_key: "cancel-key",
  });
  const repeated = await setup.adapter.callTool("cancel_change", {
    change_id: changeId,
    reason: "用户不再需要",
    idempotency_key: "cancel-key",
  });
  assert.equal(first.structuredContent.state, "cancelled");
  assert.deepEqual(repeated.structuredContent, first.structuredContent);
  assert.equal((await new ChangeSessionService(setup.projectRoot, "death-penalty-fixture").getStatus(changeId)).state, "cancelled");
});

test("stdio entrypoint performs MCP initialize and tools/list framing", async () => {
  const setup = await mcpFixture();
  const child = spawn(process.execPath, [
    path.resolve("dist/src/mcp/stdio.js"),
    "--data",
    setup.data,
    "--project",
    "death-penalty-fixture",
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.end();
  const [exitCode] = await once(child, "exit") as [number];
  assert.equal(exitCode, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
    id: number;
    result: Record<string, unknown>;
  });
  assert.equal((messages[0]?.result.serverInfo as { name: string }).name, "design-trace");
  const listed = (messages[1]?.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(listed.includes("commit_change"));
  assert.equal(listed.some((name) => /(?:^|_)(?:approve|sign)(?:_|$)/u.test(name)), false);
});
