import { open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { DesignTraceError } from "./errors.js";

export class FileLock {
  static async acquire(lockPath: string): Promise<FileLock> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.sync();
      return new FileLock(lockPath, token, handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let owner: { pid?: number; token?: string };
        try {
          owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; token?: string };
        } catch (readError) {
          throw new DesignTraceError("INTEGRITY_ERROR", "Project lock record is unreadable", {
            cause: readError instanceof Error ? readError.message : String(readError),
          });
        }
        if (!Number.isInteger(owner.pid) || typeof owner.token !== "string") {
          throw new DesignTraceError("INTEGRITY_ERROR", "Project lock record is invalid");
        }
        try {
          process.kill(owner.pid!, 0);
          throw new DesignTraceError("INVALID_STATE", "Project is already processing another write operation", {
            ownerPid: owner.pid,
          });
        } catch (probeError) {
          if (probeError instanceof DesignTraceError) throw probeError;
          if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") {
            throw new DesignTraceError("INVALID_STATE", "Project lock owner cannot be safely classified as stale", {
              ownerPid: owner.pid,
            });
          }
        }
        try {
          await rm(lockPath);
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
        }
        return FileLock.acquire(lockPath);
      }
      throw error;
    }
  }

  private constructor(
    private readonly lockPath: string,
    private readonly token: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  async release(): Promise<void> {
    await this.handle.close();
    const contents = JSON.parse(await readFile(this.lockPath, "utf8")) as { token?: string };
    if (contents.token !== this.token) {
      throw new DesignTraceError("INTEGRITY_ERROR", "Project lock ownership changed before release");
    }
    await rm(this.lockPath);
  }
}

export async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const lock = await FileLock.acquire(lockPath);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
