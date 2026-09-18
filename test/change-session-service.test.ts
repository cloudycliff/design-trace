import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { DesignTraceError } from "../src/core/errors.js";
import { FileLock } from "../src/core/file-lock.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import type { ChangePlanDraft } from "../src/domain/change-plan.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

const planDraft: ChangePlanDraft = {
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
  out_of_scope: ["困难模式参数与行为", "全局冷却、装备、复活道具和存档格式"],
  protected_checks: ["CHECK-HARD-UNCHANGED"],
  acceptance_checks: ["CHECK-CONFIG-SCHEMA", "CHECK-NORMAL-PENALTY", "CHECK-REGRESSION"],
  risk_level: "low",
  policy_version: 1,
};

async function initializedService(): Promise<{
  service: ChangeSessionService;
  projectRoot: string;
}> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  return {
    projectRoot,
    service: new ChangeSessionService(projectRoot, "death-penalty-fixture"),
  };
}

test("begin_change is idempotent and enforces one active Change", async () => {
  const { service } = await initializedService();
  const first = await service.beginChange(planDraft.request, "begin-key");
  const repeated = await service.beginChange(planDraft.request, "begin-key");
  assert.deepEqual(repeated, first);

  await assert.rejects(
    service.beginChange("another request", "begin-key"),
    (error) => error instanceof DesignTraceError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    service.beginChange("another request", "another-key"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_STATE",
  );
});

test("a valid plan revision is immutable and recoverable", async () => {
  const { service, projectRoot } = await initializedService();
  const begun = await service.beginChange(planDraft.request, "begin-key");
  const createdAt = new Date("2026-09-17T01:00:00Z");
  const plan = await service.revisePlan(begun.changeId, 0, planDraft, "plan-key", createdAt);
  assert.equal(plan.plan_revision, 1);
  assert.equal(plan.baseline_commit, begun.baselineCommit);

  const restarted = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  const status = await restarted.getStatus(begun.changeId);
  assert.equal(status.state, "awaiting_execution_approval");
  assert.equal(status.planRevision, 1);
  assert.ok(status.planDigest);

  const repeated = await restarted.revisePlan(
    begun.changeId,
    0,
    planDraft,
    "plan-key",
    new Date("2026-09-17T02:00:00Z"),
  );
  assert.deepEqual(repeated, plan);
});

test("stale revisions and unsafe paths are rejected without advancing the plan", async () => {
  const { service } = await initializedService();
  const begun = await service.beginChange(planDraft.request, "begin-key");
  await service.revisePlan(begun.changeId, 0, planDraft, "plan-key");
  await assert.rejects(
    service.revisePlan(begun.changeId, 0, { ...planDraft, goal: "changed" }, "stale-key"),
    (error) => error instanceof DesignTraceError && error.code === "STALE_PLAN",
  );

  const invalid = {
    ...planDraft,
    allowed_paths: ["../outside.json"],
    allowed_config_changes: [{ ...planDraft.allowed_config_changes[0]!, path: "../outside.json" }],
  };
  await assert.rejects(
    service.revisePlan(begun.changeId, 1, invalid, "invalid-key"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT",
  );
  assert.equal((await service.getStatus(begun.changeId)).planRevision, 1);
});

test("caller cannot override kernel-owned plan identity or baseline", async () => {
  const { service } = await initializedService();
  const begun = await service.beginChange(planDraft.request, "begin-key");
  const hostileDraft = {
    ...planDraft,
    id: "CHG-FORGED",
    baseline_commit: "0".repeat(40),
    plan_revision: 99,
    schema_version: 99,
    context_id: "CTX-FORGED",
  } as unknown as ChangePlanDraft;
  const plan = await service.revisePlan(begun.changeId, 0, hostileDraft, "plan-key");
  assert.equal(plan.id, begun.changeId);
  assert.equal(plan.baseline_commit, begun.baselineCommit);
  assert.equal(plan.plan_revision, 1);
  assert.equal(plan.schema_version, 1);
  assert.notEqual(plan.context_id, "CTX-FORGED");
});

test("project write lock rejects a concurrent writer", async () => {
  const { service, projectRoot } = await initializedService();
  const lock = await FileLock.acquire(path.join(projectRoot, ".write.lock"));
  try {
    await assert.rejects(
      service.beginChange(planDraft.request, "begin-key"),
      (error) => error instanceof DesignTraceError && error.code === "INVALID_STATE",
    );
  } finally {
    await lock.release();
  }
});

test("a lock left by a dead process is recovered without weakening active-owner checks", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const lockPath = path.join(data, "death-penalty-fixture", ".write.lock");
  await writeFile(lockPath, `${JSON.stringify({ token: "stale", pid: 2147483647, acquired_at: "2020-01-01T00:00:00Z" })}\n`);
  const recovered = await FileLock.acquire(lockPath);
  await recovered.release();
});
