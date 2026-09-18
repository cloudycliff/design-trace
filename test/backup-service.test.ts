import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BackupService } from "../src/domain/backup-service.js";
import type { ChangePlanDraft } from "../src/domain/change-plan.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import { DesignTraceError } from "../src/core/errors.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { git } from "../src/git/git-client.js";
import { ApprovalAuthority } from "../src/operator/approval-authority.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

const draft: ChangePlanDraft = {
  origin: "user_instruction",
  kind: "update",
  request: "backup recovery test",
  goal: "normal penalty becomes 5%",
  targets: ["RULE-DEATH-NORMAL"],
  allowed_paths: ["config/death-penalty.json"],
  allowed_config_changes: [{ path: "config/death-penalty.json", pointer: "/normal/penalty_bps", before: 1000, after: 500 }],
  design_changes: [{ rule_id: "RULE-DEATH-NORMAL", fields: ["parameters.penalty_bps"] }],
  out_of_scope: ["hard mode"],
  protected_checks: ["CHECK-HARD-UNCHANGED"],
  acceptance_checks: ["CHECK-CONFIG-SCHEMA", "CHECK-NORMAL-PENALTY", "CHECK-REGRESSION"],
  risk_level: "low",
  policy_version: 1,
};

test("backup verifies, restores formal state, survives Git GC, and invalidates runtime approvals", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  const sessions = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  const begun = await sessions.beginChange(draft.request, "begin-key");
  await sessions.revisePlan(begun.changeId, 0, draft, "plan-key");
  const authority = new ApprovalAuthority(projectRoot);
  const review = await authority.prepareExecutionReview(begun.changeId);
  const pending = await authority.getOperatorReview(review.review_id);
  await authority.approveExecution(review.review_id, pending.nonce, "operator");

  const backupPath = path.join(path.dirname(data), "backup-copy");
  const manifest = await new BackupService(projectRoot).create(backupPath);
  assert.equal((await BackupService.verify(backupPath)).manifest_digest, manifest.manifest_digest);
  const restoreRoot = await kernelDirectory();
  const restoredRoot = await BackupService.restore(backupPath, restoreRoot);
  const restoredRepository = new FormalRepository(path.join(restoredRoot, "repository.git"));
  assert.equal(await restoredRepository.currentCommit(), initialized.formalCommit);
  await git(process.cwd(), ["gc"], { gitDir: path.join(restoredRoot, "repository.git") });
  assert.match(await restoredRepository.readFormalText("design/rules/death-normal.md"), /RULE-DEATH-NORMAL/u);
  await assert.rejects(
    new ApprovalAuthority(restoredRoot).requireValidExecutionApproval(begun.changeId),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );

  const metadataPath = path.join(backupPath, "project.json");
  await writeFile(metadataPath, `${await readFile(metadataPath, "utf8")} `);
  await assert.rejects(
    BackupService.verify(backupPath),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );
});
