import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DesignTraceError } from "../src/core/errors.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import type { ChangePlanDraft } from "../src/domain/change-plan.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { ApprovalAuthority } from "../src/operator/approval-authority.js";
import { OperatorServer } from "../src/operator/operator-server.js";
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

async function plannedChange(): Promise<{
  projectRoot: string;
  service: ChangeSessionService;
  authority: ApprovalAuthority;
  changeId: string;
}> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  const service = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  const begun = await service.beginChange(draft.request, "begin-key");
  await service.revisePlan(begun.changeId, 0, draft, "plan-key");
  return {
    projectRoot,
    service,
    authority: new ApprovalAuthority(projectRoot),
    changeId: begun.changeId,
  };
}

test("execution cannot start without a valid operator approval", async () => {
  const { service, changeId } = await plannedChange();
  await assert.rejects(
    service.startExecution(changeId, "attempt-key"),
    (error) => error instanceof DesignTraceError && error.code === "APPROVAL_REQUIRED",
  );
  assert.equal((await service.getStatus(changeId)).state, "awaiting_execution_approval");
});

test("operator approval is bound to plan/context and authorizes one recoverable start", async () => {
  const { service, authority, changeId } = await plannedChange();
  const publicReview = await authority.prepareExecutionReview(changeId);
  assert.equal("nonce" in publicReview, false);
  const operatorReview = await authority.getOperatorReview(publicReview.review_id);
  const approval = await authority.approveExecution(
    publicReview.review_id,
    operatorReview.nonce,
    "operator-session",
    new Date("2026-09-17T03:00:00Z"),
  );
  assert.equal(approval.channel, "operator-ui");
  assert.equal((await service.getStatus(changeId)).state, "ready_to_execute");

  const attempt = await service.startExecution(
    changeId,
    "attempt-key",
    new Date("2026-09-17T04:00:00Z"),
  );
  const repeated = await service.startExecution(
    changeId,
    "attempt-key",
    new Date("2026-09-17T05:00:00Z"),
  );
  assert.deepEqual(repeated, attempt);
  assert.equal((await service.getStatus(changeId)).state, "executing");
});

test("tampered and expired approvals are rejected", async () => {
  const { projectRoot, authority, changeId } = await plannedChange();
  const review = await authority.prepareExecutionReview(changeId);
  const operatorReview = await authority.getOperatorReview(review.review_id);
  const approval = await authority.approveExecution(
    review.review_id,
    operatorReview.nonce,
    "operator-session",
    new Date("2026-09-17T00:00:00Z"),
  );
  await assert.rejects(
    authority.requireValidExecutionApproval(changeId, new Date("2026-09-18T00:00:01Z")),
    (error) => error instanceof DesignTraceError && error.code === "APPROVAL_EXPIRED",
  );

  const approvalPath = path.join(
    projectRoot,
    "sessions",
    changeId,
    "approvals",
    `${approval.approval_id}.json`,
  );
  const contents = await readFile(approvalPath, "utf8");
  await writeFile(approvalPath, contents.replace('"policy_version": 1', '"policy_version": 2'));
  await assert.rejects(
    authority.requireValidExecutionApproval(changeId, new Date("2026-09-17T01:00:00Z")),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );
});

test("revising an approved plan invalidates the old approval", async () => {
  const { service, authority, changeId } = await plannedChange();
  const review = await authority.prepareExecutionReview(changeId);
  const operatorReview = await authority.getOperatorReview(review.review_id);
  await authority.approveExecution(review.review_id, operatorReview.nonce, "operator-session");

  await service.revisePlan(
    changeId,
    1,
    { ...draft, goal: "普通模式采用 5% 扣金规则，并重新确认困难模式不变" },
    "revised-plan-key",
  );
  const status = await service.getStatus(changeId);
  assert.equal(status.state, "awaiting_execution_approval");
  assert.equal(status.planRevision, 2);
  assert.equal(status.executionApprovalId, null);
  await assert.rejects(
    service.startExecution(changeId, "attempt-key"),
    (error) => error instanceof DesignTraceError && error.code === "APPROVAL_REQUIRED",
  );
});

test("loopback review page enforces cookie, Origin, CSRF and one-time nonce", async () => {
  const { service, authority, changeId } = await plannedChange();
  const review = await authority.prepareExecutionReview(changeId);
  const server = new OperatorServer(authority);
  const origin = await server.start();
  try {
    const pageResponse = await fetch(`${origin}/review/execution/${review.review_id}`);
    assert.equal(pageResponse.status, 200);
    const cookie = pageResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const html = await pageResponse.text();
    const csrf = /name="csrf_token" value="([a-f0-9]{64})"/u.exec(html)?.[1];
    const nonce = /name="nonce" value="([a-f0-9]{64})"/u.exec(html)?.[1];
    assert.ok(csrf);
    assert.ok(nonce);

    const denied = await fetch(`${origin}/review/execution/${review.review_id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, nonce }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await service.getStatus(changeId)).state, "awaiting_execution_approval");

    const approved = await fetch(`${origin}/review/execution/${review.review_id}`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf, nonce }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await service.getStatus(changeId)).state, "ready_to_execute");

    const replay = await fetch(`${origin}/review/execution/${review.review_id}`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf, nonce }),
    });
    assert.equal(replay.status, 403);
  } finally {
    await server.close();
  }
});
