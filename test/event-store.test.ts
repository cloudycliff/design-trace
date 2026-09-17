import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestObject } from "../src/core/digest.js";
import { DesignTraceError } from "../src/core/errors.js";
import { EventStore } from "../src/core/event-store.js";
import { temporaryDirectory } from "./helpers.js";

test("a session recovers state and idempotent results after restart", async () => {
  const root = await temporaryDirectory("dt-events-");
  const first = new EventStore(root, "CHG-001");
  await first.start(new Date("2026-09-17T00:00:00Z"));
  await first.transition("awaiting_execution_approval", "plan complete");
  const requestDigest = digestObject({ plan_revision: 1 });
  await first.recordOperation("revise_plan", "key-1", requestDigest, { plan_revision: 1 });

  const afterRestart = new EventStore(root, "CHG-001");
  const recovered = await afterRestart.recover();
  assert.equal(recovered.state, "awaiting_execution_approval");
  assert.deepEqual(
    await afterRestart.findOperation("revise_plan", "key-1", requestDigest),
    { plan_revision: 1 },
  );
  await afterRestart.recordOperation("revise_plan", "key-1", requestDigest, { ignored: true });
  assert.equal((await afterRestart.recover()).events.length, 3);
});

test("same idempotency key with different request is rejected", async () => {
  const root = await temporaryDirectory("dt-events-");
  const store = new EventStore(root, "CHG-002");
  await store.start();
  await store.recordOperation("begin_change", "same-key", digestObject({ request: "A" }), { id: 1 });
  await assert.rejects(
    store.findOperation("begin_change", "same-key", digestObject({ request: "B" })),
    (error) => error instanceof DesignTraceError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("tampered event log cannot be recovered", async () => {
  const root = await temporaryDirectory("dt-events-");
  const store = new EventStore(root, "CHG-003");
  await store.start();
  const logPath = path.join(root, "CHG-003", "events.jsonl");
  const contents = await readFile(logPath, "utf8");
  await writeFile(logPath, contents.replace('"state":"draft"', '"state":"applied"'));
  await assert.rejects(
    store.recover(),
    (error) => error instanceof DesignTraceError && error.code === "INTEGRITY_ERROR",
  );
});
