import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DesignTraceError } from "../core/errors.js";
import { git } from "../git/git-client.js";
import { validateBaseline, type TreeReader, type ValidatedBaseline } from "./project-validator.js";

const FORMAL_REF = "refs/heads/dt-main";

function commitReader(sourceRepository: string, commit: string): TreeReader {
  return {
    async listFiles() {
      const output = await git(sourceRepository, ["ls-tree", "-r", commit]);
      if (!output) return [];
      return output.split(/\r?\n/u).map((line) => {
        const match = /^(\d+)\s+\w+\s+[0-9a-f]+\t(.+)$/u.exec(line);
        if (!match?.[1] || !match[2]) {
          throw new DesignTraceError("INVALID_PROJECT", `Cannot parse Git tree entry: ${line}`);
        }
        return { mode: match[1], path: match[2] };
      });
    },
    readText(filePath: string) {
      return git(sourceRepository, ["show", `${commit}:${filePath}`]);
    },
  };
}

export interface InitializedProject extends ValidatedBaseline {
  formalCommit: string;
  formalRef: string;
  repositoryPath: string;
}

export class FormalRepository {
  static async initialize(
    sourceRepository: string,
    kernelDataRoot: string,
    requestedProjectId: string,
    revision = "HEAD",
  ): Promise<InitializedProject> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(requestedProjectId)) {
      throw new DesignTraceError(
        "INVALID_PROJECT",
        "Project ID must be 1-64 lowercase letters, digits, or hyphens",
      );
    }
    const dirty = await git(sourceRepository, ["status", "--porcelain"]);
    if (dirty) {
      throw new DesignTraceError(
        "DIRTY_WORKTREE",
        "Initialization requires a clean, explicitly committed baseline",
        { entries: dirty.split(/\r?\n/u) },
      );
    }
    const commit = await git(sourceRepository, ["rev-parse", "--verify", `${revision}^{commit}`]);
    const baseline = await validateBaseline(commitReader(sourceRepository, commit));
    if (baseline.projectId !== requestedProjectId) {
      throw new DesignTraceError(
        "INVALID_PROJECT",
        `Requested project ${requestedProjectId} does not match baseline ${baseline.projectId}`,
      );
    }

    const projectRoot = path.resolve(kernelDataRoot, requestedProjectId);
    try {
      await access(projectRoot);
      throw new DesignTraceError("INVALID_PROJECT", `Project is already initialized: ${requestedProjectId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await mkdir(kernelDataRoot, { recursive: true });
    const temporaryRoot = path.join(kernelDataRoot, `.${requestedProjectId}.initializing-${randomUUID()}`);
    const temporaryRepository = path.join(temporaryRoot, "repository.git");
    await mkdir(temporaryRoot, { recursive: false });
    try {
      await git(sourceRepository, ["clone", "--bare", "--no-local", sourceRepository, temporaryRepository]);
      await git(sourceRepository, ["update-ref", FORMAL_REF, commit, ""], { gitDir: temporaryRepository });
      await writeFile(
        path.join(temporaryRoot, "project.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            project_id: requestedProjectId,
            formal_ref: FORMAL_REF,
            last_verified_commit: commit,
            initialized_at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryRoot, projectRoot);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
    return {
      ...baseline,
      formalCommit: commit,
      formalRef: FORMAL_REF,
      repositoryPath: path.join(projectRoot, "repository.git"),
    };
  }

  constructor(private readonly repositoryPath: string) {}

  async currentCommit(): Promise<string> {
    return git(process.cwd(), ["rev-parse", "--verify", FORMAL_REF], { gitDir: this.repositoryPath });
  }

  async readFormalText(filePath: string): Promise<string> {
    if (path.posix.isAbsolute(filePath) || filePath.split("/").includes("..") || filePath.includes("\\")) {
      throw new DesignTraceError("INVALID_PROJECT", `Unsafe formal path: ${filePath}`);
    }
    return git(process.cwd(), ["show", `${FORMAL_REF}:${filePath}`], { gitDir: this.repositoryPath });
  }
}
