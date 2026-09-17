import { open, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { digestObject } from "./digest.js";
import { DesignTraceError } from "./errors.js";
import { assertTransition, type ChangeState } from "./state-machine.js";

export interface SessionEvent {
  sequence: number;
  type:
    | "change_started"
    | "plan_revised"
    | "approval_issued"
    | "execution_started"
    | "candidate_frozen"
    | "validation_completed"
    | "bundle_built"
    | "commit_prepared"
    | "change_applied"
    | "state_changed"
    | "operation_completed";
  occurred_at: string;
  data: Record<string, unknown>;
  previous_digest: string | null;
  digest: string;
}

export interface RecoveredSession {
  changeId: string;
  state: ChangeState;
  planRevision: number;
  planDigest: string | null;
  planRequestDigest: string | null;
  executionApprovalId: string | null;
  resultApprovalId: string | null;
  attemptCount: number;
  activeAttemptId: string | null;
  activeSnapshotId: string | null;
  activeSnapshotCommit: string | null;
  validationBatchId: string | null;
  activeBundleId: string | null;
  activePayloadCommit: string | null;
  activePayloadTreeOid: string | null;
  activeReviewDigest: string | null;
  preparedCommit: string | null;
  appliedCommit: string | null;
  events: SessionEvent[];
}

type UnsignedEvent = Omit<SessionEvent, "digest">;

function eventDigest(event: UnsignedEvent): string {
  return digestObject(event);
}

export class EventStore {
  readonly #eventsPath: string;

  constructor(
    private readonly sessionsRoot: string,
    private readonly changeId: string,
  ) {
    this.#eventsPath = path.join(sessionsRoot, changeId, "events.jsonl");
  }

  async start(metadata: Record<string, unknown> = {}, at = new Date()): Promise<RecoveredSession> {
    const existing = await this.readEvents();
    if (existing.length > 0) {
      return this.recoverFrom(existing);
    }
    await this.append("change_started", { change_id: this.changeId, state: "draft", ...metadata }, at);
    return this.recover();
  }

  async recordPlanRevision(
    revision: number,
    planDigest: string,
    requestDigest: string,
    at = new Date(),
  ): Promise<void> {
    const current = await this.recover();
    if (revision !== current.planRevision + 1) {
      throw new DesignTraceError(
        "INVALID_STATE",
        `Expected plan revision ${current.planRevision + 1}, received ${revision}`,
      );
    }
    await this.append(
      "plan_revised",
      { plan_revision: revision, plan_digest: planDigest, request_digest: requestDigest },
      at,
    );
  }

  async recordApproval(
    stage: "execution" | "result",
    approvalId: string,
    subjectDigest: string,
    at = new Date(),
  ): Promise<void> {
    const current = await this.recover();
    if (current.events.some((event) => event.type === "approval_issued" && event.data.approval_id === approvalId)) {
      return;
    }
    await this.append(
      "approval_issued",
      { stage, approval_id: approvalId, subject_digest: subjectDigest },
      at,
    );
  }

  async recordExecutionStarted(attemptId: string, approvalId: string, at = new Date()): Promise<void> {
    const current = await this.recover();
    if (current.events.some((event) => event.type === "execution_started" && event.data.attempt_id === attemptId)) {
      return;
    }
    await this.append(
      "execution_started",
      { attempt_id: attemptId, approval_id: approvalId, attempt_number: current.attemptCount + 1 },
      at,
    );
  }

  async recordCandidateFrozen(
    snapshotId: string,
    attemptId: string,
    snapshotCommit: string,
    treeOid: string,
    at = new Date(),
  ): Promise<void> {
    const current = await this.recover();
    if (current.events.some((event) => event.type === "candidate_frozen" && event.data.snapshot_id === snapshotId)) {
      return;
    }
    await this.append(
      "candidate_frozen",
      {
        snapshot_id: snapshotId,
        attempt_id: attemptId,
        snapshot_commit: snapshotCommit,
        execution_tree_oid: treeOid,
      },
      at,
    );
  }

  async recordValidationCompleted(
    snapshotId: string,
    batchId: string,
    passed: boolean,
    at = new Date(),
  ): Promise<void> {
    await this.append(
      "validation_completed",
      { snapshot_id: snapshotId, batch_id: batchId, all_required_passed: passed },
      at,
    );
  }

  async recordBundleBuilt(
    bundleId: string,
    payloadCommit: string,
    payloadTreeOid: string,
    reviewDigest: string,
    at = new Date(),
  ): Promise<void> {
    const current = await this.recover();
    if (current.events.some((event) => event.type === "bundle_built" && event.data.bundle_id === bundleId)) return;
    await this.append(
      "bundle_built",
      {
        bundle_id: bundleId,
        payload_commit: payloadCommit,
        payload_tree_oid: payloadTreeOid,
        review_digest: reviewDigest,
      },
      at,
    );
  }

  async recordCommitPrepared(
    bundleId: string,
    candidateCommit: string,
    baselineCommit: string,
    idempotencyKey: string,
    requestDigest: string,
    at = new Date(),
  ): Promise<void> {
    const current = await this.recover();
    const prior = current.events.find((event) => event.type === "commit_prepared");
    if (prior) {
      if (
        prior.data.bundle_id !== bundleId ||
        prior.data.candidate_commit !== candidateCommit ||
        prior.data.baseline_commit !== baselineCommit ||
        prior.data.idempotency_key !== idempotencyKey ||
        prior.data.request_digest !== requestDigest
      ) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Prepared commit record conflicts with the active publication");
      }
      return;
    }
    await this.append(
      "commit_prepared",
      {
        bundle_id: bundleId,
        candidate_commit: candidateCommit,
        baseline_commit: baselineCommit,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
      },
      at,
    );
  }

  async recordChangeApplied(bundleId: string, commit: string, at = new Date()): Promise<void> {
    const current = await this.recover();
    const prior = current.events.find((event) => event.type === "change_applied");
    if (prior) {
      if (prior.data.bundle_id !== bundleId || prior.data.commit !== commit) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Applied event conflicts with the formal reference");
      }
      return;
    }
    await this.append("change_applied", { bundle_id: bundleId, commit }, at);
  }

  async transition(to: ChangeState, reason: string, at = new Date()): Promise<RecoveredSession> {
    const current = await this.recover();
    assertTransition(current.state, to);
    await this.append(
      "state_changed",
      { from: current.state, to, reason },
      at,
    );
    return this.recover();
  }

  async recordOperation(
    operation: string,
    idempotencyKey: string,
    requestDigest: string,
    result: unknown,
    at = new Date(),
  ): Promise<void> {
    const session = await this.recover();
    const prior = session.events.find(
      (event) =>
        event.type === "operation_completed" &&
        event.data.operation === operation &&
        event.data.idempotency_key === idempotencyKey,
    );
    if (prior) {
      if (prior.data.request_digest !== requestDigest) {
        throw new DesignTraceError(
          "IDEMPOTENCY_CONFLICT",
          `Idempotency key ${idempotencyKey} was already used with another request`,
          { operation, idempotencyKey },
        );
      }
      return;
    }
    await this.append(
      "operation_completed",
      {
        operation,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
        result,
      },
      at,
    );
  }

  async findOperation(operation: string, idempotencyKey: string, requestDigest: string): Promise<unknown | undefined> {
    const session = await this.recover();
    const prior = session.events.find(
      (event) =>
        event.type === "operation_completed" &&
        event.data.operation === operation &&
        event.data.idempotency_key === idempotencyKey,
    );
    if (!prior) return undefined;
    if (prior.data.request_digest !== requestDigest) {
      throw new DesignTraceError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency key ${idempotencyKey} was already used with another request`,
        { operation, idempotencyKey },
      );
    }
    return prior.data.result;
  }

  async recover(): Promise<RecoveredSession> {
    return this.recoverFrom(await this.readEvents());
  }

  private recoverFrom(events: SessionEvent[]): RecoveredSession {
    if (events.length === 0) {
      throw new DesignTraceError("INTEGRITY_ERROR", `Session ${this.changeId} has no start event`);
    }

    let previousDigest: string | null = null;
    let state: ChangeState = "draft";
    let planRevision = 0;
    let planDigest: string | null = null;
    let planRequestDigest: string | null = null;
    let executionApprovalId: string | null = null;
    let resultApprovalId: string | null = null;
    let attemptCount = 0;
    let activeAttemptId: string | null = null;
    let activeSnapshotId: string | null = null;
    let activeSnapshotCommit: string | null = null;
    let validationBatchId: string | null = null;
    let activeBundleId: string | null = null;
    let activePayloadCommit: string | null = null;
    let activePayloadTreeOid: string | null = null;
    let activeReviewDigest: string | null = null;
    let preparedCommit: string | null = null;
    let appliedCommit: string | null = null;
    for (const [index, event] of events.entries()) {
      const { digest, ...unsigned } = event;
      if (
        event.sequence !== index + 1 ||
        event.previous_digest !== previousDigest ||
        eventDigest(unsigned) !== digest
      ) {
        throw new DesignTraceError("INTEGRITY_ERROR", `Session event ${index + 1} failed integrity validation`);
      }
      if (index === 0) {
        if (event.type !== "change_started" || event.data.change_id !== this.changeId) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Session does not start with the expected Change");
        }
      } else if (event.type === "plan_revised") {
        const revision = event.data.plan_revision;
        const digest = event.data.plan_digest;
        const requestDigest = event.data.request_digest;
        if (
          revision !== planRevision + 1 ||
          typeof digest !== "string" ||
          typeof requestDigest !== "string"
        ) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Plan revision event is not sequential");
        }
        planRevision = revision;
        planDigest = digest;
        planRequestDigest = requestDigest;
        executionApprovalId = null;
        resultApprovalId = null;
        attemptCount = 0;
        activeAttemptId = null;
        activeSnapshotId = null;
        activeSnapshotCommit = null;
        validationBatchId = null;
        activeBundleId = null;
        activePayloadCommit = null;
        activePayloadTreeOid = null;
        activeReviewDigest = null;
        preparedCommit = null;
        appliedCommit = null;
      } else if (event.type === "approval_issued") {
        if (event.data.stage === "execution" && typeof event.data.approval_id === "string") {
          executionApprovalId = event.data.approval_id;
        } else if (event.data.stage === "result" && typeof event.data.approval_id === "string") {
          resultApprovalId = event.data.approval_id;
        }
      } else if (event.type === "execution_started") {
        if (typeof event.data.attempt_id !== "string") {
          throw new DesignTraceError("INTEGRITY_ERROR", "Execution event has no attempt ID");
        }
        attemptCount += 1;
        activeAttemptId = event.data.attempt_id;
        activeSnapshotId = null;
        activeSnapshotCommit = null;
        validationBatchId = null;
        activeBundleId = null;
        activePayloadCommit = null;
        activePayloadTreeOid = null;
        activeReviewDigest = null;
        resultApprovalId = null;
        preparedCommit = null;
      } else if (event.type === "candidate_frozen") {
        if (
          typeof event.data.snapshot_id !== "string" ||
          typeof event.data.snapshot_commit !== "string"
        ) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Candidate event is incomplete");
        }
        activeSnapshotId = event.data.snapshot_id;
        activeSnapshotCommit = event.data.snapshot_commit;
        validationBatchId = null;
      } else if (event.type === "validation_completed") {
        if (event.data.snapshot_id !== activeSnapshotId || typeof event.data.batch_id !== "string") {
          throw new DesignTraceError("INTEGRITY_ERROR", "Validation event does not match the active snapshot");
        }
        validationBatchId = event.data.batch_id;
      } else if (event.type === "bundle_built") {
        if (
          typeof event.data.bundle_id !== "string" ||
          typeof event.data.payload_commit !== "string" ||
          typeof event.data.payload_tree_oid !== "string" ||
          typeof event.data.review_digest !== "string"
        ) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Bundle event is incomplete");
        }
        activeBundleId = event.data.bundle_id;
        activePayloadCommit = event.data.payload_commit;
        activePayloadTreeOid = event.data.payload_tree_oid;
        activeReviewDigest = event.data.review_digest;
        resultApprovalId = null;
        preparedCommit = null;
      } else if (event.type === "commit_prepared") {
        if (event.data.bundle_id !== activeBundleId || typeof event.data.candidate_commit !== "string") {
          throw new DesignTraceError("INTEGRITY_ERROR", "Prepared commit does not match the active bundle");
        }
        preparedCommit = event.data.candidate_commit;
      } else if (event.type === "change_applied") {
        if (event.data.bundle_id !== activeBundleId || event.data.commit !== preparedCommit) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Applied commit does not match the prepared publication");
        }
        appliedCommit = String(event.data.commit);
      } else if (event.type === "state_changed") {
        const from = event.data.from as ChangeState;
        const to = event.data.to as ChangeState;
        if (from !== state) {
          throw new DesignTraceError("INTEGRITY_ERROR", "State event does not continue from the recovered state");
        }
        assertTransition(from, to);
        state = to;
      }
      previousDigest = digest;
    }
    return {
      changeId: this.changeId,
      state,
      planRevision,
      planDigest,
      planRequestDigest,
      executionApprovalId,
      resultApprovalId,
      attemptCount,
      activeAttemptId,
      activeSnapshotId,
      activeSnapshotCommit,
      validationBatchId,
      activeBundleId,
      activePayloadCommit,
      activePayloadTreeOid,
      activeReviewDigest,
      preparedCommit,
      appliedCommit,
      events,
    };
  }

  private async readEvents(): Promise<SessionEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.#eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return contents
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  }

  private async append(type: SessionEvent["type"], data: Record<string, unknown>, at: Date): Promise<void> {
    const existing = await this.readEvents();
    const unsigned: UnsignedEvent = {
      sequence: existing.length + 1,
      type,
      occurred_at: at.toISOString(),
      data,
      previous_digest: existing.at(-1)?.digest ?? null,
    };
    const event: SessionEvent = { ...unsigned, digest: eventDigest(unsigned) };
    await mkdir(path.dirname(this.#eventsPath), { recursive: true });
    const file = await open(this.#eventsPath, "a");
    try {
      await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
