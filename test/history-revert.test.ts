import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DesignTraceError } from "../src/core/errors.js";
import { CandidateService } from "../src/domain/candidate-service.js";
import type { ChangePlan, ChangePlanDraft } from "../src/domain/change-plan.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import { HistoryService } from "../src/domain/history-service.js";
import { PublicationService } from "../src/domain/publication-service.js";
import { FormalRepository, GitTreeReader } from "../src/formal/formal-repository.js";
import { parseFrontmatter } from "../src/formal/frontmatter.js";
import { ApprovalAuthority } from "../src/operator/approval-authority.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

const projectId = "death-penalty-fixture";

function updateDraft(before: number, after: number, request: string): ChangePlanDraft {
  return {
    origin: "user_instruction",
    kind: "update",
    request,
    goal: `普通模式采用 ${after / 100}% 扣金规则，困难模式行为保持原样`,
    targets: ["RULE-DEATH-NORMAL"],
    allowed_paths: ["config/death-penalty.json"],
    allowed_config_changes: [{
      path: "config/death-penalty.json",
      pointer: "/normal/penalty_bps",
      before,
      after,
    }],
    design_changes: [{ rule_id: "RULE-DEATH-NORMAL", fields: ["parameters.penalty_bps"] }],
    out_of_scope: ["困难模式参数与行为"],
    protected_checks: ["CHECK-HARD-UNCHANGED"],
    acceptance_checks: ["CHECK-CONFIG-SCHEMA", "CHECK-NORMAL-PENALTY", "CHECK-REGRESSION"],
    risk_level: "low",
    policy_version: 1,
  };
}

async function initializedProject(): Promise<{
  projectRoot: string;
  repositoryPath: string;
  sessions: ChangeSessionService;
  authority: ApprovalAuthority;
  publications: PublicationService;
  history: HistoryService;
}> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, projectId);
  const projectRoot = path.join(data, projectId);
  return {
    projectRoot,
    repositoryPath: initialized.repositoryPath,
    sessions: new ChangeSessionService(projectRoot, projectId),
    authority: new ApprovalAuthority(projectRoot),
    publications: new PublicationService(projectRoot),
    history: new HistoryService(projectRoot, projectId),
  };
}

async function implementAndPublish(
  setup: Awaited<ReturnType<typeof initializedProject>>,
  changeId: string,
  plan: ChangePlan,
  key: string,
): Promise<string> {
  const executionReview = await setup.authority.prepareExecutionReview(changeId);
  const executionPending = await setup.authority.getOperatorReview(executionReview.review_id);
  await setup.authority.approveExecution(executionReview.review_id, executionPending.nonce, `execution-${key}`);
  const attempt = await setup.sessions.startExecution(changeId, `attempt-${key}`);
  const workspace = path.join(setup.projectRoot, "execution", attempt.attempt_id);
  for (const configChange of plan.allowed_config_changes) {
    const configPath = path.join(workspace, ...configChange.path.split("/"));
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      normal: { penalty_bps: number };
    };
    config.normal.penalty_bps = Number(configChange.after);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  const candidates = new CandidateService(setup.projectRoot);
  const snapshot = await candidates.freezeCandidate(changeId, attempt.attempt_id, `freeze-${key}`);
  await candidates.validateCandidate(changeId, snapshot.snapshot_id, `validate-${key}`);
  const bundle = await setup.publications.buildResultReview(changeId, `bundle-${key}`);
  const resultReview = await setup.authority.prepareResultReview(changeId, bundle.bundle_id);
  const resultPending = await setup.authority.getOperatorReview(resultReview.review_id);
  await setup.authority.approveResult(resultReview.review_id, resultPending.nonce, `result-${key}`);
  return (await setup.publications.commitChange(changeId, bundle.bundle_id, `commit-${key}`)).commit;
}

async function planAndPublish(
  setup: Awaited<ReturnType<typeof initializedProject>>,
  draft: ChangePlanDraft,
  key: string,
): Promise<{ changeId: string; plan: ChangePlan; commit: string }> {
  const begun = await setup.sessions.beginChange(draft.request, `begin-${key}`);
  const plan = await setup.sessions.revisePlan(begun.changeId, 0, draft, `plan-${key}`);
  const commit = await implementAndPublish(setup, begun.changeId, plan, key);
  return { changeId: begun.changeId, plan, commit };
}

test("history query reports current source, unknown rationale and immutable Rule versions", async () => {
  const setup = await initializedProject();
  const published = await planAndPublish(setup, updateDraft(1000, 500, "普通模式死亡损失改为 5%"), "first");
  const query = await setup.history.queryDesign("RULE-DEATH-NORMAL", "parameters.penalty_bps");
  assert.equal(query.formal_commit, published.commit);
  assert.equal(query.rule.version, 2);
  assert.equal(query.rule.parameters.penalty_bps, 500);
  assert.equal(query.implementation[0]?.status, "consistent");
  assert.equal(query.current_reason.status, "unknown");
  assert.equal(query.current_reason.change_id, published.changeId);
  assert.equal(query.current_reason.request, "普通模式死亡损失改为 5%");
  assert.deepEqual(query.history.map((entry) => entry.version), [2, 1]);
});

test("a compensation Change restores business state while preserving history", async () => {
  const setup = await initializedProject();
  const original = await planAndPublish(setup, updateDraft(1000, 500, "普通模式死亡损失改为 5%"), "first");
  const proposed = await setup.history.proposeRevert(original.changeId, `回退 ${original.changeId}`, "revert");
  assert.equal(proposed.plan.kind, "revert");
  assert.equal(proposed.plan.revert_of, original.changeId);
  assert.deepEqual(proposed.plan.allowed_config_changes[0], {
    path: "config/death-penalty.json",
    pointer: "/normal/penalty_bps",
    before: 500,
    after: 1000,
  });
  const revertCommit = await implementAndPublish(setup, proposed.change_id, proposed.plan, "revert");
  const reader = new GitTreeReader(process.cwd(), revertCommit, setup.repositoryPath);
  const config = JSON.parse(await reader.readText("config/death-penalty.json")) as {
    normal: { penalty_bps: number };
    hard: { penalty_bps: number };
  };
  assert.equal(config.normal.penalty_bps, 1000);
  assert.equal(config.hard.penalty_bps, 1000);
  const rule = parseFrontmatter(await reader.readText("design/rules/death-normal.md"), "rule");
  assert.equal(rule.version, 3);
  assert.equal((rule.parameters as Record<string, unknown>).penalty_bps, 1000);
  assert.equal(rule.last_change_id, proposed.change_id);
  assert.equal(parseFrontmatter(
    await reader.readText(`design/changes/${proposed.change_id}.md`),
    "revert",
  ).revert_of, original.changeId);
  assert.ok((await reader.listFiles()).some((file) => file.path === `design/changes/${original.changeId}.md`));
  assert.deepEqual((await setup.history.getHistory("RULE-DEATH-NORMAL")).map((entry) => entry.version), [3, 2, 1]);
  const query = await setup.history.queryDesign("RULE-DEATH-NORMAL", "parameters.penalty_bps");
  assert.equal(query.current_reason.status, "known");
  assert.equal(query.current_reason.change_reason, `回退 ${original.changeId}`);
  assert.equal(query.current_reason.decisions.length, 1);
  assert.equal(query.current_reason.decisions[0]?.rationale_source, "user_statement");
});

test("revert proposal rejects target fields changed by a later Change", async () => {
  const setup = await initializedProject();
  const original = await planAndPublish(setup, updateDraft(1000, 500, "普通模式死亡损失改为 5%"), "first");
  await planAndPublish(setup, updateDraft(500, 700, "普通模式死亡损失调整为 7%"), "second");
  await assert.rejects(
    setup.history.proposeRevert(original.changeId, `回退 ${original.changeId}`, "conflicting-revert"),
    (error) => error instanceof DesignTraceError && error.code === "REVERT_CONFLICT" &&
      Array.isArray(error.details.conflicts) && error.details.conflicts.length > 0,
  );
});
