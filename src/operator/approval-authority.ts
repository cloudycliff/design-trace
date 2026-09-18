import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, digestObject, sha256 } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { EventStore } from "../core/event-store.js";
import { withFileLock } from "../core/file-lock.js";
import { validateChangePlan, type ChangePlan } from "../domain/change-plan.js";
import type { ContextPackage } from "../domain/context-service.js";
import type { ReviewBundle } from "../domain/review-bundle.js";

export interface ExecutionReview {
  review_id: string;
  change_id: string;
  stage: "execution";
  subject_digest: string;
  plan_revision: number;
  request: string;
  goal: string;
  allowed_paths: string[];
  allowed_config_changes: ChangePlan["allowed_config_changes"];
  out_of_scope: string[];
  protected_checks: string[];
  acceptance_checks: string[];
  impacts: {
    definite: string[];
    possible: string[];
    coverage_gaps: ContextPackage["coverage_gaps"];
  };
  risk_level: string;
  created_at: string;
}

interface PendingExecutionReview extends ExecutionReview {
  nonce: string;
  consumed_at: string | null;
}

export interface ResultReview {
  review_id: string;
  change_id: string;
  stage: "result";
  subject_digest: string;
  bundle_id: string;
  payload_tree_oid: string;
  execution_tree_oid: string;
  validation_batch_id: string;
  validation_run_ids: string[];
  changed_paths: string[];
  changed_pointers: ReviewBundle["changed_pointers"];
  created_at: string;
}

interface PendingResultReview extends ResultReview {
  nonce: string;
  consumed_at: string | null;
}

export type PendingReview = PendingExecutionReview | PendingResultReview;

export interface ApprovalRecord {
  schema_version: 1;
  approval_id: string;
  change_id: string;
  stage: "execution" | "result";
  plan_revision: number;
  baseline_commit: string;
  subject_digest: string;
  bundle_id?: string;
  policy_version: number;
  actor: string;
  channel: "operator-ui";
  nonce: string;
  issued_at: string;
  expires_at: string;
  integrity_tag: string;
}

type UnsignedApproval = Omit<ApprovalRecord, "integrity_tag">;

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function replaceJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class ApprovalAuthority {
  readonly #sessionsRoot: string;
  readonly #operatorRoot: string;
  readonly #lockPath: string;

  constructor(private readonly projectRoot: string) {
    this.#sessionsRoot = path.join(projectRoot, "sessions");
    this.#operatorRoot = path.join(projectRoot, "operator");
    this.#lockPath = path.join(projectRoot, ".write.lock");
  }

  async prepareExecutionReview(changeId: string, now = new Date()): Promise<ExecutionReview> {
    this.assertChangeId(changeId);
    return withFileLock(this.#lockPath, async () => {
      const { session, plan, contextDigest, context, subjectDigest } = await this.currentExecutionSubject(changeId);
      if (session.state !== "awaiting_execution_approval") {
        throw new DesignTraceError("INVALID_STATE", `Change ${changeId} is ${session.state}, not awaiting approval`);
      }
      const reviewId = `REV-${subjectDigest.slice(0, 20).toUpperCase()}`;
      const reviewPath = this.reviewPath(reviewId);
      let pending: PendingExecutionReview;
      try {
        pending = JSON.parse(await readFile(reviewPath, "utf8")) as PendingExecutionReview;
        if (pending.subject_digest !== subjectDigest || pending.consumed_at) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Existing review does not match the current subject");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending = {
          review_id: reviewId,
          change_id: changeId,
          stage: "execution",
          subject_digest: subjectDigest,
          plan_revision: plan.plan_revision,
          request: plan.request,
          goal: plan.goal,
          allowed_paths: plan.allowed_paths,
          allowed_config_changes: plan.allowed_config_changes,
          out_of_scope: plan.out_of_scope,
          protected_checks: plan.protected_checks,
          acceptance_checks: plan.acceptance_checks,
          impacts: {
            definite: context.definite_impacts.map((impact) => impact.rule.id),
            possible: context.possible_impacts.map((impact) => impact.rule.id),
            coverage_gaps: context.coverage_gaps,
          },
          risk_level: plan.risk_level,
          nonce: randomBytes(32).toString("hex"),
          consumed_at: null,
          created_at: now.toISOString(),
        };
        await writeJsonExclusive(reviewPath, pending);
      }
      void contextDigest;
      return this.publicReview(pending);
    });
  }

  async prepareResultReview(changeId: string, bundleId: string, now = new Date()): Promise<ResultReview> {
    this.assertChangeId(changeId);
    this.assertBundleId(bundleId);
    return withFileLock(this.#lockPath, async () => {
      const { session, bundle } = await this.currentResultSubject(changeId, bundleId);
      if (session.state !== "awaiting_result_approval") {
        throw new DesignTraceError("INVALID_STATE", `Change ${changeId} is ${session.state}, not awaiting result approval`);
      }
      const reviewId = `REV-${bundle.review_digest.slice(0, 20).toUpperCase()}`;
      const reviewPath = this.reviewPath(reviewId);
      let pending: PendingResultReview;
      try {
        pending = JSON.parse(await readFile(reviewPath, "utf8")) as PendingResultReview;
        if (pending.subject_digest !== bundle.review_digest || pending.bundle_id !== bundleId || pending.consumed_at) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Existing result review does not match the active bundle");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pending = {
          review_id: reviewId,
          change_id: changeId,
          stage: "result",
          subject_digest: bundle.review_digest,
          bundle_id: bundleId,
          payload_tree_oid: bundle.payload_tree_oid,
          execution_tree_oid: bundle.execution_tree_oid,
          validation_batch_id: bundle.validation_batch_id,
          validation_run_ids: bundle.validation_run_ids,
          changed_paths: bundle.changed_paths,
          changed_pointers: bundle.changed_pointers,
          nonce: randomBytes(32).toString("hex"),
          consumed_at: null,
          created_at: now.toISOString(),
        };
        await writeJsonExclusive(reviewPath, pending);
      }
      return this.publicReview(pending);
    });
  }

  async getOperatorReview(reviewId: string): Promise<PendingReview> {
    this.assertReviewId(reviewId);
    return JSON.parse(await readFile(this.reviewPath(reviewId), "utf8")) as PendingReview;
  }

  async approveExecution(
    reviewId: string,
    nonce: string,
    operatorSessionId: string,
    now = new Date(),
  ): Promise<ApprovalRecord> {
    return withFileLock(this.#lockPath, async () => {
      this.assertReviewId(reviewId);
      const reviewPath = this.reviewPath(reviewId);
      const pending = JSON.parse(await readFile(reviewPath, "utf8")) as PendingExecutionReview;
      if (pending.stage !== "execution") throw new DesignTraceError("INVALID_STATE", "Review is not an execution review");
      if (pending.consumed_at) {
        throw new DesignTraceError("INVALID_STATE", "Review nonce has already been consumed");
      }
      if (!constantTimeEqual(pending.nonce, nonce)) {
        throw new DesignTraceError("APPROVAL_REQUIRED", "Review nonce is invalid");
      }
      const { session, plan, subjectDigest } = await this.currentExecutionSubject(pending.change_id);
      if (session.state !== "awaiting_execution_approval" || subjectDigest !== pending.subject_digest) {
        throw new DesignTraceError("STALE_PLAN", "Review no longer matches the active plan and context");
      }
      if (plan.risk_level === "high" || plan.risk_level === "unsupported") {
        throw new DesignTraceError("INVALID_STATE", `MVP cannot approve a ${plan.risk_level} execution plan`);
      }
      const secret = await this.secret();
      const unsigned: UnsignedApproval = {
        schema_version: 1,
        approval_id: `APR-${randomUUID().toUpperCase()}`,
        change_id: pending.change_id,
        stage: "execution",
        plan_revision: plan.plan_revision,
        baseline_commit: plan.baseline_commit,
        subject_digest: subjectDigest,
        policy_version: plan.policy_version,
        actor: `local-operator:${sha256(operatorSessionId).slice(0, 16)}`,
        channel: "operator-ui",
        nonce,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      const approval: ApprovalRecord = {
        ...unsigned,
        integrity_tag: createHmac("sha256", secret).update(canonicalJson(unsigned)).digest("hex"),
      };
      await writeJsonExclusive(this.approvalPath(pending.change_id, approval.approval_id), approval);
      const store = new EventStore(this.#sessionsRoot, pending.change_id);
      await store.recordApproval("execution", approval.approval_id, subjectDigest, now);
      await store.transition("ready_to_execute", "operator approved execution plan", now);
      await replaceJson(reviewPath, { ...pending, consumed_at: now.toISOString() });
      return approval;
    });
  }

  async approveResult(
    reviewId: string,
    nonce: string,
    operatorSessionId: string,
    now = new Date(),
  ): Promise<ApprovalRecord> {
    return withFileLock(this.#lockPath, async () => {
      this.assertReviewId(reviewId);
      const reviewPath = this.reviewPath(reviewId);
      const pending = JSON.parse(await readFile(reviewPath, "utf8")) as PendingResultReview;
      if (pending.stage !== "result") throw new DesignTraceError("INVALID_STATE", "Review is not a result review");
      if (pending.consumed_at) throw new DesignTraceError("INVALID_STATE", "Review nonce has already been consumed");
      if (!constantTimeEqual(pending.nonce, nonce)) {
        throw new DesignTraceError("APPROVAL_REQUIRED", "Review nonce is invalid");
      }
      const { session, bundle } = await this.currentResultSubject(pending.change_id, pending.bundle_id);
      if (session.state !== "awaiting_result_approval" || bundle.review_digest !== pending.subject_digest) {
        throw new DesignTraceError("STALE_PLAN", "Review no longer matches the active result bundle");
      }
      const secret = await this.secret();
      const unsigned: UnsignedApproval = {
        schema_version: 1,
        approval_id: `APR-${randomUUID().toUpperCase()}`,
        change_id: pending.change_id,
        stage: "result",
        plan_revision: bundle.plan_revision,
        baseline_commit: bundle.baseline_commit,
        subject_digest: bundle.review_digest,
        bundle_id: bundle.bundle_id,
        policy_version: bundle.policy_version,
        actor: `local-operator:${sha256(operatorSessionId).slice(0, 16)}`,
        channel: "operator-ui",
        nonce,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      const approval: ApprovalRecord = {
        ...unsigned,
        integrity_tag: createHmac("sha256", secret).update(canonicalJson(unsigned)).digest("hex"),
      };
      await writeJsonExclusive(this.approvalPath(pending.change_id, approval.approval_id), approval);
      const store = new EventStore(this.#sessionsRoot, pending.change_id);
      await store.recordApproval("result", approval.approval_id, bundle.review_digest, now);
      await store.transition("ready_to_commit", "operator approved result bundle", now);
      await replaceJson(reviewPath, { ...pending, consumed_at: now.toISOString() });
      return approval;
    });
  }

  async rejectReview(reviewId: string, nonce: string, now = new Date()): Promise<void> {
    return withFileLock(this.#lockPath, async () => {
      this.assertReviewId(reviewId);
      const reviewPath = this.reviewPath(reviewId);
      const pending = JSON.parse(await readFile(reviewPath, "utf8")) as PendingReview;
      if (pending.consumed_at) throw new DesignTraceError("INVALID_STATE", "Review nonce has already been consumed");
      if (!constantTimeEqual(pending.nonce, nonce)) {
        throw new DesignTraceError("APPROVAL_REQUIRED", "Review nonce is invalid");
      }
      const store = new EventStore(this.#sessionsRoot, pending.change_id);
      const session = await store.recover();
      const expectedState = pending.stage === "execution" ? "awaiting_execution_approval" : "awaiting_result_approval";
      if (session.state !== expectedState) {
        throw new DesignTraceError("INVALID_STATE", `Review no longer matches Change state ${session.state}`);
      }
      if (pending.stage === "execution") {
        const current = await this.currentExecutionSubject(pending.change_id);
        if (current.subjectDigest !== pending.subject_digest) {
          throw new DesignTraceError("STALE_PLAN", "Execution review no longer matches the active subject");
        }
      } else {
        const current = await this.currentResultSubject(pending.change_id, pending.bundle_id);
        if (current.bundle.review_digest !== pending.subject_digest) {
          throw new DesignTraceError("STALE_PLAN", "Result review no longer matches the active bundle");
        }
      }
      await store.transition("cancelled", `operator rejected ${pending.stage} review`, now);
      await replaceJson(reviewPath, { ...pending, consumed_at: now.toISOString() });
    });
  }

  async requireValidExecutionApproval(changeId: string, now = new Date()): Promise<ApprovalRecord> {
    this.assertChangeId(changeId);
    const store = new EventStore(this.#sessionsRoot, changeId);
    const session = await store.recover();
    if (!session.executionApprovalId) {
      throw new DesignTraceError("APPROVAL_REQUIRED", `Change ${changeId} has no execution approval`);
    }
    if (!/^APR-[A-F0-9-]{36}$/u.test(session.executionApprovalId)) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Session contains an invalid approval ID");
    }
    const approval = JSON.parse(
      await readFile(this.approvalPath(changeId, session.executionApprovalId), "utf8"),
    ) as ApprovalRecord;
    const { integrity_tag: integrityTag, ...unsigned } = approval;
    const expectedTag = createHmac("sha256", await this.secret())
      .update(canonicalJson(unsigned))
      .digest("hex");
    if (!constantTimeEqual(integrityTag, expectedTag)) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Approval integrity check failed");
    }
    const current = await this.currentExecutionSubject(changeId);
    if (
      approval.channel !== "operator-ui" ||
      approval.stage !== "execution" ||
      approval.subject_digest !== current.subjectDigest ||
      approval.plan_revision !== current.plan.plan_revision ||
      approval.baseline_commit !== current.plan.baseline_commit ||
      approval.policy_version !== current.plan.policy_version
    ) {
      throw new DesignTraceError("APPROVAL_REQUIRED", "Approval does not match the active execution subject");
    }
    if (Date.parse(approval.expires_at) <= now.getTime()) {
      throw new DesignTraceError("APPROVAL_EXPIRED", "Execution approval has expired");
    }
    return approval;
  }

  async requireValidResultApproval(
    changeId: string,
    bundleId: string,
    now = new Date(),
    allowExpired = false,
  ): Promise<ApprovalRecord> {
    this.assertChangeId(changeId);
    this.assertBundleId(bundleId);
    const { session, bundle } = await this.currentResultSubject(changeId, bundleId);
    if (!session.resultApprovalId || !/^APR-[A-F0-9-]{36}$/u.test(session.resultApprovalId)) {
      throw new DesignTraceError("APPROVAL_REQUIRED", `Change ${changeId} has no result approval for ${bundleId}`);
    }
    const approval = JSON.parse(
      await readFile(this.approvalPath(changeId, session.resultApprovalId), "utf8"),
    ) as ApprovalRecord;
    const { integrity_tag: integrityTag, ...unsigned } = approval;
    const expectedTag = createHmac("sha256", await this.secret()).update(canonicalJson(unsigned)).digest("hex");
    if (!constantTimeEqual(integrityTag, expectedTag)) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Approval integrity check failed");
    }
    if (
      approval.channel !== "operator-ui" ||
      approval.stage !== "result" ||
      approval.bundle_id !== bundle.bundle_id ||
      approval.subject_digest !== bundle.review_digest ||
      approval.plan_revision !== bundle.plan_revision ||
      approval.baseline_commit !== bundle.baseline_commit ||
      approval.policy_version !== bundle.policy_version
    ) {
      throw new DesignTraceError("APPROVAL_REQUIRED", "Approval does not match the active result bundle");
    }
    if (!allowExpired && Date.parse(approval.expires_at) <= now.getTime()) {
      throw new DesignTraceError("APPROVAL_EXPIRED", "Result approval has expired");
    }
    return approval;
  }

  private async currentExecutionSubject(changeId: string): Promise<{
    session: Awaited<ReturnType<EventStore["recover"]>>;
    plan: ChangePlan;
    contextDigest: string;
    context: ContextPackage;
    subjectDigest: string;
  }> {
    const store = new EventStore(this.#sessionsRoot, changeId);
    const session = await store.recover();
    if (session.planRevision < 1 || !session.planDigest) {
      throw new DesignTraceError("INVALID_STATE", `Change ${changeId} has no complete plan`);
    }
    const plan = JSON.parse(
      await readFile(path.join(this.#sessionsRoot, changeId, "plans", `${session.planRevision}.json`), "utf8"),
    ) as unknown;
    validateChangePlan(plan);
    if (digestObject(plan) !== session.planDigest) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Current plan differs from its event digest");
    }
    const context = JSON.parse(
      await readFile(path.join(this.#sessionsRoot, changeId, "contexts", `${plan.context_id}.json`), "utf8"),
    ) as ContextPackage;
    const { context_digest: contextDigest, ...unsignedContext } = context;
    if (
      typeof contextDigest !== "string" ||
      digestObject(unsignedContext) !== contextDigest ||
      plan.context_id !== `CTX-${contextDigest.slice(0, 16).toUpperCase()}`
    ) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Plan context does not match its identifier");
    }
    const subjectDigest = digestObject({
      stage: "execution",
      change_id: changeId,
      plan_revision: plan.plan_revision,
      baseline_commit: plan.baseline_commit,
      plan_digest: session.planDigest,
      context_digest: contextDigest,
      policy_version: plan.policy_version,
    });
    return { session, plan, contextDigest, context, subjectDigest };
  }

  private async currentResultSubject(changeId: string, bundleId: string): Promise<{
    session: Awaited<ReturnType<EventStore["recover"]>>;
    bundle: ReviewBundle;
  }> {
    const store = new EventStore(this.#sessionsRoot, changeId);
    const session = await store.recover();
    if (session.activeBundleId !== bundleId || session.activeReviewDigest === null) {
      throw new DesignTraceError("APPROVAL_REQUIRED", "Bundle is not the active result review subject");
    }
    const bundle = JSON.parse(
      await readFile(path.join(this.#sessionsRoot, changeId, "bundles", `${bundleId}.json`), "utf8"),
    ) as ReviewBundle;
    const { review_digest: reviewDigest, ...unsigned } = bundle;
    if (reviewDigest !== session.activeReviewDigest || digestObject(unsigned) !== reviewDigest) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Result review bundle failed its digest check");
    }
    return { session, bundle };
  }

  private publicReview<T extends PendingReview>(pending: T): Omit<T, "nonce" | "consumed_at"> {
    const { nonce: _nonce, consumed_at: _consumedAt, ...review } = pending;
    return review;
  }

  private reviewPath(reviewId: string): string {
    return path.join(this.#operatorRoot, "reviews", `${reviewId}.json`);
  }

  private approvalPath(changeId: string, approvalId: string): string {
    return path.join(this.#sessionsRoot, changeId, "approvals", `${approvalId}.json`);
  }

  private assertReviewId(reviewId: string): void {
    if (!/^REV-[A-F0-9]{20}$/u.test(reviewId)) {
      throw new DesignTraceError("INVALID_PROJECT", "Invalid review ID");
    }
  }

  private assertChangeId(changeId: string): void {
    if (!/^CHG-[A-Z0-9-]{1,64}$/u.test(changeId)) {
      throw new DesignTraceError("INVALID_PROJECT", "Invalid Change ID");
    }
  }

  private assertBundleId(bundleId: string): void {
    if (!/^BND-[A-F0-9]{20}$/u.test(bundleId)) {
      throw new DesignTraceError("INVALID_PROJECT", "Invalid bundle ID");
    }
  }

  private async secret(): Promise<Buffer> {
    const secretPath = path.join(this.#operatorRoot, "approval.key");
    await mkdir(this.#operatorRoot, { recursive: true });
    try {
      const secret = Buffer.from((await readFile(secretPath, "utf8")).trim(), "hex");
      if (secret.length !== 32) throw new DesignTraceError("INTEGRITY_ERROR", "Operator key is invalid");
      return secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const secret = randomBytes(32);
      try {
        await writeFile(secretPath, `${secret.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return secret;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        const recovered = Buffer.from((await readFile(secretPath, "utf8")).trim(), "hex");
        if (recovered.length !== 32) throw new DesignTraceError("INTEGRITY_ERROR", "Operator key is invalid");
        return recovered;
      }
    }
  }
}
