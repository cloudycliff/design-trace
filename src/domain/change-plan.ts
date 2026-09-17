import { Ajv2020 } from "ajv/dist/2020.js";
import { DesignTraceError } from "../core/errors.js";

type Scalar = string | number | boolean;

export interface AllowedConfigChange {
  path: string;
  pointer: string;
  before: Scalar;
  after: Scalar;
}

export interface DesignChange {
  rule_id: string;
  fields: string[];
}

export interface ChangePlan {
  schema_version: 1;
  id: string;
  plan_revision: number;
  origin: "user_instruction";
  kind: "update" | "revert";
  baseline_commit: string;
  request: string;
  goal: string;
  targets: string[];
  allowed_paths: string[];
  allowed_config_changes: AllowedConfigChange[];
  design_changes: DesignChange[];
  out_of_scope: string[];
  protected_checks: string[];
  acceptance_checks: string[];
  risk_level: "low" | "medium" | "high" | "unsupported";
  policy_version: number;
  context_id: string;
  created_at: string;
  revert_of?: string;
}

export type ChangePlanDraft = Omit<
  ChangePlan,
  "schema_version" | "id" | "plan_revision" | "baseline_commit" | "context_id" | "created_at"
>;

const safePathPattern = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$";
const idPattern = "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$";
const scalarSchema = { type: ["string", "integer", "boolean"] } as const;

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "id", "plan_revision", "origin", "kind", "baseline_commit", "request", "goal",
    "targets", "allowed_paths", "allowed_config_changes", "design_changes", "out_of_scope",
    "protected_checks", "acceptance_checks", "risk_level", "policy_version", "context_id", "created_at",
  ],
  properties: {
    schema_version: { type: "integer", const: 1 },
    id: { type: "string", pattern: "^CHG-[A-Z0-9-]+$" },
    plan_revision: { type: "integer", minimum: 1 },
    origin: { type: "string", const: "user_instruction" },
    kind: { type: "string", enum: ["update", "revert"] },
    baseline_commit: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    request: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    targets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: idPattern } },
    allowed_paths: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: safePathPattern } },
    allowed_config_changes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "pointer", "before", "after"],
        properties: {
          path: { type: "string", pattern: safePathPattern },
          pointer: { type: "string", pattern: "^(?:/(?:[^~/]|~[01])*)+$" },
          before: scalarSchema,
          after: scalarSchema,
        },
      },
    },
    design_changes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule_id", "fields"],
        properties: {
          rule_id: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
          fields: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
      },
    },
    out_of_scope: { type: "array", items: { type: "string", minLength: 1 } },
    protected_checks: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^CHECK-[A-Z0-9-]+$" } },
    acceptance_checks: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^CHECK-[A-Z0-9-]+$" } },
    risk_level: { type: "string", enum: ["low", "medium", "high", "unsupported"] },
    policy_version: { type: "integer", minimum: 1 },
    context_id: { type: "string", pattern: "^CTX-[A-Z0-9-]+$" },
    created_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" },
    revert_of: { type: "string", pattern: "^CHG-[A-Z0-9-]+$" },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile<ChangePlan>(schema);

export function validateChangePlan(plan: unknown): asserts plan is ChangePlan {
  if (!validate(plan)) {
    throw new DesignTraceError(
      "INVALID_PROJECT",
      "ChangePlan does not satisfy schema v1",
      { errors: validate.errors ?? [] },
    );
  }
}
