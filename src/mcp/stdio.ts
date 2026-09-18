#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline";
import { DesignTraceError } from "../core/errors.js";
import { DesignTraceMcp } from "./design-trace-mcp.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const project = flag("project");
  if (!project) throw new Error("design-trace-mcp requires --project <project-id> [--data <kernel-data>]");
  const data = path.resolve(flag("data") ?? ".dt");
  const adapter = new DesignTraceMcp(path.join(data, project), project);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest | undefined;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("Invalid JSON-RPC request");
      if (request.method === "notifications/initialized") continue;
      if (request.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "design-trace", version: "0.1.0" },
          },
        });
        continue;
      }
      if (request.method === "tools/list") {
        send({ jsonrpc: "2.0", id: request.id ?? null, result: { tools: adapter.listTools() } });
        continue;
      }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        if (typeof name !== "string") throw new Error("tools/call requires params.name");
        send({
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: await adapter.callTool(name, request.params?.arguments),
        });
        continue;
      }
      send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      const designError = error instanceof DesignTraceError ? error : null;
      send({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: {
          code: designError ? -32000 : -32603,
          message: error instanceof Error ? error.message : String(error),
          data: designError ? { code: designError.code, details: designError.details } : undefined,
        },
      });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
