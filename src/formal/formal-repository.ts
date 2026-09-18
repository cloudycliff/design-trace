import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DesignTraceError } from "../core/errors.js";
import { git } from "../git/git-client.js";
import { validateBaseline, type TreeReader, type ValidatedBaseline } from "./project-validator.js";
import { validateFormalTree } from "./formal-integrity.js";

const FORMAL_REF = "refs/heads/dt-main";

export class GitTreeReader implements TreeReader {
  constructor(
    private readonly workingDirectory: string,
    private readonly revision: string,
    private readonly gitDirectory?: string,
  ) {}

  async listFiles(): Promise<Array<{ mode: string; path: string }>> {
    const output = await this.run(["ls-tree", "-r", this.revision]);
    if (!output) return [];
    return output.split(/\r?\n/u).map((line) => {
      const match = /^(\d+)\s+\w+\s+[0-9a-f]+\t(.+)$/u.exec(line);
      if (!match?.[1] || !match[2]) {
        throw new DesignTraceError("INVALID_PROJECT", `Cannot parse Git tree entry: ${line}`);
      }
      return { mode: match[1], path: match[2] };
    });
  }

  readText(filePath: string): Promise<string> {
    return this.run(["show", `${this.revision}:${filePath}`]);
  }

  readRawText(filePath: string): Promise<string> {
    return git(
      this.workingDirectory,
      ["show", `${this.revision}:${filePath}`],
      this.gitDirectory ? { gitDir: this.gitDirectory, trim: false } : { trim: false },
    );
  }

  blobOid(filePath: string): Promise<string> {
    return this.run(["rev-parse", `${this.revision}:${filePath}`]);
  }

  treeOid(): Promise<string> {
    return this.run(["rev-parse", `${this.revision}^{tree}`]);
  }

  private run(args: string[]): Promise<string> {
    return git(this.workingDirectory, args, this.gitDirectory ? { gitDir: this.gitDirectory } : {});
  }
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
    const baseline = await validateBaseline(new GitTreeReader(sourceRepository, commit));
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
      const bootstrapWorkspace = path.join(temporaryRoot, "bootstrap-workspace");
      await git(sourceRepository, ["clone", "--no-checkout", "--no-local", temporaryRepository, bootstrapWorkspace]);
      await git(bootstrapWorkspace, ["checkout", "--detach", commit]);
      const bootstrapChangePath = path.join(bootstrapWorkspace, "design", "changes", "bootstrap.md");
      try {
        await access(bootstrapChangePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path.dirname(bootstrapChangePath), { recursive: true });
        await writeFile(
          bootstrapChangePath,
          "---\nschema_version: 1\nid: CHG-BOOTSTRAP\nstatus: applied\nkind: bootstrap\nreason: unknown\n---\n\n# Imported baseline\n",
          { encoding: "utf8", flag: "wx" },
        );
      }
      const bootstrapReceiptPath = path.join(bootstrapWorkspace, "design", "receipts", "CHG-BOOTSTRAP.json");
      await mkdir(path.dirname(bootstrapReceiptPath), { recursive: true });
      await writeFile(
        bootstrapReceiptPath,
        `${JSON.stringify({
          schema_version: 1,
          change_id: "CHG-BOOTSTRAP",
          kind: "bootstrap",
          imported_commit: commit,
          parent_commit: commit,
          project_id: requestedProjectId,
          created_at: new Date().toISOString(),
          records: ["design/changes/bootstrap.md", "design/receipts/CHG-BOOTSTRAP.json"],
        }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await git(bootstrapWorkspace, ["config", "user.name", "Design Trace Kernel"]);
      await git(bootstrapWorkspace, ["config", "user.email", "kernel@design-trace.invalid"]);
      await git(bootstrapWorkspace, ["add", "design/changes", "design/receipts"]);
      await git(bootstrapWorkspace, ["commit", "--no-gpg-sign", "--no-verify", "-m", "Initialize Design Trace formal repository"]);
      const formalCommit = await git(bootstrapWorkspace, ["rev-parse", "HEAD"]);
      await validateFormalTree(new GitTreeReader(bootstrapWorkspace, formalCommit));
      await git(bootstrapWorkspace, ["push", temporaryRepository, `HEAD:${FORMAL_REF}`]);
      await rm(bootstrapWorkspace, { recursive: true, force: true });
      await writeFile(
        path.join(temporaryRoot, "project.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            project_id: requestedProjectId,
            formal_ref: FORMAL_REF,
            imported_commit: commit,
            last_verified_commit: formalCommit,
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
      formalCommit: await git(process.cwd(), ["rev-parse", FORMAL_REF], { gitDir: path.join(projectRoot, "repository.git") }),
      formalRef: FORMAL_REF,
      repositoryPath: path.join(projectRoot, "repository.git"),
    };
  }

  constructor(private readonly repositoryPath: string) {}

  async currentCommit(): Promise<string> {
    const current = await this.rawCurrentCommit();
    const metadata = JSON.parse(
      await readFile(path.join(path.dirname(this.repositoryPath), "project.json"), "utf8"),
    ) as { last_verified_commit?: string };
    if (metadata.last_verified_commit !== current) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Formal reference moved without a verified publication record", {
        expected: metadata.last_verified_commit,
        actual: current,
      });
    }
    return current;
  }

  async assertWriteCompatible(): Promise<string> {
    const current = await this.currentCommit();
    await validateFormalTree(this.treeReader(current));
    return current;
  }

  async rawCurrentCommit(): Promise<string> {
    return git(process.cwd(), ["rev-parse", "--verify", FORMAL_REF], { gitDir: this.repositoryPath });
  }

  async markVerifiedCommit(commit: string, previousCommit: string): Promise<void> {
    const current = await this.rawCurrentCommit();
    if (current !== commit) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Cannot verify a commit that is not the formal reference");
    }
    await validateFormalTree(this.treeReader(commit));
    const metadataPath = path.join(path.dirname(this.repositoryPath), "project.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    if (metadata.last_verified_commit !== previousCommit && metadata.last_verified_commit !== commit) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Verified commit ledger does not continue from the expected baseline");
    }
    if (metadata.last_verified_commit === commit) return;
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ ...metadata, last_verified_commit: commit }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporary, metadataPath);
  }

  async readFormalText(filePath: string): Promise<string> {
    if (path.posix.isAbsolute(filePath) || filePath.split("/").includes("..") || filePath.includes("\\")) {
      throw new DesignTraceError("INVALID_PROJECT", `Unsafe formal path: ${filePath}`);
    }
    return git(process.cwd(), ["show", `${FORMAL_REF}:${filePath}`], { gitDir: this.repositoryPath });
  }

  treeReader(revision = FORMAL_REF): GitTreeReader {
    return new GitTreeReader(process.cwd(), revision, this.repositoryPath);
  }
}
