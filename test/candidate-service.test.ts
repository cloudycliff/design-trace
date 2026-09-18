import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CandidateService } from "../src/domain/candidate-service.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import type { ChangePlanDraft } from "../src/domain/change-plan.js";
import { DesignTraceError } from "../src/core/errors.js";
import { FormalRepository, GitTreeReader } from "../src/formal/formal-repository.js";
import { ApprovalAuthority } from "../src/operator/approval-authority.js";
import { git } from "../src/git/git-client.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

const draft: ChangePlanDraft = {
  origin: "user_instruction",
  kind: "update",
  request: "普通模式死亡损失从 10% 改为 5%，困难模式保持 10%",
  goal: "普通模式采用 5% 扣金规则，困难模式行为保持原样",
  targets: ["RULE-DEATH-NORMAL"],
  allowed_paths: ["config/death-penalty.json"],
  allowed_config_changes: [
    {
      path: "config/death-penalty.json",
      pointer: "/normal/penalty_bps",
      before: 1000,
      after: 500,
    },
  ],
  design_changes: [{ rule_id: "RULE-DEATH-NORMAL", fields: ["parameters.penalty_bps"] }],
  out_of_scope: ["困难模式参数与行为"],
  protected_checks: ["CHECK-HARD-UNCHANGED"],
  acceptance_checks: ["CHECK-CONFIG-SCHEMA", "CHECK-NORMAL-PENALTY", "CHECK-REGRESSION"],
  risk_level: "low",
  policy_version: 1,
};

async function executingChange(): Promise<{
  projectRoot: string;
  repositoryPath: string;
  changeId: string;
  attemptId: string;
  sessions: ChangeSessionService;
  candidates: CandidateService;
  workspace: string;
}> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  const sessions = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  const begun = await sessions.beginChange(draft.request, "begin-key");
  await sessions.revisePlan(begun.changeId, 0, draft, "plan-key");
  const authority = new ApprovalAuthority(projectRoot);
  const review = await authority.prepareExecutionReview(begun.changeId);
  const operatorReview = await authority.getOperatorReview(review.review_id);
  await authority.approveExecution(review.review_id, operatorReview.nonce, "operator-session");
  const attempt = await sessions.startExecution(begun.changeId, "attempt-key");
  return {
    projectRoot,
    repositoryPath: initialized.repositoryPath,
    changeId: begun.changeId,
    attemptId: attempt.attempt_id,
    sessions,
    candidates: new CandidateService(projectRoot),
    workspace: path.join(projectRoot, "execution", attempt.attempt_id),
  };
}

async function updateConfig(
  workspace: string,
  update: (config: { normal: { penalty_bps: number; rounding: string }; hard: { penalty_bps: number; rounding: string } }) => void,
): Promise<void> {
  const configPath = path.join(workspace, "config/death-penalty.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    normal: { penalty_bps: number; rounding: string };
    hard: { penalty_bps: number; rounding: string };
  };
  update(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

test("approved JSON field freezes into an immutable retained Git snapshot", async () => {
  const setup = await executingChange();
  assert.equal(await git(setup.workspace, ["remote"]), "");
  await updateConfig(setup.workspace, (config) => {
    config.normal.penalty_bps = 500;
  });
  const snapshot = await setup.candidates.freezeCandidate(
    setup.changeId,
    setup.attemptId,
    "freeze-key",
  );
  assert.deepEqual(snapshot.changed_paths, ["config/death-penalty.json"]);
  assert.equal(snapshot.changed_pointers[0]?.pointer, "/normal/penalty_bps");
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "candidate_ready");

  await updateConfig(setup.workspace, (config) => {
    config.normal.penalty_bps = 700;
  });
  const frozenConfig = JSON.parse(
    await new GitTreeReader(process.cwd(), snapshot.snapshot_commit, setup.repositoryPath).readText(
      "config/death-penalty.json",
    ),
  ) as { normal: { penalty_bps: number } };
  assert.equal(frozenConfig.normal.penalty_bps, 500);
});

test("scope checker rejects protected JSON fields and undeclared files", async () => {
  const protectedSetup = await executingChange();
  await updateConfig(protectedSetup.workspace, (config) => {
    config.normal.penalty_bps = 500;
    config.hard.penalty_bps = 500;
  });
  await assert.rejects(
    protectedSetup.candidates.freezeCandidate(
      protectedSetup.changeId,
      protectedSetup.attemptId,
      "freeze-key",
    ),
    (error) => error instanceof DesignTraceError && error.code === "SCOPE_VIOLATION",
  );
  assert.equal((await protectedSetup.sessions.getStatus(protectedSetup.changeId)).state, "blocked");
  const retry = await protectedSetup.sessions.startExecution(protectedSetup.changeId, "repair-attempt-key");
  assert.notEqual(retry.attempt_id, protectedSetup.attemptId);
  assert.equal(retry.attempt_number, 2);
  assert.equal((await protectedSetup.sessions.getStatus(protectedSetup.changeId)).state, "executing");

  const fileSetup = await executingChange();
  await updateConfig(fileSetup.workspace, (config) => {
    config.normal.penalty_bps = 500;
  });
  await writeFile(path.join(fileSetup.workspace, "surprise.txt"), "not approved\n");
  await assert.rejects(
    fileSetup.candidates.freezeCandidate(fileSetup.changeId, fileSetup.attemptId, "freeze-key"),
    (error) => error instanceof DesignTraceError && error.code === "SCOPE_VIOLATION",
  );
  assert.equal((await fileSetup.sessions.getStatus(fileSetup.changeId)).state, "blocked");
});

test("validation runs against the frozen snapshot and advances only on required passes", async () => {
  const setup = await executingChange();
  await updateConfig(setup.workspace, (config) => {
    config.normal.penalty_bps = 500;
  });
  const snapshot = await setup.candidates.freezeCandidate(
    setup.changeId,
    setup.attemptId,
    "freeze-key",
  );
  await updateConfig(setup.workspace, (config) => {
    config.hard.penalty_bps = 500;
  });
  const validation = await setup.candidates.validateCandidate(
    setup.changeId,
    snapshot.snapshot_id,
    "validate-key",
  );
  assert.equal(validation.all_required_passed, true);
  assert.ok(validation.runs.every((run) => run.source_tree_oid === snapshot.execution_tree_oid));
  const status = await setup.sessions.getStatus(setup.changeId);
  assert.equal(status.state, "awaiting_result_approval");
  assert.equal(status.validationBatchId, validation.batch_id);
});
