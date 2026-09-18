import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestObject, sha256 } from "../core/digest.js";
import { DesignTraceError } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { FormalRepository } from "../formal/formal-repository.js";

interface BackupManifest {
  schema_version: 1;
  project_id: string;
  formal_commit: string;
  created_at: string;
  credentials: "excluded";
  files: Array<{ path: string; size: number; sha256: string }>;
  manifest_digest: string;
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

async function fileManifest(root: string, relative = ""): Promise<BackupManifest["files"]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files: BackupManifest["files"] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, ...child.split("/"));
    if (entry.isSymbolicLink()) throw new DesignTraceError("UNSUPPORTED_RESOURCE", `Backup contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await fileManifest(root, child));
    else if (entry.isFile() && child !== "backup.json") {
      const contents = await readFile(absolute);
      files.push({ path: child, size: contents.length, sha256: sha256(contents) });
    }
  }
  return files;
}

export class BackupService {
  constructor(private readonly projectRoot: string) {}

  async create(destination: string, now = new Date()): Promise<BackupManifest> {
    const target = path.resolve(destination);
    const relative = path.relative(this.projectRoot, target);
    if (!relative.startsWith("..") || relative === "") {
      throw new DesignTraceError("INVALID_PROJECT", "Backup destination must be outside the project data directory");
    }
    if (await exists(target)) throw new DesignTraceError("INVALID_PROJECT", `Backup destination already exists: ${target}`);
    return withFileLock(path.join(this.projectRoot, ".write.lock"), async () => {
      const metadata = JSON.parse(await readFile(path.join(this.projectRoot, "project.json"), "utf8")) as {
        project_id?: string;
      };
      if (typeof metadata.project_id !== "string") throw new DesignTraceError("INTEGRITY_ERROR", "Project metadata is invalid");
      const formalCommit = await new FormalRepository(path.join(this.projectRoot, "repository.git")).currentCommit();
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = await mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-`));
      try {
        for (const name of ["project.json", "repository.git", "sessions", "validation"]) {
          const source = path.join(this.projectRoot, name);
          if (await exists(source)) await cp(source, path.join(temporary, name), { recursive: true });
        }
        const files = await fileManifest(temporary);
        const unsigned = {
          schema_version: 1 as const,
          project_id: metadata.project_id,
          formal_commit: formalCommit,
          created_at: now.toISOString(),
          credentials: "excluded" as const,
          files,
        };
        const manifest: BackupManifest = { ...unsigned, manifest_digest: digestObject(unsigned) };
        await writeFile(path.join(temporary, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(temporary, target);
        return manifest;
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    });
  }

  static async verify(backupRoot: string): Promise<BackupManifest> {
    const root = path.resolve(backupRoot);
    const manifest = JSON.parse(await readFile(path.join(root, "backup.json"), "utf8")) as BackupManifest;
    const { manifest_digest: manifestDigest, ...unsigned } = manifest;
    if (
      manifest.schema_version !== 1 ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(manifest.project_id) ||
      digestObject(unsigned) !== manifestDigest
    ) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Backup manifest digest is invalid");
    }
    const actual = await fileManifest(root);
    if (digestObject(actual) !== digestObject(manifest.files)) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Backup files do not match the manifest");
    }
    const repository = new FormalRepository(path.join(root, "repository.git"));
    if (await repository.currentCommit() !== manifest.formal_commit) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Backup formal reference does not match its manifest");
    }
    return manifest;
  }

  static async restore(backupRoot: string, kernelDataRoot: string): Promise<string> {
    const source = path.resolve(backupRoot);
    const manifest = await BackupService.verify(source);
    const destination = path.resolve(kernelDataRoot, manifest.project_id);
    if (await exists(destination)) {
      throw new DesignTraceError("INVALID_PROJECT", `Restore destination already exists: ${destination}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = await mkdtemp(path.join(path.dirname(destination), `.${manifest.project_id}-restore-`));
    try {
      for (const name of ["project.json", "repository.git", "sessions", "validation"]) {
        const item = path.join(source, name);
        if (await exists(item)) await cp(item, path.join(temporary, name), { recursive: true });
      }
      await rename(temporary, destination);
      await new FormalRepository(path.join(destination, "repository.git")).currentCommit();
      return destination;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}
