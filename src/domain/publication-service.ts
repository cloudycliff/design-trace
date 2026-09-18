import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { digestObject, sha256 } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { EventStore } from "../core/event-store.js";
import { withFileLock } from "../core/file-lock.js";
import { FormalRepository, GitTreeReader } from "../formal/formal-repository.js";
import { parseFrontmatter } from "../formal/frontmatter.js";
import { validateBaseline } from "../formal/project-validator.js";
import { validateFormalTree } from "../formal/formal-integrity.js";
import { git } from "../git/git-client.js";
import { ApprovalAuthority, type ApprovalRecord } from "../operator/approval-authority.js";
import { validateChangePlan, type ChangePlan } from "./change-plan.js";
import type { ExecutionAttempt } from "./change-session-service.js";
import type { ContextPackage } from "./context-service.js";
import type { ExecutionSnapshot } from "./candidate-service.js";
import { loadFormalObjects } from "./formal-objects.js";
import type { PublishedChange, ReviewBundle } from "./review-bundle.js";
import type { ValidationBatch } from "./validation-service.js";

const FORMAL_REF = "refs/heads/dt-main";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function assertId(value: string, prefix: "CHG" | "BND"): void {
  if (!new RegExp(`^${prefix}-[A-Z0-9-]{1,64}$`, "u").test(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `Invalid ${prefix} ID`);
  }
}

function markdown(frontmatter: Record<string, unknown>, title: string, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n# ${title}\n\n${body}\n`;
}

export class PublicationService {
  readonly #sessionsRoot: string;
  readonly #repositoryPath: string;
  readonly #lockPath: string;

  constructor(private readonly projectRoot: string) {
    this.#sessionsRoot = path.join(projectRoot, "sessions");
    this.#repositoryPath = path.join(projectRoot, "repository.git");
    this.#lockPath = path.join(projectRoot, ".write.lock");
  }

  async buildResultReview(
    changeId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ReviewBundle> {
    assertId(changeId, "CHG");
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      const session = await store.recover();
      const requestDigest = digestObject({
        change_id: changeId,
        plan_revision: session.planRevision,
        snapshot_id: session.activeSnapshotId,
        validation_batch_id: session.validationBatchId,
      });
      const prior = await store.findOperation("build_result_review", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as ReviewBundle;
      if (session.activeBundleId) {
        const recovered = await this.readBundle(changeId, session.activeBundleId);
        if (recovered.review_digest !== session.activeReviewDigest) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Active bundle differs from its event record");
        }
        await store.recordOperation("build_result_review", idempotencyKey, requestDigest, recovered, now);
        return recovered;
      }
      if (
        session.state !== "awaiting_result_approval" ||
        !session.activeSnapshotId ||
        !session.activeSnapshotCommit ||
        !session.validationBatchId ||
        !session.planDigest ||
        !session.executionApprovalId
      ) {
        throw new DesignTraceError("INVALID_STATE", "A validated active snapshot is required to build a result review");
      }

      const plan = await this.readPlan(changeId, session.planRevision);
      const snapshot = await this.readSnapshot(changeId, session.activeSnapshotId);
      const validation = await this.readValidation(session.validationBatchId);
      const context = await this.readContext(changeId, plan.context_id);
      if (!session.activeAttemptId) throw new DesignTraceError("INTEGRITY_ERROR", "Validated session has no active attempt");
      const attempt = JSON.parse(await readFile(
        path.join(this.#sessionsRoot, changeId, "attempts", `${session.activeAttemptId}.json`),
        "utf8",
      )) as ExecutionAttempt;
      const executionApproval = await new ApprovalAuthority(this.projectRoot).requireValidExecutionApproval(
        changeId,
        new Date(attempt.started_at),
      );
      const retainedSnapshot = await git(
        process.cwd(),
        ["rev-parse", `refs/dt/snapshots/${changeId}/${snapshot.attempt_id}`],
        { gitDir: this.#repositoryPath },
      );
      const retainedTree = await git(process.cwd(), ["rev-parse", `${snapshot.snapshot_commit}^{tree}`], {
        gitDir: this.#repositoryPath,
      });
      const { context_digest: contextDigest, ...unsignedContext } = context;
      const expectedChecks = new Set([...plan.acceptance_checks, ...plan.protected_checks]);
      if (
        digestObject(plan) !== session.planDigest ||
        digestObject(unsignedContext) !== contextDigest ||
        retainedSnapshot !== snapshot.snapshot_commit ||
        retainedTree !== snapshot.execution_tree_oid ||
        snapshot.snapshot_commit !== session.activeSnapshotCommit ||
        validation.batch_id !== session.validationBatchId ||
        validation.source_tree_oid !== snapshot.execution_tree_oid ||
        validation.runs.some((run) => run.source_tree_oid !== snapshot.execution_tree_oid) ||
        validation.runs.length !== expectedChecks.size ||
        validation.runs.some((run) => !expectedChecks.has(run.check_id)) ||
        !validation.all_required_passed ||
        validation.runs.some((run) => run.required && run.result !== "passed")
        || attempt.plan_approval_id !== executionApproval.approval_id
        || attempt.attempt_id !== snapshot.attempt_id
      ) {
        throw new DesignTraceError("VALIDATION_FAILED", "Validation evidence is incomplete or does not bind the active snapshot");
      }
      const bundleId = `BND-${digestObject({
        change_id: changeId,
        plan_digest: session.planDigest,
        snapshot_id: snapshot.snapshot_id,
        validation_batch_id: validation.batch_id,
      }).slice(0, 20).toUpperCase()}`;

      const workspace = await mkdtemp(path.join(os.tmpdir(), "dt-payload-"));
      try {
        await git(process.cwd(), ["clone", "--no-checkout", "--no-local", this.#repositoryPath, workspace]);
        await git(workspace, ["fetch", this.#repositoryPath, `+refs/dt/snapshots/${changeId}/${snapshot.attempt_id}:refs/dt/source-snapshot`]);
        await git(workspace, ["checkout", "--detach", snapshot.snapshot_commit]);
        const designPaths = await this.applyFormalRuleChanges(workspace, plan, changeId, now);
        const recordPaths = await this.writePayloadRecords(
          workspace,
          changeId,
          bundleId,
          plan,
          context,
          executionApproval,
          snapshot,
          validation,
          now,
        );
        await git(workspace, ["config", "user.name", "Design Trace Kernel"]);
        await git(workspace, ["config", "user.email", "kernel@design-trace.invalid"]);
        await git(workspace, ["add", "--all"]);
        await git(workspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", `DT payload ${changeId} ${bundleId}`]);
        const payloadCommit = await git(workspace, ["rev-parse", "HEAD"]);
        const payloadTreeOid = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
        await validateBaseline(new GitTreeReader(workspace, payloadCommit));
        await this.assertImmutableHistory(workspace, plan.baseline_commit, payloadCommit);
        const unsigned = {
          schema_version: 1 as const,
          bundle_id: bundleId,
          change_id: changeId,
          plan_revision: plan.plan_revision,
          baseline_commit: plan.baseline_commit,
          execution_snapshot_id: snapshot.snapshot_id,
          execution_tree_oid: snapshot.execution_tree_oid,
          payload_commit: payloadCommit,
          payload_tree_oid: payloadTreeOid,
          validation_batch_id: validation.batch_id,
          validation_run_ids: validation.runs.map((run) => run.run_id),
          plan_digest: session.planDigest,
          context_digest: contextDigest,
          impact_digest: digestObject({
            definite_impacts: context.definite_impacts,
            possible_impacts: context.possible_impacts,
            coverage_gaps: context.coverage_gaps,
          }),
          policy_digest: digestObject({ policy_version: plan.policy_version }),
          policy_version: plan.policy_version,
          execution_approval_id: executionApproval.approval_id,
          changed_paths: [...new Set([...snapshot.changed_paths, ...designPaths, ...recordPaths])].sort(),
          changed_pointers: snapshot.changed_pointers,
          built_at: now.toISOString(),
        };
        const bundle: ReviewBundle = { ...unsigned, review_digest: digestObject(unsigned) };
        const bundlePath = path.join(this.#sessionsRoot, changeId, "bundles", `${bundleId}.json`);
        await writeJson(bundlePath, bundle);
        await git(workspace, ["push", this.#repositoryPath, `HEAD:refs/dt/payloads/${changeId}/${bundleId}`]);
        await store.recordBundleBuilt(bundleId, payloadCommit, payloadTreeOid, bundle.review_digest, now);
        await store.recordOperation("build_result_review", idempotencyKey, requestDigest, bundle, now);
        return bundle;
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  async commitChange(
    changeId: string,
    bundleId: string,
    idempotencyKey: string,
    now = new Date(),
    hooks: { afterCas?: () => void | Promise<void> } = {},
  ): Promise<PublishedChange> {
    assertId(changeId, "CHG");
    assertId(bundleId, "BND");
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      let session = await store.recover();
      const requestDigest = digestObject({ change_id: changeId, bundle_id: bundleId });
      const prior = await store.findOperation("commit_change", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as PublishedChange;
      const bundle = await this.readBundle(changeId, bundleId);
      const formalBefore = await this.currentFormalCommit();
      const recoveringPublishedCommit = session.preparedCommit !== null && formalBefore === session.preparedCommit;
      const approval = await new ApprovalAuthority(this.projectRoot).requireValidResultApproval(
        changeId,
        bundleId,
        now,
        recoveringPublishedCommit,
      );

      if (session.activeBundleId !== bundleId || session.activeReviewDigest !== bundle.review_digest) {
        throw new DesignTraceError("APPROVAL_REQUIRED", "Result approval does not bind the active review bundle");
      }
      if (session.preparedCommit) {
        if (formalBefore === session.preparedCommit) {
          return this.finishApplied(store, session, bundle, approval, idempotencyKey, requestDigest, now);
        }
        if (formalBefore !== bundle.baseline_commit) {
          throw new DesignTraceError("STALE_BASELINE", "Formal reference moved before publication");
        }
      } else {
        if (session.state !== "ready_to_commit") {
          throw new DesignTraceError("INVALID_STATE", `Cannot commit Change while it is ${session.state}`);
        }
        if (formalBefore !== bundle.baseline_commit) {
          throw new DesignTraceError("STALE_BASELINE", "Formal reference no longer equals the approved baseline");
        }
        session = await store.transition("committing", "result approval accepted for publication", now);
      }

      let candidateCommit = session.preparedCommit;
      if (!candidateCommit) {
        candidateCommit = await this.prepareFinalCommit(bundle, approval, now);
        await store.recordCommitPrepared(
          bundleId,
          candidateCommit,
          bundle.baseline_commit,
          idempotencyKey,
          requestDigest,
          now,
        );
        session = await store.recover();
      }

      try {
        await git(process.cwd(), ["update-ref", FORMAL_REF, candidateCommit, bundle.baseline_commit], {
          gitDir: this.#repositoryPath,
        });
      } catch (error) {
        const current = await this.currentFormalCommit();
        if (current !== candidateCommit) {
          await store.transition("blocked", "formal baseline changed before compare-and-swap publication", now);
          throw new DesignTraceError("STALE_BASELINE", "Git compare-and-swap rejected a stale baseline", {
            expected: bundle.baseline_commit,
            actual: current,
          });
        }
      }
      await hooks.afterCas?.();
      return this.finishApplied(store, session, bundle, approval, idempotencyKey, requestDigest, now);
    });
  }

  private async finishApplied(
    store: EventStore,
    session: Awaited<ReturnType<EventStore["recover"]>>,
    bundle: ReviewBundle,
    approval: ApprovalRecord,
    idempotencyKey: string,
    requestDigest: string,
    now: Date,
  ): Promise<PublishedChange> {
    const commit = session.preparedCommit;
    if (!commit) throw new DesignTraceError("INTEGRITY_ERROR", "No prepared commit exists after publication");
    const result: PublishedChange = {
      change_id: bundle.change_id,
      bundle_id: bundle.bundle_id,
      commit,
      parent_commit: bundle.baseline_commit,
      payload_tree_oid: bundle.payload_tree_oid,
      review_digest: bundle.review_digest,
      result_approval_id: approval.approval_id,
      status: "applied",
    };
    await new FormalRepository(this.#repositoryPath).markVerifiedCommit(commit, bundle.baseline_commit);
    await store.recordChangeApplied(bundle.bundle_id, commit, now);
    const recovered = await store.recover();
    if (recovered.state === "committing") await store.transition("applied", "formal reference published", now);
    await store.recordOperation("commit_change", idempotencyKey, requestDigest, result, now);
    return result;
  }

  private async prepareFinalCommit(bundle: ReviewBundle, approval: ApprovalRecord, now: Date): Promise<string> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "dt-publish-"));
    try {
      await git(process.cwd(), ["clone", "--no-checkout", "--no-local", this.#repositoryPath, workspace]);
      await git(workspace, ["fetch", this.#repositoryPath, `+refs/dt/payloads/${bundle.change_id}/${bundle.bundle_id}:refs/dt/payload`]);
      await git(workspace, ["checkout", "--detach", bundle.payload_commit]);
      const actualPayloadTree = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
      if (actualPayloadTree !== bundle.payload_tree_oid) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Payload ref does not resolve to the approved tree");
      }
      const { review_digest: _reviewDigest, ...unsignedBundle } = bundle;
      if (digestObject(unsignedBundle) !== bundle.review_digest) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Review bundle digest is invalid");
      }
      const approvalPath = `design/approvals/${approval.approval_id}.json`;
      const receiptPath = `design/receipts/${bundle.bundle_id}.json`;
      await writeJson(path.join(workspace, ...approvalPath.split("/")), approval);
      await writeJson(path.join(workspace, ...receiptPath.split("/")), {
        schema_version: 1,
        change_id: bundle.change_id,
        bundle_id: bundle.bundle_id,
        payload_tree_oid: bundle.payload_tree_oid,
        review_digest: bundle.review_digest,
        parent_commit: bundle.baseline_commit,
        result_approval_id: approval.approval_id,
        records: [approvalPath, receiptPath],
        review_bundle: bundle,
        applied_at: now.toISOString(),
      });
      await git(workspace, ["config", "user.name", "Design Trace Kernel"]);
      await git(workspace, ["config", "user.email", "kernel@design-trace.invalid"]);
      await git(workspace, ["add", "--all"]);
      const finalAdditions = (await git(
        workspace,
        ["diff", "--cached", "--name-only", "-z", bundle.payload_commit],
        { trim: false },
      )).split("\0").filter(Boolean).sort();
      if (
        finalAdditions.length !== 2 ||
        !finalAdditions.includes(approvalPath) ||
        !finalAdditions.includes(receiptPath)
      ) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Final tree contains changes beyond result Approval and receipt", {
          finalAdditions,
        });
      }
      const finalTree = await git(workspace, ["write-tree"]);
      const candidate = await git(workspace, ["commit-tree", finalTree, "-p", bundle.baseline_commit, "-m", `Apply ${bundle.change_id}`]);
      await validateFormalTree(new GitTreeReader(workspace, candidate));
      await git(workspace, ["push", this.#repositoryPath, `${candidate}:refs/dt/prepared/${bundle.change_id}/${bundle.bundle_id}`]);
      const parent = await git(process.cwd(), ["rev-parse", `${candidate}^`], { gitDir: this.#repositoryPath });
      if (parent !== bundle.baseline_commit) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Prepared commit has an unexpected parent");
      }
      return candidate;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async applyFormalRuleChanges(
    workspace: string,
    plan: ChangePlan,
    changeId: string,
    now: Date,
  ): Promise<string[]> {
    const reader = new GitTreeReader(workspace, "HEAD");
    const objects = await loadFormalObjects(reader);
    const files = await reader.listFiles();
    const changedDesignPaths: string[] = [];
    for (const designChange of plan.design_changes) {
      const matchingPath = await this.findRulePath(reader, files.map((file) => file.path), designChange.rule_id);
      if (!matchingPath) throw new DesignTraceError("INVALID_PROJECT", `Cannot find Rule ${designChange.rule_id}`);
      const absolute = path.join(workspace, ...matchingPath.split("/"));
      const source = await readFile(absolute, "utf8");
      const frontmatter = parseFrontmatter(source, matchingPath);
      const previousBindings = Array.isArray(frontmatter.decision_bindings)
        ? frontmatter.decision_bindings as Array<{ decision_id: string; fields: string[] }>
        : [];
      for (const field of designChange.fields) {
        const match = /^parameters\.(.+)$/u.exec(field);
        if (!match?.[1]) throw new DesignTraceError("UNSUPPORTED_RESOURCE", `Unsupported Rule field: ${field}`);
        const binding = objects.bindings.find(
          (candidate) => candidate.rule_id === designChange.rule_id && candidate.rule_field === field,
        );
        const configChange = binding && plan.allowed_config_changes.find(
          (candidate) => candidate.path === binding.path && candidate.pointer === binding.pointer,
        );
        if (!binding || !configChange) {
          throw new DesignTraceError("INVALID_PROJECT", `No approved implementation value is bound to ${designChange.rule_id}.${field}`);
        }
        const parameters = frontmatter.parameters as Record<string, unknown>;
        parameters[match[1]] = configChange.after;
        if (field === "parameters.penalty_bps" && typeof configChange.before === "number" && typeof configChange.after === "number") {
          frontmatter.statement = String(frontmatter.statement).replace(
            `${configChange.before / 100}%`,
            `${configChange.after / 100}%`,
          );
        }
      }
      frontmatter.version = Number(frontmatter.version) + 1;
      frontmatter.last_change_id = changeId;
      if (plan.reason && plan.reason_source) {
        const decisionId = `DEC-${digestObject({ change_id: changeId, rule_id: designChange.rule_id })
          .slice(0, 20).toUpperCase()}`;
        const replacedFields = new Set(designChange.fields);
        const retainedBindings = previousBindings
          .map((binding) => ({ ...binding, fields: binding.fields.filter((field) => !replacedFields.has(field)) }))
          .filter((binding) => binding.fields.length > 0);
        frontmatter.decision_bindings = [
          ...retainedBindings,
          { decision_id: decisionId, fields: designChange.fields },
        ];
        const supersedes = previousBindings.flatMap((binding) => {
          const fields = binding.fields.filter((field) => replacedFields.has(field));
          return fields.length > 0 ? [{ decision_id: binding.decision_id, rule_id: designChange.rule_id, fields }] : [];
        });
        const decisionPath = `design/decisions/${decisionId}.md`;
        await mkdir(path.join(workspace, "design", "decisions"), { recursive: true });
        await writeFile(
          path.join(workspace, ...decisionPath.split("/")),
          markdown(
            {
              schema_version: 1,
              id: decisionId,
              targets: [{
                rule_id: designChange.rule_id,
                rule_version: frontmatter.version,
                fields: designChange.fields,
              }],
              decision: plan.goal,
              rationale: plan.reason,
              rationale_source: plan.reason_source,
              evidence_ids: [],
              alternatives: "unknown",
              supersedes,
              created_at: now.toISOString(),
            },
            plan.goal,
            plan.reason,
          ),
          { encoding: "utf8", flag: "wx" },
        );
        changedDesignPaths.push(decisionPath);
      }
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
      await writeFile(absolute, markdown(frontmatter, String(frontmatter.id), body), "utf8");
      changedDesignPaths.push(matchingPath);
    }
    return changedDesignPaths;
  }

  private async findRulePath(reader: GitTreeReader, files: string[], ruleId: string): Promise<string | undefined> {
    for (const file of files.filter((candidate) => /^design\/rules\/[^/]+\.md$/u.test(candidate))) {
      if (parseFrontmatter(await reader.readText(file), file).id === ruleId) return file;
    }
    return undefined;
  }

  private async writePayloadRecords(
    workspace: string,
    changeId: string,
    bundleId: string,
    plan: ChangePlan,
    context: ContextPackage,
    executionApproval: ApprovalRecord,
    snapshot: ExecutionSnapshot,
    validation: ValidationBatch,
    now: Date,
  ): Promise<string[]> {
    const paths = {
      change: `design/changes/${changeId}.md`,
      plan: `design/plans/${changeId}-r${plan.plan_revision}.json`,
      context: `design/contexts/${plan.context_id}.json`,
      approval: `design/approvals/${executionApproval.approval_id}.json`,
      validation: `design/evidence/${validation.batch_id}.json`,
    };
    await mkdir(path.join(workspace, "design", "changes"), { recursive: true });
    await writeFile(
      path.join(workspace, ...paths.change.split("/")),
      markdown(
        {
          schema_version: 1,
          id: changeId,
          status: "applied",
          kind: plan.kind,
          plan_revision: plan.plan_revision,
          execution_attempt_id: snapshot.attempt_id,
          execution_snapshot_id: snapshot.snapshot_id,
          bundle_id: bundleId,
          plan_approval_id: executionApproval.approval_id,
          validation_batch_id: validation.batch_id,
          changed_paths: snapshot.changed_paths,
          request: plan.request,
          goal: plan.goal,
          reason: plan.reason ?? "unknown",
          ...(plan.reason_source ? { reason_source: plan.reason_source } : {}),
          ...(plan.revert_of ? { revert_of: plan.revert_of } : {}),
          created_at: now.toISOString(),
        },
        plan.goal,
        `Original request: ${plan.request}`,
      ),
      "utf8",
    );
    await writeJson(path.join(workspace, ...paths.plan.split("/")), plan);
    await writeJson(path.join(workspace, ...paths.context.split("/")), context);
    await writeJson(path.join(workspace, ...paths.approval.split("/")), executionApproval);
    await writeJson(path.join(workspace, ...paths.validation.split("/")), validation);
    const artifactPaths: string[] = [];
    for (const run of validation.runs) {
      const source = path.join(this.projectRoot, "validation", validation.batch_id, "sha256", run.log_digest);
      const contents = await readFile(source);
      if (sha256(contents) !== run.log_digest) {
        throw new DesignTraceError("INTEGRITY_ERROR", `Validation log ${run.log_digest} failed content addressing`);
      }
      const relative = `design/artifacts/sha256/${run.log_digest}`;
      const target = path.join(workspace, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      if (!(await exists(target))) await cp(source, target);
      artifactPaths.push(relative);
    }
    return [...Object.values(paths), ...artifactPaths];
  }

  private async readPlan(changeId: string, revision: number): Promise<ChangePlan> {
    const value = JSON.parse(await readFile(path.join(this.#sessionsRoot, changeId, "plans", `${revision}.json`), "utf8")) as unknown;
    validateChangePlan(value);
    return value;
  }

  private async readContext(changeId: string, contextId: string): Promise<ContextPackage> {
    return JSON.parse(await readFile(path.join(this.#sessionsRoot, changeId, "contexts", `${contextId}.json`), "utf8")) as ContextPackage;
  }

  private async readSnapshot(changeId: string, snapshotId: string): Promise<ExecutionSnapshot> {
    return JSON.parse(await readFile(path.join(this.#sessionsRoot, changeId, "snapshots", `${snapshotId}.json`), "utf8")) as ExecutionSnapshot;
  }

  private async readValidation(batchId: string): Promise<ValidationBatch> {
    return JSON.parse(await readFile(path.join(this.projectRoot, "validation", batchId, "batch.json"), "utf8")) as ValidationBatch;
  }

  private async readBundle(changeId: string, bundleId: string): Promise<ReviewBundle> {
    return JSON.parse(await readFile(path.join(this.#sessionsRoot, changeId, "bundles", `${bundleId}.json`), "utf8")) as ReviewBundle;
  }

  private async assertImmutableHistory(workspace: string, baselineCommit: string, payloadCommit: string): Promise<void> {
    const output = await git(
      workspace,
      ["diff", "--name-status", "-z", baselineCommit, payloadCommit],
      { trim: false },
    );
    const tokens = output.split("\0").filter(Boolean);
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++]!;
      const paths = status.startsWith("R") || status.startsWith("C")
        ? [tokens[index++]!, tokens[index++]!]
        : [tokens[index++]!];
      for (const changedPath of paths) {
        if (
          /^design\/(?:changes|decisions|evidence|approvals|receipts|plans|contexts|artifacts)\//u.test(changedPath) &&
          status !== "A"
        ) {
          throw new DesignTraceError("INTEGRITY_ERROR", `Published history is append-only: ${changedPath}`);
        }
      }
    }
  }

  private currentFormalCommit(): Promise<string> {
    return new FormalRepository(this.#repositoryPath).rawCurrentCommit();
  }
}
