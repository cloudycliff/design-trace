import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DesignTraceError } from "../src/core/errors.js";
import { ChangeSessionService } from "../src/domain/change-session-service.js";
import { FormalRepository, GitTreeReader } from "../src/formal/formal-repository.js";
import { git } from "../src/git/git-client.js";
import { committedFixture, kernelDirectory, temporaryDirectory } from "./helpers.js";

test("initialization creates a reproducible formal ref from a clean commit", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  assert.notEqual(initialized.formalCommit, source.commit);
  assert.equal(
    await (await import("../src/git/git-client.js")).git(
      process.cwd(),
      ["rev-parse", `${initialized.formalCommit}^`],
      { gitDir: initialized.repositoryPath },
    ),
    source.commit,
  );
  assert.equal(initialized.normalPenaltyBps, 1000);
  assert.equal(initialized.hardPenaltyBps, 1000);

  await appendFile(path.join(source.root, "config/death-penalty.json"), "\n");
  const formal = new FormalRepository(initialized.repositoryPath);
  const saved = JSON.parse(await formal.readFormalText("config/death-penalty.json")) as {
    normal: { penalty_bps: number };
  };
  assert.equal(saved.normal.penalty_bps, 1000);
  assert.equal(await formal.currentCommit(), initialized.formalCommit);
  assert.match(await formal.readFormalText("design/receipts/CHG-BOOTSTRAP.json"), /CHG-BOOTSTRAP/u);
});

test("dirty source is rejected before any formal project is created", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await appendFile(path.join(source.root, "config/death-penalty.json"), "\n");
  await assert.rejects(
    FormalRepository.initialize(source.root, data, "death-penalty-fixture"),
    (error) => error instanceof DesignTraceError && error.code === "DIRTY_WORKTREE",
  );
});

test("project IDs cannot escape the kernel data directory", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await assert.rejects(
    FormalRepository.initialize(source.root, data, "../outside"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT",
  );
});

test("baseline with a Rule/config mismatch is rejected", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const rulePath = path.join(source.root, "design/rules/death-normal.md");
  const { readFile, writeFile } = await import("node:fs/promises");
  const rule = await readFile(rulePath, "utf8");
  await writeFile(rulePath, rule.replace("penalty_bps: 1000", "penalty_bps: 500"));
  const { git } = await import("../src/git/git-client.js");
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Break binding"]);
  await assert.rejects(
    FormalRepository.initialize(source.root, data, "death-penalty-fixture"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT",
  );
});

test("formal tree rejects duplicate IDs across immutable Markdown records", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  await copyFile(
    path.join(source.root, "design", "changes", "bootstrap.md"),
    path.join(source.root, "design", "changes", "duplicate.md"),
  );
  const { git } = await import("../src/git/git-client.js");
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Duplicate formal ID"]);
  await assert.rejects(
    FormalRepository.initialize(source.root, data, "death-penalty-fixture"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT",
  );
});

test("an incompatible formal schema blocks new writes without rewriting compatible history", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const initialized = await FormalRepository.initialize(source.root, data, "death-penalty-fixture");
  const projectRoot = path.join(data, "death-penalty-fixture");
  const workspace = await temporaryDirectory("dt-incompatible-");
  await git(process.cwd(), ["clone", "--no-checkout", "--no-local", initialized.repositoryPath, workspace]);
  await git(workspace, ["checkout", "--detach", initialized.formalCommit]);
  const projectPath = path.join(workspace, "design/project.yaml");
  await writeFile(projectPath, (await readFile(projectPath, "utf8")).replace("schema_version: 1", "schema_version: 99"));
  await git(workspace, ["config", "user.name", "Compatibility Test"]);
  await git(workspace, ["config", "user.email", "compatibility@design-trace.invalid"]);
  await git(workspace, ["add", "design/project.yaml"]);
  await git(workspace, ["commit", "-m", "Simulate a future schema"]);
  const incompatibleCommit = await git(workspace, ["rev-parse", "HEAD"]);
  await git(process.cwd(), ["fetch", workspace, incompatibleCommit], { gitDir: initialized.repositoryPath });
  await git(process.cwd(), ["update-ref", "refs/heads/dt-main", incompatibleCommit, initialized.formalCommit], {
    gitDir: initialized.repositoryPath,
  });
  const metadataPath = path.join(projectRoot, "project.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, last_verified_commit: incompatibleCommit }, null, 2)}\n`);

  const service = new ChangeSessionService(projectRoot, "death-penalty-fixture");
  await assert.rejects(
    service.beginChange("must not write through an incompatible schema", "future-schema"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT" && /project schema v1/u.test(error.message),
  );
  assert.equal(await git(process.cwd(), ["cat-file", "-t", initialized.formalCommit], { gitDir: initialized.repositoryPath }), "commit");
  assert.match(
    await new GitTreeReader(process.cwd(), initialized.formalCommit, initialized.repositoryPath).readText("design/project.yaml"),
    /schema_version: 1/u,
  );
});

test("formal object schemas reject unknown fields", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const rulePath = path.join(source.root, "design/rules/death-normal.md");
  await writeFile(rulePath, (await readFile(rulePath, "utf8")).replace("status: active", "status: active\nunexpected: true"));
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Add an unknown Rule field"]);
  await assert.rejects(
    FormalRepository.initialize(source.root, data, "death-penalty-fixture"),
    (error) => error instanceof DesignTraceError && error.code === "INVALID_PROJECT" && /rules schema v1/u.test(error.message),
  );
});
