import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { DesignTraceError } from "../src/core/errors.js";
import { FormalRepository } from "../src/formal/formal-repository.js";
import { committedFixture, kernelDirectory } from "./helpers.js";

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
