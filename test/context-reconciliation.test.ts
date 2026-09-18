import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildContext } from "../src/domain/context-service.js";
import { loadFormalObjects } from "../src/domain/formal-objects.js";
import { reconcileBinding } from "../src/domain/reconciliation.js";
import { GitTreeReader } from "../src/formal/formal-repository.js";
import { git } from "../src/git/git-client.js";
import { committedFixture } from "./helpers.js";

test("context contains a stable digest and verified one-hop impact", async () => {
  const source = await committedFixture();
  const reader = new GitTreeReader(source.root, source.commit);
  const first = await buildContext(reader, ["RULE-DEATH-NORMAL"]);
  const second = await buildContext(reader, ["RULE-DEATH-NORMAL"]);

  assert.equal(first.context_digest, second.context_digest);
  assert.deepEqual(first.targets.map((rule) => rule.id), ["RULE-DEATH-NORMAL"]);
  assert.deepEqual(first.bindings.map((binding) => binding.id), ["BIND-DEATH-NORMAL"]);
  assert.deepEqual(first.definite_impacts.map((impact) => impact.rule.id), ["RULE-TUTORIAL-DEATH"]);
  assert.deepEqual(first.coverage_gaps, []);
});

test("stale relation is downgraded and reported as a coverage gap", async () => {
  const source = await committedFixture();
  const relationPath = path.join(source.root, "design/relations/death-tutorial.md");
  const relation = await readFile(relationPath, "utf8");
  await writeFile(relationPath, relation.replace("from: 1", "from: 99"));
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Make relation stale"]);
  const commit = await git(source.root, ["rev-parse", "HEAD"]);
  const context = await buildContext(new GitTreeReader(source.root, commit), ["RULE-DEATH-NORMAL"]);

  assert.equal(context.definite_impacts.length, 0);
  assert.deepEqual(context.possible_impacts.map((impact) => impact.rule.id), ["RULE-TUTORIAL-DEATH"]);
  assert.deepEqual(context.coverage_gaps[0]?.reasons, ["stale_versions"]);
});

test("JSON Pointer reconciliation distinguishes consistent and conflict", async () => {
  const source = await committedFixture();
  const baselineReader = new GitTreeReader(source.root, source.commit);
  const objects = await loadFormalObjects(baselineReader);
  const rule = objects.rules.find((candidate) => candidate.id === "RULE-DEATH-NORMAL")!;
  const binding = objects.bindings.find((candidate) => candidate.id === "BIND-DEATH-NORMAL")!;
  const consistent = await reconcileBinding(baselineReader, rule, binding);
  assert.equal(consistent.status, "consistent");
  assert.equal(consistent.observed, 1000);
  assert.ok(consistent.source?.blob_oid);

  const configPath = path.join(source.root, "config/death-penalty.json");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, config.replace('"penalty_bps": 1000', '"penalty_bps": 500'));
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Create implementation drift"]);
  const driftCommit = await git(source.root, ["rev-parse", "HEAD"]);
  const conflict = await reconcileBinding(new GitTreeReader(source.root, driftCommit), rule, binding);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.expected, 1000);
  assert.equal(conflict.observed, 500);
});

test("impact analysis limits propagation to two hops and reports cycles", async () => {
  const source = await committedFixture();
  await writeFile(path.join(source.root, "design/relations/tutorial-hard.md"), `---
schema_version: 1
id: REL-TUTORIAL-HARD
version: 1
from: RULE-TUTORIAL-DEATH
to: RULE-DEATH-HARD
type: affects
source: explicit
verification: verified
verified_versions:
  from: 1
  to: 1
evidence_ids:
  - EVD-RELATION-REVIEW
last_verified_at: 2026-09-17T00:00:00Z
created_at: 2026-09-17T00:00:00Z
---

# Tutorial impact on hard mode
`);
  await writeFile(path.join(source.root, "design/relations/hard-normal.md"), `---
schema_version: 1
id: REL-HARD-NORMAL
version: 1
from: RULE-DEATH-HARD
to: RULE-DEATH-NORMAL
type: affects
source: explicit
verification: verified
verified_versions:
  from: 1
  to: 1
evidence_ids:
  - EVD-RELATION-REVIEW
last_verified_at: 2026-09-17T00:00:00Z
created_at: 2026-09-17T00:00:00Z
---

# Cycle back to normal mode
`);
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Add a bounded impact cycle"]);
  const commit = await git(source.root, ["rev-parse", "HEAD"]);
  const context = await buildContext(new GitTreeReader(source.root, commit), ["RULE-DEATH-NORMAL"]);

  assert.deepEqual(context.definite_impacts.map((impact) => [impact.rule.id, impact.depth]), [
    ["RULE-TUTORIAL-DEATH", 1],
  ]);
  assert.deepEqual(context.possible_impacts.map((impact) => [impact.rule.id, impact.depth, impact.path]), [
    ["RULE-DEATH-HARD", 2, ["RULE-DEATH-NORMAL", "RULE-TUTORIAL-DEATH", "RULE-DEATH-HARD"]],
  ]);
  assert.ok(context.coverage_gaps.some((gap) => gap.reasons.includes("multi_hop_uncertain")));
  assert.ok(context.coverage_gaps.some((gap) => gap.relation_id === "REL-HARD-NORMAL" && gap.reasons.includes("cycle_detected")));
});

test("reconciliation returns unknown for unsupported coverage, environment, and units", async () => {
  const source = await committedFixture();
  const baselineReader = new GitTreeReader(source.root, source.commit);
  const objects = await loadFormalObjects(baselineReader);
  const rule = objects.rules.find((candidate) => candidate.id === "RULE-DEATH-NORMAL")!;
  const binding = objects.bindings.find((candidate) => candidate.id === "BIND-DEATH-NORMAL")!;

  assert.deepEqual((await reconcileBinding(baselineReader, rule, { ...binding, environment: "production" })).reasons, [
    "environment_mismatch",
  ]);
  assert.deepEqual((await reconcileBinding(baselineReader, rule, { ...binding, unit: "percent" })).reasons, [
    "unit_mismatch",
  ]);

  const projectPath = path.join(source.root, "design/project.yaml");
  const project = await readFile(projectPath, "utf8");
  await writeFile(projectPath, project.replace("kind: json-pointer", "kind: runtime-dynamic"));
  await git(source.root, ["add", "."]);
  await git(source.root, ["commit", "-m", "Mark extraction as dynamic"]);
  const commit = await git(source.root, ["rev-parse", "HEAD"]);
  const dynamic = await reconcileBinding(new GitTreeReader(source.root, commit), rule, binding);
  assert.equal(dynamic.status, "unknown");
  assert.deepEqual(dynamic.reasons, ["unsupported_extraction_coverage"]);
});
