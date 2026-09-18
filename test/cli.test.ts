import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { committedFixture, kernelDirectory } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("CLI initializes and reads from the formal ref", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const initialized = await execFileAsync(
    process.execPath,
    [cli, "init", "--source", source.root, "--data", data, "--project", "death-penalty-fixture"],
    { encoding: "utf8", windowsHide: true },
  );
  const formalCommit = String(JSON.parse(initialized.stdout).formalCommit);
  assert.notEqual(formalCommit, source.commit);

  const shown = await execFileAsync(
    process.execPath,
    [
      cli,
      "show",
      "--data",
      data,
      "--project",
      "death-penalty-fixture",
      "--file",
      "config/death-penalty.json",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(shown.stdout).hard.penalty_bps, 1000);

  const begun = await execFileAsync(
    process.execPath,
    [
      cli,
      "begin",
      "--data",
      data,
      "--project",
      "death-penalty-fixture",
      "--request",
      "普通模式死亡损失从 10% 改为 5%，困难模式保持 10%",
      "--key",
      "cli-begin-key",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const changeId = JSON.parse(begun.stdout).changeId as string;
  const planned = await execFileAsync(
    process.execPath,
    [
      cli,
      "plan",
      "--data",
      data,
      "--project",
      "death-penalty-fixture",
      "--change",
      changeId,
      "--expected",
      "0",
      "--input",
      fileURLToPath(new URL("../../fixtures/death-penalty/change-plan-draft.json", import.meta.url)),
      "--key",
      "cli-plan-key",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(planned.stdout).plan_revision, 1);

  const status = await execFileAsync(
    process.execPath,
    [cli, "status", "--data", data, "--project", "death-penalty-fixture", "--change", changeId],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(status.stdout).state, "awaiting_execution_approval");

  const context = await execFileAsync(
    process.execPath,
    [cli, "context", "--data", data, "--project", "death-penalty-fixture", "--targets", "RULE-DEATH-NORMAL"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.deepEqual(
    JSON.parse(context.stdout).definite_impacts.map((impact: { rule: { id: string } }) => impact.rule.id),
    ["RULE-TUTORIAL-DEATH"],
  );

  const reconciliation = await execFileAsync(
    process.execPath,
    [cli, "reconcile", "--data", data, "--project", "death-penalty-fixture", "--rule", "RULE-DEATH-NORMAL"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(reconciliation.stdout)[0].status, "consistent");

  const validation = await execFileAsync(
    process.execPath,
    [cli, "validate", "--data", data, "--project", "death-penalty-fixture"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(validation.stdout).all_required_passed, true);
});
