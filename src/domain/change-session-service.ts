import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digestObject } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { EventStore, type RecoveredSession } from "../core/event-store.js";
import { withFileLock } from "../core/file-lock.js";
import { FormalRepository } from "../formal/formal-repository.js";
import { buildContext } from "./context-service.js";
import { ApprovalAuthority } from "../operator/approval-authority.js";
import { git } from "../git/git-client.js";
import {
  validateChangePlan,
  type ChangePlan,
  type ChangePlanDraft,
} from "./change-plan.js";

export interface BegunChange {
  changeId: string;
  baselineCommit: string;
  state: "draft";
}

export interface ExecutionAttempt {
  attempt_id: string;
  change_id: string;
  plan_revision: number;
  plan_approval_id: string;
  baseline_commit: string;
  workspace_id: string;
  attempt_number: number;
  status: "started";
  started_at: string;
}

const terminalStates = new Set(["applied", "cancelled"]);

function assertChangeId(changeId: string): void {
  if (!/^CHG-[A-Z0-9-]{1,64}$/u.test(changeId)) {
    throw new DesignTraceError("INVALID_PROJECT", "Invalid Change ID");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class ChangeSessionService {
  readonly #sessionsRoot: string;
  readonly #lockPath: string;
  readonly #formalRepository: FormalRepository;

  constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
  ) {
    this.#sessionsRoot = path.join(projectRoot, "sessions");
    this.#lockPath = path.join(projectRoot, ".write.lock");
    this.#formalRepository = new FormalRepository(path.join(projectRoot, "repository.git"));
  }

  async beginChange(request: string, idempotencyKey: string): Promise<BegunChange> {
    if (!request.trim() || !idempotencyKey.trim()) {
      throw new DesignTraceError("INVALID_PROJECT", "Request and idempotency key are required");
    }
    return withFileLock(this.#lockPath, async () => {
      await mkdir(this.#sessionsRoot, { recursive: true });
      const requestDigest = digestObject({ project_id: this.projectId, request });
      const changeId = `CHG-${digestObject({ project_id: this.projectId, idempotency_key: idempotencyKey })
        .slice(0, 16)
        .toUpperCase()}`;
      const store = new EventStore(this.#sessionsRoot, changeId);
      const eventPath = path.join(this.#sessionsRoot, changeId, "events.jsonl");
      if (await exists(eventPath)) {
        const recovered = await store.recover();
        const first = recovered.events[0]!;
        if (first.data.request_digest !== requestDigest) {
          throw new DesignTraceError(
            "IDEMPOTENCY_CONFLICT",
            `Idempotency key ${idempotencyKey} was already used for another begin_change request`,
          );
        }
        return {
          changeId,
          baselineCommit: String(first.data.baseline_commit),
          state: "draft",
        };
      }

      for (const entry of await readdir(this.#sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const current = await new EventStore(this.#sessionsRoot, entry.name).recover();
        if (!terminalStates.has(current.state)) {
          throw new DesignTraceError(
            "INVALID_STATE",
            `Project ${this.projectId} already has active Change ${entry.name}`,
            { activeChangeId: entry.name, state: current.state },
          );
        }
      }

      const baselineCommit = await this.#formalRepository.currentCommit();
      await store.start({
        project_id: this.projectId,
        request,
        request_digest: requestDigest,
        begin_idempotency_key: idempotencyKey,
        baseline_commit: baselineCommit,
      });
      return { changeId, baselineCommit, state: "draft" };
    });
  }

  async revisePlan(
    changeId: string,
    expectedPlanRevision: number,
    draft: ChangePlanDraft,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ChangePlan> {
    assertChangeId(changeId);
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      let session = await store.recover();
      const first = session.events[0]!;
      const revision = expectedPlanRevision + 1;
      const requestDigest = digestObject({ expectedPlanRevision, draft });
      const prior = await store.findOperation("revise_plan", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as ChangePlan;

      const plansDirectory = path.join(this.#sessionsRoot, changeId, "plans");
      const planPath = path.join(plansDirectory, `${revision}.json`);
      if (session.planRevision === revision) {
        if (session.planRequestDigest !== requestDigest) {
          throw new DesignTraceError(
            "STALE_PLAN",
            `Plan revision ${revision} already represents another request`,
          );
        }
        const saved = JSON.parse(await readFile(planPath, "utf8")) as unknown;
        validateChangePlan(saved);
        if (digestObject(saved) !== session.planDigest) {
          throw new DesignTraceError("INTEGRITY_ERROR", `Immutable plan file differs from its event: ${planPath}`);
        }
        if (session.state === "draft") {
          session = await store.transition("awaiting_execution_approval", "plan complete", now);
        }
        if (session.state !== "awaiting_execution_approval") {
          throw new DesignTraceError("INVALID_STATE", "Recovered plan is no longer awaiting execution approval");
        }
        await store.recordOperation("revise_plan", idempotencyKey, requestDigest, saved, now);
        return saved;
      }

      const context = await buildContext(
        this.#formalRepository.treeReader(String(first.data.baseline_commit)),
        draft.targets,
      );
      const contextId = `CTX-${context.context_digest.slice(0, 16).toUpperCase()}`;
      const plan: ChangePlan = {
        ...draft,
        schema_version: 1,
        id: changeId,
        plan_revision: revision,
        baseline_commit: String(first.data.baseline_commit),
        context_id: contextId,
        created_at: now.toISOString(),
      };
      validateChangePlan(plan);
      const planDigest = digestObject(plan);
      if (session.planRevision !== expectedPlanRevision) {
        throw new DesignTraceError(
          "STALE_PLAN",
          `Expected plan revision ${expectedPlanRevision}, current revision is ${session.planRevision}`,
          { expectedPlanRevision, currentPlanRevision: session.planRevision },
        );
      }
      if (
        session.state === "awaiting_execution_approval" ||
        session.state === "ready_to_execute" ||
        session.state === "blocked"
      ) {
        session = await store.transition("draft", "plan revised", now);
      }
      if (session.state !== "draft") {
        throw new DesignTraceError("INVALID_STATE", `Cannot revise a plan while Change is ${session.state}`);
      }

      await mkdir(plansDirectory, { recursive: true });
      const contextsDirectory = path.join(this.#sessionsRoot, changeId, "contexts");
      const contextPath = path.join(contextsDirectory, `${contextId}.json`);
      await mkdir(contextsDirectory, { recursive: true });
      if (!(await exists(contextPath))) {
        await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      }
      if (await exists(planPath)) {
        const saved = JSON.parse(await readFile(planPath, "utf8")) as unknown;
        if (digestObject(saved) !== planDigest) {
          throw new DesignTraceError("INTEGRITY_ERROR", `Immutable plan file already differs: ${planPath}`);
        }
      } else {
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      }
      await store.recordPlanRevision(revision, planDigest, requestDigest, now);
      await store.transition("awaiting_execution_approval", "plan complete", now);
      await store.recordOperation("revise_plan", idempotencyKey, requestDigest, plan, now);
      return plan;
    });
  }

  async getStatus(changeId: string): Promise<RecoveredSession> {
    assertChangeId(changeId);
    return new EventStore(this.#sessionsRoot, changeId).recover();
  }

  async cancelChange(
    changeId: string,
    idempotencyKey: string,
    reason = "cancelled by user",
    now = new Date(),
  ): Promise<RecoveredSession> {
    assertChangeId(changeId);
    if (!idempotencyKey.trim() || !reason.trim()) {
      throw new DesignTraceError("INVALID_PROJECT", "Cancellation key and reason are required");
    }
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      const requestDigest = digestObject({ change_id: changeId, reason });
      const prior = await store.findOperation("cancel_change", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as RecoveredSession;
      const current = await store.recover();
      if (current.state === "committing") {
        throw new DesignTraceError("INVALID_STATE", "A committing Change must be recovered before cancellation");
      }
      if (current.state === "applied") {
        throw new DesignTraceError("INVALID_STATE", "An applied Change must be compensated, not cancelled");
      }
      const cancelled = current.state === "cancelled"
        ? current
        : await store.transition("cancelled", reason, now);
      await store.recordOperation("cancel_change", idempotencyKey, requestDigest, cancelled, now);
      return cancelled;
    });
  }

  async startExecution(
    changeId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ExecutionAttempt> {
    assertChangeId(changeId);
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      let session = await store.recover();
      const requestDigest = digestObject({ change_id: changeId, plan_revision: session.planRevision });
      const prior = await store.findOperation("start_execution", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as ExecutionAttempt;
      const attemptId = `ATT-${digestObject({ change_id: changeId, idempotency_key: idempotencyKey })
        .slice(0, 16)
        .toUpperCase()}`;
      const attemptPath = path.join(this.#sessionsRoot, changeId, "attempts", `${attemptId}.json`);
      if (session.state === "executing" && session.activeAttemptId === attemptId && await exists(attemptPath)) {
        const recovered = JSON.parse(await readFile(attemptPath, "utf8")) as ExecutionAttempt;
        await store.recordOperation("start_execution", idempotencyKey, requestDigest, recovered, now);
        return recovered;
      }
      if (session.state !== "ready_to_execute") {
        if (!session.executionApprovalId) {
          throw new DesignTraceError("APPROVAL_REQUIRED", "Execution cannot start without operator approval");
        }
        throw new DesignTraceError("INVALID_STATE", `Cannot start execution while Change is ${session.state}`);
      }
      if (session.attemptCount >= 3) {
        throw new DesignTraceError("INVALID_STATE", "Execution attempt budget is exhausted");
      }
      const approval = await new ApprovalAuthority(this.projectRoot).requireValidExecutionApproval(changeId, now);
      const first = session.events[0]!;
      const baselineCommit = String(first.data.baseline_commit);
      const executionRoot = path.join(this.projectRoot, "execution");
      const workspacePath = path.join(executionRoot, attemptId);
      await mkdir(executionRoot, { recursive: true });
      if (!(await exists(workspacePath))) {
        const temporaryWorkspace = path.join(executionRoot, `.${attemptId}.${randomUUID()}.tmp`);
        try {
          await git(process.cwd(), [
            "clone",
            "--no-checkout",
            "--no-local",
            path.join(this.projectRoot, "repository.git"),
            temporaryWorkspace,
          ]);
          await git(temporaryWorkspace, ["checkout", "--detach", baselineCommit]);
          await git(temporaryWorkspace, ["remote", "remove", "origin"]);
          if (await git(temporaryWorkspace, ["status", "--porcelain"])) {
            throw new DesignTraceError("INTEGRITY_ERROR", "New execution workspace is not clean");
          }
          await rename(temporaryWorkspace, workspacePath);
        } catch (error) {
          await rm(temporaryWorkspace, { recursive: true, force: true });
          throw error;
        }
      } else {
        const workspaceCommit = await git(workspacePath, ["rev-parse", "HEAD"]);
        if (workspaceCommit !== baselineCommit) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Recovered execution workspace has the wrong baseline");
        }
      }
      const attempt: ExecutionAttempt = {
        attempt_id: attemptId,
        change_id: changeId,
        plan_revision: session.planRevision,
        plan_approval_id: approval.approval_id,
        baseline_commit: baselineCommit,
        workspace_id: attemptId,
        attempt_number: session.attemptCount + 1,
        status: "started",
        started_at: now.toISOString(),
      };
      await mkdir(path.dirname(attemptPath), { recursive: true });
      await writeFile(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await store.recordExecutionStarted(attemptId, approval.approval_id, now);
      session = await store.transition("executing", "approved execution started", now);
      void session;
      await store.recordOperation("start_execution", idempotencyKey, requestDigest, attempt, now);
      return attempt;
    });
  }
}
