#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DesignTraceError } from "./core/errors.js";
import { ChangeSessionService } from "./domain/change-session-service.js";
import type { ChangePlanDraft } from "./domain/change-plan.js";
import { FormalRepository } from "./formal/formal-repository.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "init") {
    const source = path.resolve(flag("source") ?? ".");
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    if (!project) throw new Error("init requires --project <project-id>");
    const result = await FormalRepository.initialize(source, data, project, flag("revision") ?? "HEAD");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "show") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const file = flag("file");
    if (!project || !file) throw new Error("show requires --project <project-id> --file <repo-path>");
    const repository = new FormalRepository(path.join(data, project, "repository.git"));
    process.stdout.write(`${await repository.readFormalText(file)}\n`);
    return;
  }

  if (command === "begin") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const request = flag("request");
    const key = flag("key");
    if (!project || !request || !key) {
      throw new Error("begin requires --project <id> --request <goal> --key <idempotency-key>");
    }
    const service = new ChangeSessionService(path.join(data, project), project);
    process.stdout.write(`${JSON.stringify(await service.beginChange(request, key), null, 2)}\n`);
    return;
  }

  if (command === "plan") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const change = flag("change");
    const input = flag("input");
    const key = flag("key");
    const expected = Number(flag("expected"));
    if (!project || !change || !input || !key || !Number.isInteger(expected) || expected < 0) {
      throw new Error(
        "plan requires --project <id> --change <id> --expected <revision> --input <json> --key <idempotency-key>",
      );
    }
    const draft = JSON.parse(await readFile(path.resolve(input), "utf8")) as ChangePlanDraft;
    const service = new ChangeSessionService(path.join(data, project), project);
    process.stdout.write(
      `${JSON.stringify(await service.revisePlan(change, expected, draft, key), null, 2)}\n`,
    );
    return;
  }

  if (command === "status") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const change = flag("change");
    if (!project || !change) throw new Error("status requires --project <id> --change <id>");
    const service = new ChangeSessionService(path.join(data, project), project);
    process.stdout.write(`${JSON.stringify(await service.getStatus(change), null, 2)}\n`);
    return;
  }

  process.stderr.write(
    "Usage:\n" +
      "  design-trace init --source <git-repo> --data <kernel-data> --project <id> [--revision <commit>]\n" +
      "  design-trace show --data <kernel-data> --project <id> --file <repo-path>\n" +
      "  design-trace begin --data <kernel-data> --project <id> --request <goal> --key <key>\n" +
      "  design-trace plan --data <kernel-data> --project <id> --change <id> --expected <n> --input <json> --key <key>\n" +
      "  design-trace status --data <kernel-data> --project <id> --change <id>\n",
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof DesignTraceError) {
    process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, details: error.details })}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
