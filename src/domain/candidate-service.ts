import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, digestObject } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { EventStore } from "../core/event-store.js";
import { withFileLock } from "../core/file-lock.js";
import { GitTreeReader } from "../formal/formal-repository.js";
import { git } from "../git/git-client.js";
import { workspaceManifestDigest } from "../git/workspace-manifest.js";
import { validateChangePlan, type ChangePlan } from "./change-plan.js";
import { loadFormalObjects } from "./formal-objects.js";
import { jsonPointer } from "./reconciliation.js";
import { ValidationService, type ValidationBatch } from "./validation-service.js";

export interface ExecutionSnapshot {
  snapshot_id: string;
  attempt_id: string;
  snapshot_commit: string;
  execution_tree_oid: string;
  input_manifest_digest: string;
  changed_paths: string[];
  changed_pointers: Array<{ path: string; pointer: string; before: unknown; after: unknown }>;
  frozen_at: string;
}

function assertRuntimeId(value: string, prefix: "CHG" | "ATT" | "SNP"): void {
  if (!new RegExp(`^${prefix}-[A-Z0-9-]{1,64}$`, "u").test(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `Invalid ${prefix} ID`);
  }
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonDiff(left: unknown, right: unknown, pointer = ""): Array<{ pointer: string; before: unknown; after: unknown }> {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object" ||
    Array.isArray(left) || Array.isArray(right)
  ) {
    return [{ pointer, before: left, after: right }];
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
  return keys.flatMap((key) =>
    jsonDiff(leftObject[key], rightObject[key], `${pointer}/${escapePointer(key)}`),
  );
}

function parseStatus(output: string): Array<{ status: string; path: string }> {
  const tokens = output.split("\0").filter(Boolean);
  const changes: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    if (status.includes("R") || status.includes("C")) {
      throw new DesignTraceError("SCOPE_VIOLATION", "Renames and copies are not supported in the MVP");
    }
    changes.push({ status, path: filePath });
  }
  return changes;
}

export class CandidateService {
  readonly #sessionsRoot: string;
  readonly #repositoryPath: string;
  readonly #lockPath: string;

  constructor(private readonly projectRoot: string) {
    this.#sessionsRoot = path.join(projectRoot, "sessions");
    this.#repositoryPath = path.join(projectRoot, "repository.git");
    this.#lockPath = path.join(projectRoot, ".write.lock");
  }

  async freezeCandidate(
    changeId: string,
    attemptId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ExecutionSnapshot> {
    assertRuntimeId(changeId, "CHG");
    assertRuntimeId(attemptId, "ATT");
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      let session = await store.recover();
      const requestDigest = digestObject({ change_id: changeId, attempt_id: attemptId });
      const prior = await store.findOperation("freeze_candidate", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as ExecutionSnapshot;
      if (session.state !== "executing" || session.activeAttemptId !== attemptId) {
        throw new DesignTraceError("INVALID_STATE", "Only the active executing attempt can be frozen");
      }
      const plan = await this.readPlan(changeId, session.planRevision);
      const workspace = path.join(this.projectRoot, "execution", attemptId);
      try {
        const baselineHead = await git(workspace, ["rev-parse", "HEAD"]);
        if (baselineHead !== plan.baseline_commit) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Execution workspace baseline changed");
        }
        const statusOutput = await git(
          workspace,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { trim: false },
        );
        const changes = parseStatus(statusOutput);
        if (changes.length === 0) {
          throw new DesignTraceError("SCOPE_VIOLATION", "Candidate contains no implementation changes");
        }
        const allowedPaths = new Set(plan.allowed_paths);
        for (const change of changes) {
          if (!allowedPaths.has(change.path)) {
            throw new DesignTraceError("SCOPE_VIOLATION", `Path is outside the approved plan: ${change.path}`);
          }
          if (change.status.includes("D")) {
            throw new DesignTraceError("SCOPE_VIOLATION", `Deleting files is not approved: ${change.path}`);
          }
          if ((await lstat(path.join(workspace, ...change.path.split("/")))).isSymbolicLink()) {
            throw new DesignTraceError("UNSUPPORTED_RESOURCE", `Symbolic links are not supported: ${change.path}`);
          }
        }

        const baselineReader = new GitTreeReader(process.cwd(), plan.baseline_commit, this.#repositoryPath);
        const pointerChanges: ExecutionSnapshot["changed_pointers"] = [];
        for (const changedPath of [...new Set(changes.map((change) => change.path))]) {
          const planned = plan.allowed_config_changes.filter((change) => change.path === changedPath);
          if (planned.length === 0) {
            throw new DesignTraceError("SCOPE_VIOLATION", `No structured field changes were approved for ${changedPath}`);
          }
          let before: unknown;
          let after: unknown;
          try {
            before = JSON.parse(await baselineReader.readText(changedPath)) as unknown;
            after = JSON.parse(await readFile(path.join(workspace, ...changedPath.split("/")), "utf8")) as unknown;
          } catch (error) {
            throw new DesignTraceError(
              "SCOPE_VIOLATION",
              `Changed config is not valid JSON: ${changedPath}`,
              { cause: error instanceof Error ? error.message : String(error) },
            );
          }
          const actual = jsonDiff(before, after);
          const approvedPointers = new Set(planned.map((change) => change.pointer));
          if (actual.some((change) => !approvedPointers.has(change.pointer))) {
            throw new DesignTraceError(
              "SCOPE_VIOLATION",
              `Unapproved JSON field changed in ${changedPath}`,
              { actual },
            );
          }
          for (const approved of planned) {
            const actualChange = actual.find((change) => change.pointer === approved.pointer);
            if (
              !actualChange ||
              canonicalJson(actualChange.before) !== canonicalJson(approved.before) ||
              canonicalJson(actualChange.after) !== canonicalJson(approved.after) ||
              canonicalJson(jsonPointer(before, approved.pointer)) !== canonicalJson(approved.before) ||
              canonicalJson(jsonPointer(after, approved.pointer)) !== canonicalJson(approved.after)
            ) {
              throw new DesignTraceError(
                "SCOPE_VIOLATION",
                `Approved JSON change was not implemented exactly: ${changedPath}${approved.pointer}`,
              );
            }
            pointerChanges.push({ path: changedPath, ...actualChange });
          }
        }

        const beforeManifest = await workspaceManifestDigest(workspace);
        await git(workspace, ["reset", "--mixed", plan.baseline_commit]);
        await git(workspace, ["add", "--all"]);
        await git(workspace, ["config", "user.name", "Design Trace Kernel"]);
        await git(workspace, ["config", "user.email", "kernel@design-trace.invalid"]);
        await git(workspace, [
          "commit",
          "--no-gpg-sign",
          "--no-verify",
          "-m",
          `DT snapshot ${changeId} ${attemptId}`,
        ]);
        const afterManifest = await workspaceManifestDigest(workspace);
        if (beforeManifest !== afterManifest) {
          throw new DesignTraceError("CONTENT_CHANGED", "Execution workspace changed while the snapshot was frozen");
        }
        const snapshotCommit = await git(workspace, ["rev-parse", "HEAD"]);
        const treeOid = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
        const snapshotId = `SNP-${digestObject({ changeId, attemptId, treeOid }).slice(0, 16).toUpperCase()}`;
        await git(workspace, [
          "push",
          this.#repositoryPath,
          `HEAD:refs/dt/snapshots/${changeId}/${attemptId}`,
        ]);
        const snapshot: ExecutionSnapshot = {
          snapshot_id: snapshotId,
          attempt_id: attemptId,
          snapshot_commit: snapshotCommit,
          execution_tree_oid: treeOid,
          input_manifest_digest: digestObject({ execution_tree_oid: treeOid }),
          changed_paths: [...new Set(changes.map((change) => change.path))].sort(),
          changed_pointers: pointerChanges,
          frozen_at: now.toISOString(),
        };
        const snapshotsDirectory = path.join(this.#sessionsRoot, changeId, "snapshots");
        await mkdir(snapshotsDirectory, { recursive: true });
        await writeFile(
          path.join(snapshotsDirectory, `${snapshotId}.json`),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await store.recordCandidateFrozen(snapshotId, attemptId, snapshotCommit, treeOid, now);
        session = await store.transition("candidate_ready", "candidate snapshot frozen", now);
        void session;
        await store.recordOperation("freeze_candidate", idempotencyKey, requestDigest, snapshot, now);
        return snapshot;
      } catch (error) {
        if (
          error instanceof DesignTraceError &&
          (error.code === "SCOPE_VIOLATION" || error.code === "UNSUPPORTED_RESOURCE")
        ) {
          await store.transition("blocked", error.message, now);
        } else if (error instanceof DesignTraceError && error.code === "CONTENT_CHANGED") {
          await store.transition("interrupted", error.message, now);
        }
        throw error;
      }
    });
  }

  async validateCandidate(
    changeId: string,
    snapshotId: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<ValidationBatch> {
    assertRuntimeId(changeId, "CHG");
    assertRuntimeId(snapshotId, "SNP");
    return withFileLock(this.#lockPath, async () => {
      const store = new EventStore(this.#sessionsRoot, changeId);
      let session = await store.recover();
      const requestDigest = digestObject({ change_id: changeId, snapshot_id: snapshotId });
      const prior = await store.findOperation("validate_candidate", idempotencyKey, requestDigest);
      if (prior !== undefined) return prior as ValidationBatch;
      if (session.state !== "candidate_ready" || session.activeSnapshotId !== snapshotId) {
        throw new DesignTraceError("INVALID_STATE", "Only the active candidate snapshot can be validated");
      }
      const snapshot = JSON.parse(
        await readFile(path.join(this.#sessionsRoot, changeId, "snapshots", `${snapshotId}.json`), "utf8"),
      ) as ExecutionSnapshot;
      if (snapshot.snapshot_commit !== session.activeSnapshotCommit) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Snapshot record does not match the active session");
      }
      const retainedCommit = await git(
        process.cwd(),
        ["rev-parse", `refs/dt/snapshots/${changeId}/${snapshot.attempt_id}`],
        { gitDir: this.#repositoryPath },
      );
      const retainedTree = await git(
        process.cwd(),
        ["rev-parse", `${snapshot.snapshot_commit}^{tree}`],
        { gitDir: this.#repositoryPath },
      );
      if (
        retainedCommit !== snapshot.snapshot_commit ||
        retainedTree !== snapshot.execution_tree_oid ||
        snapshot.snapshot_id !==
          `SNP-${digestObject({ changeId, attemptId: snapshot.attempt_id, treeOid: retainedTree })
            .slice(0, 16)
            .toUpperCase()}`
      ) {
        throw new DesignTraceError("INTEGRITY_ERROR", "Retained snapshot reference or tree is invalid");
      }
      const plan = await this.readPlan(changeId, session.planRevision);
      session = await store.transition("validating", "candidate validation started", now);
      void session;
      const baselineObjects = await loadFormalObjects(
        new GitTreeReader(process.cwd(), plan.baseline_commit, this.#repositoryPath),
      );
      const expectations: Record<string, string | number | boolean> = {};
      for (const change of plan.allowed_config_changes) {
        const binding = baselineObjects.bindings.find(
          (candidate) => candidate.path === change.path && candidate.pointer === change.pointer,
        );
        if (binding && ["string", "number", "boolean"].includes(typeof change.after)) {
          expectations[binding.verification_check_id] = change.after;
        }
      }
      const checkIds = [...new Set([...plan.acceptance_checks, ...plan.protected_checks])];
      let validation: ValidationBatch;
      try {
        validation = await new ValidationService(
          this.#repositoryPath,
          path.join(this.projectRoot, "validation"),
        ).run(snapshot.snapshot_commit, { checkIds, parameterExpectations: expectations });
      } catch (error) {
        await store.transition(
          "interrupted",
          `validation runner error: ${error instanceof Error ? error.message : String(error)}`,
          now,
        );
        throw error;
      }
      await store.recordValidationCompleted(snapshotId, validation.batch_id, validation.all_required_passed, now);
      if (validation.all_required_passed) {
        await store.transition("awaiting_result_approval", "all required checks passed", now);
      } else {
        await store.transition("blocked", "required validation did not pass", now);
      }
      await store.recordOperation("validate_candidate", idempotencyKey, requestDigest, validation, now);
      return validation;
    });
  }

  private async readPlan(changeId: string, revision: number): Promise<ChangePlan> {
    const plan = JSON.parse(
      await readFile(path.join(this.#sessionsRoot, changeId, "plans", `${revision}.json`), "utf8"),
    ) as unknown;
    validateChangePlan(plan);
    return plan;
  }
}
