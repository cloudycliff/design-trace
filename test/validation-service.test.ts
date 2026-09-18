import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { DesignTraceError } from "../src/core/errors.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { ValidationService } from "../src/domain/validation-service.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { git } from "../src/git/git-client.js";
import { committedFixture, kernelDirectory, temporaryDirectory } from "./helpers.js";

async function initializedValidator(): Promise<ValidationService> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  return new ValidationService(initialized.repositoryPath, await temporaryDirectory("dt-validation-"));
}

test("registered checks run against one immutable Git tree", async () => {
  const validator = await initializedValidator();
  const batch = await validator.run();
  assert.equal(batch.runs.length, 4);
  assert.equal(batch.all_required_passed, true);
  assert.match(batch.batch_id, /^BATCH-/u);
  assert.ok(batch.runs.every((run) => run.result === "passed"));
  assert.ok(batch.runs.every((run) => run.source_tree_oid === batch.source_tree_oid));
  assert.equal(new Set(batch.runs.map((run) => run.input_manifest_digest)).size, 1);
  for (const run of batch.runs) {
    assert.match(run.log_digest, /^[0-9a-f]{64}$/u);
  }
});

test("a failed required parameter check blocks batch success", async () => {
  const validator = await initializedValidator();
  const batch = await validator.run("refs/heads/dt-main", {
    checkIds: ["CHECK-NORMAL-PENALTY"],
    parameterExpectations: { "CHECK-NORMAL-PENALTY": 500 },
  });
  assert.equal(batch.runs[0]?.result, "failed");
  assert.equal(batch.all_required_passed, false);
});

test("a command that mutates its validation checkout is rejected", async () => {
  const source = await committedFixture();
  const projectPath = path.join(source.root, "design/project.yaml");
  const project = await readFile(projectPath, "utf8");
  await writeFile(
    projectPath,
    project.replace("tests/death-penalty.test.mjs", "tests/mutating.mjs"),
  );
  await writeFile(
    path.join(source.root, "tests/mutating.mjs"),
    'import test from "node:test";\nimport { appendFile } from "node:fs/promises";\ntest("mutates input", async () => { await appendFile("config/death-penalty.json", "mutated"); });\n',
  );
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Add mutating validator"]);
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const validationRoot = await temporaryDirectory("dt-validation-");
  const validator = new ValidationService(initialized.repositoryPath, validationRoot);
  const batch = await validator.run("refs/heads/dt-main", { checkIds: ["CHECK-REGRESSION"] });
  const batchDirectories = await readdir(validationRoot);
  const log = await readFile(
    path.join(validationRoot, batchDirectories[0]!, "sha256", batch.runs[0]!.log_digest),
    "utf8",
  );
  assert.equal(batch.runs[0]?.result, "error", log);
  assert.match(batch.runs[0]?.log_digest ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(batch.all_required_passed, false);
});

test("required unknown, error, timeout, and missing checks cannot pass", async () => {
  const source = await committedFixture();
  const projectPath = path.join(source.root, "design/project.yaml");
  await writeFile(projectPath, `${await readFile(projectPath, "utf8")}
  - id: CHECK-HUMAN-PENDING
    version: 1
    kind: human
    required: true
    runner:
      type: builtin
      name: operator-recorded
  - id: CHECK-UNSUPPORTED
    version: 1
    kind: structure
    required: true
    runner:
      type: builtin
      name: unsupported
  - id: CHECK-TIMEOUT
    version: 1
    kind: regression
    required: true
    runner:
      type: command
      executable: node
      args:
        - -e
        - "setInterval(() => {}, 1000)"
    timeout_ms: 25
`);
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Add non-passing validation cases"]);
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const validator = new ValidationService(initialized.repositoryPath, await temporaryDirectory("dt-validation-statuses-"));
  const batch = await validator.run("refs/heads/dt-main", {
    checkIds: ["CHECK-HUMAN-PENDING", "CHECK-UNSUPPORTED", "CHECK-TIMEOUT"],
  });
  assert.deepEqual(batch.runs.map((run) => run.result), ["unknown", "error", "timeout"]);
  assert.equal(batch.all_required_passed, false);
  await assert.rejects(
    validator.run("refs/heads/dt-main", { checkIds: ["CHECK-NOT-REGISTERED"] }),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT",
  );
});
