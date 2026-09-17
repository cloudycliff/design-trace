import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { digestObject, sha256 } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { git } from "../git/git-client.js";
import { workspaceManifestDigest } from "../git/workspace-manifest.js";
import { GitTreeReader } from "../formal/formal-repository.js";
import { jsonPointer } from "./reconciliation.js";
import { loadProjectDefinition, type RegisteredCheck } from "./formal-objects.js";

const execFileAsync = promisify(execFile);

export type ValidationResult = "passed" | "failed" | "unknown" | "error" | "timeout";

export interface ValidationRun {
  run_id: string;
  source_tree_oid: string;
  input_manifest_digest: string;
  check_id: string;
  check_version: number;
  runner_digest: string;
  environment_digest: string;
  result: ValidationResult;
  exit_code: number | null;
  log_digest: string;
  started_at: string;
  finished_at: string;
  required: boolean;
}

export interface ValidationBatch {
  batch_id: string;
  source_tree_oid: string;
  runs: ValidationRun[];
  all_required_passed: boolean;
}

export interface ValidationOptions {
  checkIds?: string[];
  parameterExpectations?: Record<string, string | number | boolean>;
}

function checkDefinition(check: RegisteredCheck): void {
  if (!check.id || !Number.isInteger(check.version) || typeof check.required !== "boolean") {
    throw new DesignTraceError("INVALID_PROJECT", "Validation check is missing required fields");
  }
  if (!check.runner || !(["builtin", "command"] as const).includes(check.runner.type)) {
    throw new DesignTraceError("INVALID_PROJECT", `Check ${check.id} has no supported runner`);
  }
}

export class ValidationService {
  constructor(
    private readonly repositoryPath: string,
    private readonly outputRoot: string,
  ) {}

  async run(revision = "refs/heads/dt-main", options: ValidationOptions = {}): Promise<ValidationBatch> {
    const commitOid = await git(process.cwd(), ["rev-parse", "--verify", `${revision}^{commit}`], {
      gitDir: this.repositoryPath,
    });
    const reader = new GitTreeReader(process.cwd(), commitOid, this.repositoryPath);
    const project = await loadProjectDefinition(reader);
    const registered = project.checks ?? [];
    const selected = options.checkIds
      ? options.checkIds.map((id) => {
          const check = registered.find((candidate) => candidate.id === id);
          if (!check) throw new DesignTraceError("INVALID_PROJECT", `Unknown validation check: ${id}`);
          return check;
        })
      : registered;
    const duplicateIds = selected.filter(
      (check, index) => selected.findIndex((candidate) => candidate.id === check.id) !== index,
    );
    if (duplicateIds.length > 0) {
      throw new DesignTraceError("INVALID_PROJECT", `Duplicate validation check: ${duplicateIds[0]!.id}`);
    }
    selected.forEach(checkDefinition);

    const sourceTreeOid = await reader.treeOid();
    const inputManifestDigest = digestObject({ source_tree_oid: sourceTreeOid });
    const environmentDigest = digestObject({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      project_environment: project.environment,
    });
    const batchId = `BATCH-${randomUUID().toUpperCase()}`;
    const batchRoot = path.join(this.outputRoot, batchId);
    await mkdir(path.join(batchRoot, "sha256"), { recursive: true });
    const runs: ValidationRun[] = [];

    for (const check of selected) {
      const started = new Date();
      const execution = await this.executeCheck(
        check,
        reader,
        commitOid,
        batchRoot,
        options.parameterExpectations?.[check.id],
      );
      const log = execution.log.endsWith("\n") ? execution.log : `${execution.log}\n`;
      const logDigest = sha256(Buffer.from(log, "utf8"));
      try {
        await writeFile(path.join(batchRoot, "sha256", logDigest), log, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      runs.push({
        run_id: `VAL-${randomUUID().toUpperCase()}`,
        source_tree_oid: sourceTreeOid,
        input_manifest_digest: inputManifestDigest,
        check_id: check.id,
        check_version: check.version,
        runner_digest: digestObject(check.runner),
        environment_digest: environmentDigest,
        result: execution.result,
        exit_code: execution.exitCode,
        log_digest: logDigest,
        started_at: started.toISOString(),
        finished_at: new Date().toISOString(),
        required: check.required,
      });
    }

    const batch: ValidationBatch = {
      batch_id: batchId,
      source_tree_oid: sourceTreeOid,
      runs,
      all_required_passed: runs.filter((run) => run.required).every((run) => run.result === "passed"),
    };
    await writeFile(path.join(batchRoot, "batch.json"), `${JSON.stringify(batch, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return batch;
  }

  private async executeCheck(
    check: RegisteredCheck,
    reader: GitTreeReader,
    revision: string,
    batchRoot: string,
    expectedOverride: string | number | boolean | undefined,
  ): Promise<{ result: ValidationResult; exitCode: number | null; log: string }> {
    if (check.kind === "human") {
      return { result: "unknown", exitCode: null, log: "Human acceptance has not been recorded." };
    }
    if (check.runner?.type === "builtin") {
      try {
        if (check.runner.name === "death-penalty-schema") {
          if (!check.input?.path) {
            throw new DesignTraceError("INVALID_PROJECT", `Check ${check.id} requires an input path`);
          }
          const document = JSON.parse(await reader.readText(check.input.path)) as Record<string, unknown>;
          for (const difficulty of ["normal", "hard"] as const) {
            const value = document[difficulty];
            if (
              value === null ||
              Array.isArray(value) ||
              typeof value !== "object" ||
              !Number.isInteger((value as Record<string, unknown>).penalty_bps) ||
              (value as Record<string, unknown>).rounding !== "floor"
            ) {
              throw new DesignTraceError("INVALID_PROJECT", `Invalid death penalty config for ${difficulty}`);
            }
          }
          return { result: "passed", exitCode: 0, log: "Death penalty JSON structure passed." };
        }
        if (check.runner.name === "json-pointer-equals") {
          if (!check.input?.path || !check.input.pointer) {
            throw new DesignTraceError("INVALID_PROJECT", `Check ${check.id} requires path and pointer`);
          }
          const expected = expectedOverride ?? check.expected;
          if (expected === undefined) {
            return { result: "unknown", exitCode: null, log: "No expected value was registered." };
          }
          const actual = jsonPointer(JSON.parse(await reader.readText(check.input.path)), check.input.pointer);
          const passed = Object.is(actual, expected);
          return {
            result: passed ? "passed" : "failed",
            exitCode: passed ? 0 : 1,
            log: `Expected ${JSON.stringify(expected)} at ${check.input.path}${check.input.pointer}; observed ${JSON.stringify(actual)}.`,
          };
        }
        return { result: "error", exitCode: null, log: `Unsupported builtin runner: ${String(check.runner.name)}` };
      } catch (error) {
        return { result: "error", exitCode: null, log: error instanceof Error ? error.message : String(error) };
      }
    }

    if (check.runner?.type !== "command" || check.runner.executable !== "node" || !check.runner.args) {
      return { result: "error", exitCode: null, log: "Command runner is not on the MVP allowlist." };
    }
    const workspace = path.join(batchRoot, `work-${check.id}`);
    try {
      await git(process.cwd(), ["clone", "--no-checkout", "--no-local", this.repositoryPath, workspace]);
      try {
        await git(workspace, [
          "fetch",
          this.repositoryPath,
          "+refs/dt/snapshots/*:refs/dt/snapshots/*",
        ]);
      } catch {
        // A baseline-only repository has no snapshot namespace yet.
      }
      await git(workspace, ["checkout", "--detach", revision]);
      const before = await git(workspace, ["status", "--porcelain"]);
      if (before) return { result: "error", exitCode: null, log: `Validation workspace was not clean before execution:\n${before}` };
      const beforeManifest = await workspaceManifestDigest(workspace);
      try {
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const completed = await execFileAsync(process.execPath, check.runner.args, {
          cwd: workspace,
          encoding: "utf8",
          windowsHide: true,
          env: childEnvironment,
          timeout: check.timeout_ms ?? 600_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const after = await git(workspace, ["status", "--porcelain"]);
        const afterManifest = await workspaceManifestDigest(workspace);
        if (after || afterManifest !== beforeManifest) {
          return {
            result: "error",
            exitCode: null,
            log: `Validation modified its inputs. Git status:\n${after || "(content digest changed without Git status output)"}`,
          };
        }
        return {
          result: "passed",
          exitCode: 0,
          log: `${completed.stdout}${completed.stderr}`,
        };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        const after = await git(workspace, ["status", "--porcelain"]);
        const afterManifest = await workspaceManifestDigest(workspace);
        if (after || afterManifest !== beforeManifest) {
          return {
            result: "error",
            exitCode: typeof failure.code === "number" ? failure.code : null,
            log: `Validation modified its inputs before failing:\n${after || "(content digest changed without Git status output)"}\n${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`,
          };
        }
        return {
          result: failure.killed ? "timeout" : "failed",
          exitCode: typeof failure.code === "number" ? failure.code : null,
          log: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`,
        };
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
