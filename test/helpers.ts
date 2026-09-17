import { cp, mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/git/git-client.js";

export async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function committedFixture(): Promise<{ root: string; commit: string }> {
  const root = await temporaryDirectory("dt-fixture-");
  const fixture = path.resolve("fixtures/death-penalty");
  await cp(fixture, root, { recursive: true });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Design Trace Tests"]);
  await git(root, ["config", "user.email", "tests@design-trace.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Fixture baseline"]);
  return { root, commit: await git(root, ["rev-parse", "HEAD"]) };
}

export async function kernelDirectory(): Promise<string> {
  const root = await temporaryDirectory("dt-kernel-");
  const data = path.join(root, "kernel-data");
  await mkdir(data);
  return data;
}
