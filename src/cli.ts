#!/usr/bin/env node
import path from "node:path";
import { DesignTraceError } from "./core/errors.js";
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

  process.stderr.write(
    "Usage:\n" +
      "  design-trace init --source <git-repo> --data <kernel-data> --project <id> [--revision <commit>]\n" +
      "  design-trace show --data <kernel-data> --project <id> --file <repo-path>\n",
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
