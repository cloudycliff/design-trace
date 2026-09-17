import { DesignTraceError } from "./errors.js";

export const changeStates = [
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
  "blocked",
  "interrupted",
  "cancelled",
] as const;

export type ChangeState = (typeof changeStates)[number];

const transitions: Readonly<Record<ChangeState, readonly ChangeState[]>> = {
  draft: ["awaiting_execution_approval", "cancelled"],
  awaiting_execution_approval: ["draft", "ready_to_execute", "cancelled"],
  ready_to_execute: ["awaiting_execution_approval", "executing", "cancelled"],
  executing: ["candidate_ready", "blocked", "interrupted", "cancelled"],
  candidate_ready: ["validating", "blocked", "cancelled"],
  validating: ["awaiting_result_approval", "blocked", "interrupted", "cancelled"],
  awaiting_result_approval: ["ready_to_commit", "blocked", "cancelled"],
  ready_to_commit: ["awaiting_result_approval", "committing", "cancelled"],
  committing: ["applied", "blocked"],
  blocked: ["draft", "ready_to_execute", "validating", "cancelled"],
  interrupted: ["blocked", "cancelled"],
  applied: [],
  cancelled: [],
};

export function assertTransition(from: ChangeState, to: ChangeState): void {
  if (!transitions[from].includes(to)) {
    throw new DesignTraceError(
      "INVALID_STATE",
      `Cannot transition a Change from ${from} to ${to}`,
      { from, to },
    );
  }
}
