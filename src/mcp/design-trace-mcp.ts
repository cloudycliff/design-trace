import { readFile } from "node:fs/promises";
import path from "node:path";
import { DesignTraceError } from "../core/errors.js";
import { EventStore } from "../core/event-store.js";
import { CandidateService } from "../domain/candidate-service.js";
import type { ChangePlanDraft } from "../domain/change-plan.js";
import { ChangeSessionService } from "../domain/change-session-service.js";
import { buildContext } from "../domain/context-service.js";
import { HistoryService } from "../domain/history-service.js";
import { PublicationService } from "../domain/publication-service.js";
import { FormalRepository } from "../formal/formal-repository.js";
import { ApprovalAuthority } from "../operator/approval-authority.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const stringField = { type: "string", minLength: 1 };

const tools: ToolDefinition[] = [
  {
    name: "query_design",
    description: "Read one Rule, its implementation reconciliation, current reason, and immutable history from the formal ref.",
    inputSchema: objectSchema({ rule_id: stringField, field: stringField }, ["rule_id"]),
  },
  {
    name: "get_history",
    description: "Read immutable formal history for one Rule.",
    inputSchema: objectSchema({ rule_id: stringField }, ["rule_id"]),
  },
  {
    name: "begin_change",
    description: "Begin one goal-first Change on the current formal baseline.",
    inputSchema: objectSchema({ request: stringField, idempotency_key: stringField }, ["request", "idempotency_key"]),
  },
  {
    name: "revise_plan",
    description: "Save a complete immutable ChangePlan revision. This does not approve execution.",
    inputSchema: objectSchema({
      change_id: stringField,
      expected_plan_revision: { type: "integer", minimum: 0 },
      draft: { type: "object" },
      idempotency_key: stringField,
    }, ["change_id", "expected_plan_revision", "draft", "idempotency_key"]),
  },
  {
    name: "get_change_status",
    description: "Read the recoverable event projection for a Change.",
    inputSchema: objectSchema({ change_id: stringField }, ["change_id"]),
  },
  {
    name: "build_task_context",
    description: "Read the frozen context package attached to the active plan.",
    inputSchema: objectSchema({ change_id: stringField }, ["change_id"]),
  },
  {
    name: "analyze_impact",
    description: "Analyze one-hop impacts for Rule IDs against the current formal ref.",
    inputSchema: objectSchema({ targets: { type: "array", minItems: 1, items: stringField } }, ["targets"]),
  },
  {
    name: "request_review",
    description: "Prepare an execution or result review and return its loopback review path. This never signs an approval.",
    inputSchema: objectSchema({
      change_id: stringField,
      stage: { type: "string", enum: ["execution", "result"] },
      bundle_id: stringField,
    }, ["change_id", "stage"]),
  },
  {
    name: "start_execution",
    description: "Start an independently cloned execution attempt after operator execution approval.",
    inputSchema: objectSchema({ change_id: stringField, idempotency_key: stringField }, ["change_id", "idempotency_key"]),
  },
  {
    name: "freeze_candidate",
    description: "Freeze and scope-check the active execution workspace.",
    inputSchema: objectSchema({ change_id: stringField, attempt_id: stringField, idempotency_key: stringField }, ["change_id", "attempt_id", "idempotency_key"]),
  },
  {
    name: "run_validation",
    description: "Run registered checks against one frozen snapshot.",
    inputSchema: objectSchema({ change_id: stringField, snapshot_id: stringField, idempotency_key: stringField }, ["change_id", "snapshot_id", "idempotency_key"]),
  },
  {
    name: "build_result_review",
    description: "Build an immutable payload and ReviewBundle after required checks pass.",
    inputSchema: objectSchema({ change_id: stringField, idempotency_key: stringField }, ["change_id", "idempotency_key"]),
  },
  {
    name: "commit_change",
    description: "Publish the active approved bundle with Git compare-and-swap. Approval is read internally.",
    inputSchema: objectSchema({ change_id: stringField, bundle_id: stringField, idempotency_key: stringField }, ["change_id", "bundle_id", "idempotency_key"]),
  },
  {
    name: "cancel_change",
    description: "Cancel a non-committing Change. Applied Changes require a compensation Change instead.",
    inputSchema: objectSchema({ change_id: stringField, reason: stringField, idempotency_key: stringField }, ["change_id", "reason", "idempotency_key"]),
  },
  {
    name: "propose_revert",
    description: "Create a compensating ChangePlan for one published Change, rejecting later field conflicts.",
    inputSchema: objectSchema({ target_change_id: stringField, request: stringField, idempotency_key: stringField }, ["target_change_id", "request", "idempotency_key"]),
  },
];

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new DesignTraceError("INVALID_PROJECT", `${name} must be a non-empty string`);
  }
  return value;
}

function result(value: unknown): ToolResult {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : Array.isArray(value)
      ? { items: value }
    : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

export class DesignTraceMcp {
  readonly #sessions: ChangeSessionService;
  readonly #candidates: CandidateService;
  readonly #publications: PublicationService;
  readonly #history: HistoryService;
  readonly #authority: ApprovalAuthority;
  readonly #repository: FormalRepository;

  constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
  ) {
    this.#sessions = new ChangeSessionService(projectRoot, projectId);
    this.#candidates = new CandidateService(projectRoot);
    this.#publications = new PublicationService(projectRoot);
    this.#history = new HistoryService(projectRoot, projectId);
    this.#authority = new ApprovalAuthority(projectRoot);
    this.#repository = new FormalRepository(path.join(projectRoot, "repository.git"));
  }

  listTools(): ToolDefinition[] {
    return tools.map((tool) => ({ ...tool }));
  }

  async callTool(name: string, rawArguments: unknown): Promise<ToolResult> {
    const args = rawArguments !== null && typeof rawArguments === "object" && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {};
    if (name === "query_design") {
      const field = typeof args.field === "string" ? args.field : undefined;
      return result(await this.#history.queryDesign(requiredString(args, "rule_id"), field));
    }
    if (name === "get_history") return result(await this.#history.getHistory(requiredString(args, "rule_id")));
    if (name === "begin_change") {
      return result(await this.#sessions.beginChange(requiredString(args, "request"), requiredString(args, "idempotency_key")));
    }
    if (name === "revise_plan") {
      if (!Number.isInteger(args.expected_plan_revision) || args.draft === null || typeof args.draft !== "object") {
        throw new DesignTraceError("INVALID_PROJECT", "expected_plan_revision and draft are required");
      }
      return result(await this.#sessions.revisePlan(
        requiredString(args, "change_id"),
        args.expected_plan_revision as number,
        args.draft as ChangePlanDraft,
        requiredString(args, "idempotency_key"),
      ));
    }
    if (name === "get_change_status") return result(await this.#sessions.getStatus(requiredString(args, "change_id")));
    if (name === "build_task_context") {
      const changeId = requiredString(args, "change_id");
      const session = await this.#sessions.getStatus(changeId);
      if (session.planRevision < 1) throw new DesignTraceError("INVALID_STATE", "Change has no plan context");
      const plan = JSON.parse(await readFile(
        path.join(this.projectRoot, "sessions", changeId, "plans", `${session.planRevision}.json`),
        "utf8",
      )) as { context_id: string };
      return result(JSON.parse(await readFile(
        path.join(this.projectRoot, "sessions", changeId, "contexts", `${plan.context_id}.json`),
        "utf8",
      )) as unknown);
    }
    if (name === "analyze_impact") {
      if (!Array.isArray(args.targets) || args.targets.some((target) => typeof target !== "string")) {
        throw new DesignTraceError("INVALID_PROJECT", "targets must be a string array");
      }
      return result(await buildContext(this.#repository.treeReader(), args.targets as string[]));
    }
    if (name === "request_review") {
      const changeId = requiredString(args, "change_id");
      const stage = requiredString(args, "stage");
      if (stage === "execution") {
        const review = await this.#authority.prepareExecutionReview(changeId);
        return result({ ...review, review_path: `/review/execution/${review.review_id}` });
      }
      if (stage === "result") {
        const review = await this.#authority.prepareResultReview(changeId, requiredString(args, "bundle_id"));
        return result({ ...review, review_path: `/review/result/${review.review_id}` });
      }
      throw new DesignTraceError("INVALID_PROJECT", "stage must be execution or result");
    }
    if (name === "start_execution") {
      return result(await this.#sessions.startExecution(requiredString(args, "change_id"), requiredString(args, "idempotency_key")));
    }
    if (name === "freeze_candidate") {
      return result(await this.#candidates.freezeCandidate(
        requiredString(args, "change_id"),
        requiredString(args, "attempt_id"),
        requiredString(args, "idempotency_key"),
      ));
    }
    if (name === "run_validation") {
      return result(await this.#candidates.validateCandidate(
        requiredString(args, "change_id"),
        requiredString(args, "snapshot_id"),
        requiredString(args, "idempotency_key"),
      ));
    }
    if (name === "build_result_review") {
      return result(await this.#publications.buildResultReview(requiredString(args, "change_id"), requiredString(args, "idempotency_key")));
    }
    if (name === "commit_change") {
      return result(await this.#publications.commitChange(
        requiredString(args, "change_id"),
        requiredString(args, "bundle_id"),
        requiredString(args, "idempotency_key"),
      ));
    }
    if (name === "cancel_change") {
      return result(await this.#sessions.cancelChange(
        requiredString(args, "change_id"),
        requiredString(args, "idempotency_key"),
        requiredString(args, "reason"),
      ));
    }
    if (name === "propose_revert") {
      return result(await this.#history.proposeRevert(
        requiredString(args, "target_change_id"),
        requiredString(args, "request"),
        requiredString(args, "idempotency_key"),
      ));
    }
    throw new DesignTraceError("INVALID_PROJECT", `Unknown MCP tool: ${name}`);
  }
}
