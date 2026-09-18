import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DesignTraceError } from "../src/core/errors.js";
import { CandidateService } from "../src/domain/candidate-service.js";
import type { ChangePlanDraft } from "../src/domain/change-plan.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import { PublicationService } from "../src/domain/publication-service.js";
import { FormalRepository, GitTreeReader } from "../src/formal/formal-repository.js";
import { parseFrontmatter } from "../src/formal/frontmatter.js";
import { git } from "../src/git/git-client.js";
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
  allowed_config_changes: [{
    path: "config/death-penalty.json",
    pointer: "/normal/penalty_bps",
    before: 1000,
    after: 500,
  }],
  design_changes: [{ rule_id: "RULE-DEATH-NORMAL", fields: ["parameters.penalty_bps"] }],
  out_of_scope: ["困难模式参数与行为"],
  protected_checks: ["CHECK-HARD-UNCHANGED"],
  acceptance_checks: ["CHECK-CONFIG-SCHEMA", "CHECK-NORMAL-PENALTY", "CHECK-REGRESSION"],
  risk_level: "low",
  policy_version: 1,
};

async function validatedChange(): Promise<{
  projectRoot: string;
  repositoryPath: string;
  baseline: string;
  changeId: string;
  workspace: string;
  sessions: ChangeSessionService;
  authority: ApprovalAuthority;
  publications: PublicationService;
}> {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  const sessions = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  const begun = await sessions.beginChange(draft.request, "begin-key");
  await sessions.revisePlan(begun.changeId, 0, draft, "plan-key");
  const authority = new ApprovalAuthority(projectRoot);
  const executionReview = await authority.prepareExecutionReview(begun.changeId);
  const operatorReview = await authority.getOperatorReview(executionReview.review_id);
  await authority.approveExecution(executionReview.review_id, operatorReview.nonce, "execution-operator");
  const attempt = await sessions.startExecution(begun.changeId, "attempt-key");
  const workspace = path.join(projectRoot, "execution", attempt.attempt_id);
  const configPath = path.join(workspace, "config", "death-penalty.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    normal: { penalty_bps: number };
    hard: { penalty_bps: number };
  };
  config.normal.penalty_bps = 500;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const candidates = new CandidateService(projectRoot);
  const snapshot = await candidates.freezeCandidate(begun.changeId, attempt.attempt_id, "freeze-key");
  await candidates.validateCandidate(begun.changeId, snapshot.snapshot_id, "validate-key");
  return {
    projectRoot,
    repositoryPath: initialized.repositoryPath,
    baseline: initialized.formalCommit,
    changeId: begun.changeId,
    workspace,
    sessions,
    authority,
    publications: new PublicationService(projectRoot),
  };
}

async function approveResult(
  authority: ApprovalAuthority,
  changeId: string,
  bundleId: string,
): Promise<void> {
  const review = await authority.prepareResultReview(changeId, bundleId);
  const pending = await authority.getOperatorReview(review.review_id);
  await authority.approveResult(review.review_id, pending.nonce, "result-operator");
}

test("formal publication requires a result approval bound to the review bundle", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(
    setup.changeId,
    "bundle-key",
    new Date(Date.now() + 48 * 60 * 60 * 1000),
  );
  await assert.rejects(
    setup.publications.commitChange(setup.changeId, bundle.bundle_id, "commit-key"),
    (error) => error instanceof DesignTraceError && error.code === "APPROVAL_REQUIRED",
  );
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), setup.baseline);
});

test("result review rejects validation evidence from a different environment", async () => {
  const setup = await validatedChange();
  const status = await setup.sessions.getStatus(setup.changeId);
  assert.ok(status.validationBatchId);
  const batchPath = path.join(setup.projectRoot, "validation", status.validationBatchId, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8")) as {
    runs: Array<{ environment_digest: string }>;
  };
  batch.runs[0]!.environment_digest = "0".repeat(64);
  await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`);
  await assert.rejects(
    setup.publications.buildResultReview(setup.changeId, "tampered-environment"),
    (error) => error instanceof DesignTraceError && error.code === "VALIDATION_FAILED",
  );
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "awaiting_result_approval");
});

test("result review uses the protected loopback channel and cannot approve another bundle", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  assert.match(bundle.attempt_id, /^ATT-/u);
  const review = await setup.authority.prepareResultReview(setup.changeId, bundle.bundle_id);
  const server = new OperatorServer(setup.authority);
  const origin = await server.start();
  try {
    const page = await fetch(`${origin}/review/result/${review.review_id}`);
    assert.equal(page.status, 200);
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
    const html = await page.text();
    const csrf = /name="csrf_token" value="([a-f0-9]{64})"/u.exec(html)?.[1];
    const nonce = /name="nonce" value="([a-f0-9]{64})"/u.exec(html)?.[1];
    assert.ok(cookie && csrf && nonce);
    assert.match(html, /Approve result bundle/u);

    const denied = await fetch(`${origin}/review/result/${review.review_id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, nonce }),
    });
    assert.equal(denied.status, 403);

    const approved = await fetch(`${origin}/review/result/${review.review_id}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, nonce }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "ready_to_commit");
    await assert.rejects(
      setup.authority.requireValidResultApproval(setup.changeId, "BND-AAAAAAAAAAAAAAAAAAAA"),
      (error) => error instanceof DesignTraceError && error.code === "APPROVAL_REQUIRED",
    );
  } finally {
    await server.close();
  }
});

test("approved frozen payload publishes config, Rule and immutable records atomically", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  const mutableConfigPath = path.join(setup.workspace, "config", "death-penalty.json");
  const mutableConfig = JSON.parse(await readFile(mutableConfigPath, "utf8")) as {
    normal: { penalty_bps: number };
  };
  mutableConfig.normal.penalty_bps = 700;
  await writeFile(mutableConfigPath, `${JSON.stringify(mutableConfig, null, 2)}\n`);
  await approveResult(setup.authority, setup.changeId, bundle.bundle_id);
  const result = await setup.publications.commitChange(setup.changeId, bundle.bundle_id, "commit-key");
  const repeated = await setup.publications.commitChange(setup.changeId, bundle.bundle_id, "commit-key");
  assert.deepEqual(repeated, result);
  assert.equal(await git(process.cwd(), ["rev-parse", `${result.commit}^`], { gitDir: setup.repositoryPath }), setup.baseline);
  const reader = new GitTreeReader(process.cwd(), result.commit, setup.repositoryPath);
  const config = JSON.parse(await reader.readText("config/death-penalty.json")) as {
    normal: { penalty_bps: number };
    hard: { penalty_bps: number };
  };
  assert.equal(config.normal.penalty_bps, 500);
  assert.equal(config.hard.penalty_bps, 1000);
  const rule = parseFrontmatter(await reader.readText("design/rules/death-normal.md"), "rule");
  assert.equal(rule.version, 2);
  assert.equal((rule.parameters as Record<string, unknown>).penalty_bps, 500);
  assert.equal(rule.last_change_id, setup.changeId);
  assert.match(await reader.readText(`design/receipts/${bundle.bundle_id}.json`), new RegExp(bundle.review_digest, "u"));
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "applied");
});

test("Git CAS rejects a moved formal baseline without overwriting it", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  await approveResult(setup.authority, setup.changeId, bundle.bundle_id);
  await git(process.cwd(), ["update-ref", "refs/heads/dt-main", bundle.payload_commit, setup.baseline], {
    gitDir: setup.repositoryPath,
  });
  await assert.rejects(
    setup.publications.commitChange(setup.changeId, bundle.bundle_id, "commit-key"),
    (error) => error instanceof DesignTraceError && error.code === "STALE_BASELINE",
  );
  assert.equal(await new FormalRepository(setup.repositoryPath).rawCurrentCommit(), bundle.payload_commit);
  await assert.rejects(
    new FormalRepository(setup.repositoryPath).currentCommit(),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );
});

test("response loss after CAS recovers the one prepared official commit", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  await approveResult(setup.authority, setup.changeId, bundle.bundle_id);
  const publicationTime = new Date();
  await assert.rejects(
    setup.publications.commitChange(
      setup.changeId,
      bundle.bundle_id,
      "commit-key",
      publicationTime,
      { afterCas: () => { throw new Error("simulated response loss"); } },
    ),
    /simulated response loss/u,
  );
  const interrupted = await setup.sessions.getStatus(setup.changeId);
  assert.equal(interrupted.state, "committing");
  assert.ok(interrupted.preparedCommit);
  assert.equal(await new FormalRepository(setup.repositoryPath).rawCurrentCommit(), interrupted.preparedCommit);
  await assert.rejects(
    new FormalRepository(setup.repositoryPath).currentCommit(),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );
  const recovered = await setup.publications.commitChange(
    setup.changeId,
    bundle.bundle_id,
    "commit-key",
    new Date(publicationTime.getTime() + 48 * 60 * 60 * 1000),
  );
  assert.equal(recovered.commit, interrupted.preparedCommit);
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), recovered.commit);
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "applied");
});

test("interruption before final commit creation resumes from committing", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  await approveResult(setup.authority, setup.changeId, bundle.bundle_id);
  const publicationTime = new Date();
  await assert.rejects(
    setup.publications.commitChange(
      setup.changeId,
      bundle.bundle_id,
      "commit-key",
      publicationTime,
      { beforePrepareCommit: () => { throw new Error("simulated interruption before commit creation"); } },
    ),
    /before commit creation/u,
  );
  const interrupted = await setup.sessions.getStatus(setup.changeId);
  assert.equal(interrupted.state, "committing");
  assert.equal(interrupted.preparedCommit, null);
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), setup.baseline);

  const recovered = await setup.publications.commitChange(
    setup.changeId,
    bundle.bundle_id,
    "commit-key",
    new Date(publicationTime.getTime() + 48 * 60 * 60 * 1000),
  );
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), recovered.commit);
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "applied");
});

test("interruption after final commit preparation resumes before CAS without duplicating publication", async () => {
  const setup = await validatedChange();
  const bundle = await setup.publications.buildResultReview(setup.changeId, "bundle-key");
  await approveResult(setup.authority, setup.changeId, bundle.bundle_id);
  const publicationTime = new Date();
  await assert.rejects(
    setup.publications.commitChange(
      setup.changeId,
      bundle.bundle_id,
      "commit-key",
      publicationTime,
      { afterCommitPrepared: () => { throw new Error("simulated interruption before CAS"); } },
    ),
    /before CAS/u,
  );
  const interrupted = await setup.sessions.getStatus(setup.changeId);
  assert.equal(interrupted.state, "committing");
  assert.ok(interrupted.preparedCommit);
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), setup.baseline);

  const recovered = await setup.publications.commitChange(
    setup.changeId,
    bundle.bundle_id,
    "commit-key",
    new Date(publicationTime.getTime() + 48 * 60 * 60 * 1000),
  );
  assert.equal(recovered.commit, interrupted.preparedCommit);
  assert.equal(await new FormalRepository(setup.repositoryPath).currentCommit(), recovered.commit);
  assert.equal((await setup.sessions.getStatus(setup.changeId)).state, "applied");
});
