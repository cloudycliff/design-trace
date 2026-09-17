#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DesignTraceError } from "./core/errors.js";
import { ChangeSessionService } from "./domain/change-session-service.js";
import type { ChangePlanDraft } from "./domain/change-plan.js";
import { buildContext } from "./domain/context-service.js";
import { loadFormalObjects } from "./domain/formal-objects.js";
import { reconcileBinding } from "./domain/reconciliation.js";
import { ValidationService } from "./domain/validation-service.js";
import { ApprovalAuthority } from "./operator/approval-authority.js";
import { OperatorServer } from "./operator/operator-server.js";
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

  if (command === "context") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const targets = flag("targets")?.split(",").filter(Boolean);
    if (!project || !targets?.length) throw new Error("context requires --project <id> --targets <rule-id,...>");
    const repository = new FormalRepository(path.join(data, project, "repository.git"));
    process.stdout.write(`${JSON.stringify(await buildContext(repository.treeReader(), targets), null, 2)}\n`);
    return;
  }

  if (command === "reconcile") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const ruleId = flag("rule");
    if (!project || !ruleId) throw new Error("reconcile requires --project <id> --rule <rule-id>");
    const repository = new FormalRepository(path.join(data, project, "repository.git"));
    const reader = repository.treeReader();
    const objects = await loadFormalObjects(reader);
    const rule = objects.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) throw new Error(`Unknown Rule: ${ruleId}`);
    const bindings = objects.bindings.filter((binding) => binding.rule_id === ruleId);
    const results = await Promise.all(bindings.map((binding) => reconcileBinding(reader, rule, binding)));
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  if (command === "validate") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    if (!project) throw new Error("validate requires --project <id>");
    const projectRoot = path.join(data, project);
    const service = new ValidationService(
      path.join(projectRoot, "repository.git"),
      path.join(projectRoot, "validation"),
    );
    const checkIds = flag("checks")?.split(",").filter(Boolean);
    const options = checkIds ? { checkIds } : {};
    process.stdout.write(`${JSON.stringify(await service.run("refs/heads/dt-main", options), null, 2)}\n`);
    return;
  }

  if (command === "review-execution") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const change = flag("change");
    if (!project || !change) throw new Error("review-execution requires --project <id> --change <id>");
    const authority = new ApprovalAuthority(path.join(data, project));
    const review = await authority.prepareExecutionReview(change);
    process.stdout.write(
      `${JSON.stringify({ ...review, review_path: `/review/execution/${review.review_id}` }, null, 2)}\n`,
    );
    return;
  }

  if (command === "start-execution") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    const change = flag("change");
    const key = flag("key");
    if (!project || !change || !key) {
      throw new Error("start-execution requires --project <id> --change <id> --key <idempotency-key>");
    }
    const service = new ChangeSessionService(path.join(data, project), project);
    process.stdout.write(`${JSON.stringify(await service.startExecution(change, key), null, 2)}\n`);
    return;
  }

  if (command === "operator-server") {
    const data = path.resolve(flag("data") ?? ".dt");
    const project = flag("project");
    if (!project) throw new Error("operator-server requires --project <id>");
    const server = new OperatorServer(new ApprovalAuthority(path.join(data, project)));
    const origin = await server.start();
    process.stdout.write(`${JSON.stringify({ origin, binding: "loopback-only" })}\n`);
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void server.close().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }

  process.stderr.write(
    "Usage:\n" +
      "  design-trace init --source <git-repo> --data <kernel-data> --project <id> [--revision <commit>]\n" +
      "  design-trace show --data <kernel-data> --project <id> --file <repo-path>\n" +
      "  design-trace begin --data <kernel-data> --project <id> --request <goal> --key <key>\n" +
      "  design-trace plan --data <kernel-data> --project <id> --change <id> --expected <n> --input <json> --key <key>\n" +
      "  design-trace status --data <kernel-data> --project <id> --change <id>\n" +
      "  design-trace context --data <kernel-data> --project <id> --targets <rule-id,...>\n" +
      "  design-trace reconcile --data <kernel-data> --project <id> --rule <rule-id>\n" +
      "  design-trace validate --data <kernel-data> --project <id> [--checks <check-id,...>]\n" +
      "  design-trace review-execution --data <kernel-data> --project <id> --change <id>\n" +
      "  design-trace operator-server --data <kernel-data> --project <id>\n" +
      "  design-trace start-execution --data <kernel-data> --project <id> --change <id> --key <key>\n",
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
