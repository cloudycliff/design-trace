import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { digestObject, sha256 } from "../core/digest.js";

export async function workspaceManifestDigest(root: string): Promise<string> {
  const entries: Array<{ path: string; digest: string }> = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!relativeDirectory && entry.name === ".git") continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push({ path: relativePath, digest: "unsupported-symlink" });
      } else if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, digest: sha256(await readFile(absolutePath)) });
      }
    }
  }
  await visit(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return digestObject(entries);
}
