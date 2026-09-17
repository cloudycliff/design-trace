export type ErrorCode =
  | "INVALID_STATE"
  | "STALE_PLAN"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "CONTENT_CHANGED"
  | "SCOPE_VIOLATION"
  | "VALIDATION_FAILED"
  | "STALE_BASELINE"
  | "IDEMPOTENCY_CONFLICT"
  | "INTEGRITY_ERROR"
  | "INVALID_PROJECT"
  | "DIRTY_WORKTREE"
  | "UNSUPPORTED_RESOURCE";

export class DesignTraceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DesignTraceError";
  }
}
