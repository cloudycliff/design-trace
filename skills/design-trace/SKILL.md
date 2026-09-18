---
name: design-trace
description: Manage goal-first design and implementation changes through the local Design Trace kernel. Use when querying formal Rules or history, planning a controlled code/config change, requesting its two reviews, publishing it, or proposing a compensating revert.
---

# Design Trace

Use the Design Trace MCP tools as the source of truth for formal state. Work only in the active execution workspace returned by `start_execution`; never edit the managed bare repository, session records, approvals, payload refs, or formal `design/` records directly.

## Choose the workflow

- For questions about current behavior or rationale, call `query_design`. Use `get_history` when version chronology is the main request. Preserve `unknown` instead of inventing a reason.
- For a new change, follow the controlled workflow below.
- For an applied change that must be undone, call `propose_revert`. Treat the returned object as a new Change and follow the same controlled workflow. Never use `git revert` against the formal repository.

## Controlled change workflow

1. Call `begin_change` with the user's concrete goal and a stable idempotency key.
2. Query the affected Rules and build a complete plan draft. Keep file paths, JSON Pointers, protected checks, acceptance checks, design fields, and out-of-scope behavior explicit.
3. Call `revise_plan`. If context coverage is uncertain, surface it before requesting approval.
4. Call `request_review` with `stage: execution`. Give the returned `review_path` to the user together with the separately running loopback operator-server origin. Do not claim approval or call execution until status is `ready_to_execute`.
5. Call `start_execution`; edit only the returned attempt's execution directory and only the plan's allowed paths. Do not edit `design/` records—the kernel generates them.
6. Call `freeze_candidate`, then `run_validation`. On a scope or required-check failure, report the evidence and stop or revise; do not weaken tests or repeat until an accidental pass.
7. Call `build_result_review`, then `request_review` with `stage: result` and the returned bundle ID. Present the exact changed paths, validation evidence, impacts, and unknowns. Wait for status `ready_to_commit`.
8. Call `commit_change` with the active bundle. Report the official commit returned by the kernel.

## Approval boundary

The MCP server intentionally has no approval tool. Only the loopback operator page may create execution or result approvals. Never simulate a browser approval, reuse a prior bundle approval, pass an `approved` flag, or edit approval files.

## Recovery and stopping rules

Reuse the same idempotency key when retrying the same operation. If a call returns `STALE_BASELINE`, `REVERT_CONFLICT`, `INTEGRITY_ERROR`, or an approval/state error, stop mutation and explain the exact blocker. A changed goal, path, field, baseline, context, policy, or bundle requires a revised plan or new review rather than silent continuation.
