import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { committedFixture, kernelDirectory } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("CLI initializes and reads from the formal ref", async () => {
  const source = await committedFixture();
  const data = await kernelDirectory();
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const initialized = await execFileAsync(
    process.execPath,
    [cli, "init", "--source", source.root, "--data", data, "--project", "death-penalty-fixture"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(initialized.stdout).formalCommit, source.commit);

  const shown = await execFileAsync(
    process.execPath,
    [
      cli,
      "show",
      "--data",
      data,
      "--project",
      "death-penalty-fixture",
      "--file",
      "config/death-penalty.json",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(shown.stdout).hard.penalty_bps, 1000);
});
