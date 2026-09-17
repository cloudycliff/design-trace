import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestObject } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { EventStore, type RecoveredSession } from "../core/event-store.js";
import { withFileLock } from "../core/file-lock.js";
import { FormalRepository } from "../formal/formal-repository.js";
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

const terminalStates = new Set(["applied", "cancelled"]);

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

      const plan: ChangePlan = {
        ...draft,
        schema_version: 1,
        id: changeId,
        plan_revision: revision,
        baseline_commit: String(first.data.baseline_commit),
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
      if (session.state === "awaiting_execution_approval" || session.state === "blocked") {
        session = await store.transition("draft", "plan revised", now);
      }
      if (session.state !== "draft") {
        throw new DesignTraceError("INVALID_STATE", `Cannot revise a plan while Change is ${session.state}`);
      }

      await mkdir(plansDirectory, { recursive: true });
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
    return new EventStore(this.#sessionsRoot, changeId).recover();
  }
}
