import path from "node:path";
import { DesignTraceError } from "../core/errors.js";
import { FormalRepository, GitTreeReader } from "../formal/formal-repository.js";
import { parseFrontmatter } from "../formal/frontmatter.js";
import { git } from "../git/git-client.js";
import { ChangeSessionService } from "./change-session-service.js";
import type { ChangePlan, ChangePlanDraft } from "./change-plan.js";
import { loadFormalObjects, loadProjectDefinition, type Decision, type Rule } from "./formal-objects.js";
import { reconcileBinding, jsonPointer, type ReconciliationResult } from "./reconciliation.js";
import type { ReviewBundle } from "./review-bundle.js";

const FORMAL_REF = "refs/heads/dt-main";

interface ChangeRecord {
  path: string;
  value: Record<string, unknown>;
}

export interface RuleHistoryEntry {
  commit: string;
  version: number;
  last_change_id: string | null;
  change_reason: string | "unknown";
  changed_at: string | null;
}

export interface DesignQueryResult {
  formal_commit: string;
  source_status: {
    source: "verified_formal_commit";
    index_status: "not_available";
    degraded: true;
  };
  rule_path: string;
  rule: Rule;
  implementation: ReconciliationResult[];
  current_reason: {
    status: "known" | "unknown";
    change_id: string | null;
    change_reason: string | "unknown";
    request: string | null;
    decisions: Decision[];
  };
  history: RuleHistoryEntry[];
}

export interface ProposedRevert {
  target_change_id: string;
  target_commit: string;
  change_id: string;
  plan: ChangePlan;
}

function assertObjectId(value: string, prefix: "RULE" | "CHG"): void {
  if (!new RegExp(`^${prefix}-[A-Z0-9-]{1,64}$`, "u").test(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `Invalid ${prefix} ID`);
  }
}

function dottedValue(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const segment of dottedPath.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export class HistoryService {
  readonly #repositoryPath: string;
  readonly #formalRepository: FormalRepository;

  constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
  ) {
    this.#repositoryPath = path.join(projectRoot, "repository.git");
    this.#formalRepository = new FormalRepository(this.#repositoryPath);
  }

  async queryDesign(ruleId: string, field?: string, revision = FORMAL_REF): Promise<DesignQueryResult> {
    assertObjectId(ruleId, "RULE");
    const commit = revision === FORMAL_REF
      ? await this.#formalRepository.currentCommit()
      : await git(process.cwd(), ["rev-parse", "--verify", `${revision}^{commit}`], {
          gitDir: this.#repositoryPath,
        });
    const reader = new GitTreeReader(process.cwd(), commit, this.#repositoryPath);
    const objects = await loadFormalObjects(reader);
    const rule = objects.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) throw new DesignTraceError("INVALID_PROJECT", `Unknown Rule: ${ruleId}`);
    const rulePath = await this.findRulePath(reader, ruleId);
    const bindings = objects.bindings.filter(
      (binding) => binding.rule_id === ruleId && (!field || binding.rule_field === field),
    );
    const implementation = await Promise.all(bindings.map((binding) => reconcileBinding(reader, rule, binding)));
    const decisionIds = new Set(
      rule.decision_bindings
        .filter((binding) => !field || binding.fields.includes(field))
        .map((binding) => binding.decision_id),
    );
    const decisions = objects.decisions.filter((decision) =>
      decisionIds.has(decision.id) && decision.targets.some((target) =>
        target.rule_id === ruleId &&
        (!field || target.fields.includes(field)),
      ),
    );
    const change = rule.last_change_id ? await this.findChange(reader, rule.last_change_id) : null;
    const changeReason = typeof change?.value.reason === "string" ? change.value.reason : "unknown";
    const request = typeof change?.value.request === "string" ? change.value.request : null;
    return {
      formal_commit: commit,
      source_status: {
        source: "verified_formal_commit",
        index_status: "not_available",
        degraded: true,
      },
      rule_path: rulePath,
      rule,
      implementation,
      current_reason: {
        status: decisions.length > 0 || changeReason !== "unknown" ? "known" : "unknown",
        change_id: rule.last_change_id,
        change_reason: changeReason,
        request,
        decisions,
      },
      history: await this.ruleHistory(rulePath),
    };
  }

  async getHistory(ruleId: string): Promise<RuleHistoryEntry[]> {
    return (await this.queryDesign(ruleId)).history;
  }

  async proposeRevert(
    targetChangeId: string,
    request: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ProposedRevert> {
    assertObjectId(targetChangeId, "CHG");
    if (!request.trim() || !idempotencyKey.trim()) {
      throw new DesignTraceError("INVALID_PROJECT", "Revert request and idempotency key are required");
    }
    const currentCommit = await this.#formalRepository.currentCommit();
    const reader = this.#formalRepository.treeReader(currentCommit);
    const change = await this.findChange(reader, targetChangeId);
    if (!change || change.value.kind === "bootstrap") {
      throw new DesignTraceError("INVALID_PROJECT", `Published Change is not revertible: ${targetChangeId}`);
    }
    const bundleId = change.value.bundle_id;
    const planRevision = change.value.plan_revision;
    if (typeof bundleId !== "string" || !Number.isInteger(planRevision)) {
      throw new DesignTraceError("INTEGRITY_ERROR", `Change ${targetChangeId} has no publication metadata`);
    }
    const receipt = JSON.parse(await reader.readText(`design/receipts/${bundleId}.json`)) as {
      review_bundle?: ReviewBundle;
    };
    const bundle = receipt.review_bundle;
    if (!bundle || bundle.change_id !== targetChangeId || bundle.bundle_id !== bundleId) {
      throw new DesignTraceError("INTEGRITY_ERROR", `Change ${targetChangeId} receipt does not bind its bundle`);
    }
    const originalPlan = JSON.parse(
      await reader.readText(`design/plans/${targetChangeId}-r${String(planRevision)}.json`),
    ) as ChangePlan;
    const targetCommit = await this.findChangeCommit(change.path, currentCommit);
    await this.assertRevertHasNoConflicts(reader, targetCommit, originalPlan, bundle);
    const project = await loadProjectDefinition(reader);
    const draft: ChangePlanDraft = {
      origin: "user_instruction",
      kind: "revert",
      request,
      goal: `Compensate ${targetChangeId}: restore its changed business fields`,
      targets: originalPlan.targets,
      allowed_paths: originalPlan.allowed_paths,
      allowed_config_changes: originalPlan.allowed_config_changes.map((changeItem) => ({
        ...changeItem,
        before: changeItem.after,
        after: changeItem.before,
      })),
      design_changes: originalPlan.design_changes,
      out_of_scope: originalPlan.out_of_scope,
      protected_checks: originalPlan.protected_checks,
      acceptance_checks: originalPlan.acceptance_checks,
      risk_level: originalPlan.risk_level,
      policy_version: project.policy_version,
      reason: request,
      reason_source: "user_statement",
      revert_of: targetChangeId,
    };
    const sessions = new ChangeSessionService(this.projectRoot, this.projectId);
    const begun = await sessions.beginChange(request, `revert-begin:${idempotencyKey}`);
    const plan = await sessions.revisePlan(begun.changeId, 0, draft, `revert-plan:${idempotencyKey}`, now);
    return { target_change_id: targetChangeId, target_commit: targetCommit, change_id: begun.changeId, plan };
  }

  private async assertRevertHasNoConflicts(
    currentReader: GitTreeReader,
    targetCommit: string,
    originalPlan: ChangePlan,
    bundle: ReviewBundle,
  ): Promise<void> {
    const conflicts: Array<Record<string, unknown>> = [];
    for (const change of bundle.changed_pointers) {
      try {
        const current = jsonPointer(JSON.parse(await currentReader.readText(change.path)) as unknown, change.pointer);
        if (!Object.is(current, change.after)) {
          conflicts.push({ path: change.path, pointer: change.pointer, expected: change.after, actual: current });
        }
      } catch (error) {
        conflicts.push({
          path: change.path,
          pointer: change.pointer,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const targetObjects = await loadFormalObjects(new GitTreeReader(process.cwd(), targetCommit, this.#repositoryPath));
    const currentObjects = await loadFormalObjects(currentReader);
    for (const designChange of originalPlan.design_changes) {
      const targetRule = targetObjects.rules.find((rule) => rule.id === designChange.rule_id);
      const currentRule = currentObjects.rules.find((rule) => rule.id === designChange.rule_id);
      for (const field of designChange.fields) {
        const expected = dottedValue(targetRule, field);
        const actual = dottedValue(currentRule, field);
        if (expected === undefined || actual === undefined || !Object.is(actual, expected)) {
          conflicts.push({ rule_id: designChange.rule_id, field, expected, actual });
        }
      }
    }
    if (conflicts.length > 0) {
      throw new DesignTraceError(
        "REVERT_CONFLICT",
        `Cannot compensate ${originalPlan.id}; target fields changed after its publication`,
        { targetChangeId: originalPlan.id, conflicts },
      );
    }
  }

  private async ruleHistory(rulePath: string): Promise<RuleHistoryEntry[]> {
    const output = await git(process.cwd(), ["log", "--format=%H", FORMAL_REF, "--", rulePath], {
      gitDir: this.#repositoryPath,
    });
    const commits = output.split(/\r?\n/u).filter(Boolean);
    const history: RuleHistoryEntry[] = [];
    for (const commit of commits) {
      const reader = new GitTreeReader(process.cwd(), commit, this.#repositoryPath);
      const rule = parseFrontmatter(await reader.readText(rulePath), rulePath);
      const changeId = typeof rule.last_change_id === "string" ? rule.last_change_id : null;
      const change = changeId ? await this.findChange(reader, changeId) : null;
      history.push({
        commit,
        version: Number(rule.version),
        last_change_id: changeId,
        change_reason: typeof change?.value.reason === "string" ? change.value.reason : "unknown",
        changed_at: typeof change?.value.created_at === "string" ? change.value.created_at : null,
      });
    }
    return history;
  }

  private async findRulePath(reader: GitTreeReader, ruleId: string): Promise<string> {
    for (const file of (await reader.listFiles()).filter((entry) => /^design\/rules\/[^/]+\.md$/u.test(entry.path))) {
      if (parseFrontmatter(await reader.readText(file.path), file.path).id === ruleId) return file.path;
    }
    throw new DesignTraceError("INVALID_PROJECT", `Unknown Rule: ${ruleId}`);
  }

  private async findChange(reader: GitTreeReader, changeId: string): Promise<ChangeRecord | null> {
    for (const file of (await reader.listFiles()).filter((entry) => /^design\/changes\/[^/]+\.md$/u.test(entry.path))) {
      const value = parseFrontmatter(await reader.readText(file.path), file.path);
      if (value.id === changeId) return { path: file.path, value };
    }
    return null;
  }

  private async findChangeCommit(changePath: string, currentCommit: string): Promise<string> {
    const output = await git(process.cwd(), ["log", "--format=%H", "--diff-filter=A", currentCommit, "--", changePath], {
      gitDir: this.#repositoryPath,
    });
    const commit = output.split(/\r?\n/u).filter(Boolean).at(-1);
    if (!commit) throw new DesignTraceError("INTEGRITY_ERROR", `Cannot locate publication commit for ${changePath}`);
    return commit;
  }
}
