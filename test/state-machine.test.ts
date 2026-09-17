import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition } from "../src/core/state-machine.js";
import { DesignTraceError } from "../src/core/errors.js";

test("the documented happy-path transitions are legal", () => {
  const states = [
    "draft",
    "awaiting_execution_approval",
    "ready_to_execute",
    "executing",
    "candidate_ready",
    "validating",
    "awaiting_result_approval",
    "ready_to_commit",
    "committing",
    "applied",
  ] as const;
  for (let index = 0; index < states.length - 1; index += 1) {
    assert.doesNotThrow(() => assertTransition(states[index]!, states[index + 1]!));
  }
});

test("terminal and skipped transitions are rejected", () => {
  assert.throws(() => assertTransition("draft", "executing"), (error) => {
    assert.ok(error instanceof DesignTraceError);
    assert.equal(error.code, "INVALID_STATE");
    return true;
  });
  assert.throws(() => assertTransition("applied", "draft"), { name: "DesignTraceError" });
  assert.throws(() => assertTransition("cancelled", "draft"), { name: "DesignTraceError" });
});
