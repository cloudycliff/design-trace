import { Ajv2020 } from "ajv/dist/2020.js";
import { DesignTraceError } from "../core/errors.js";

export type FormalObjectKind = "rules" | "decisions" | "bindings" | "relations" | "evidence";

const nonEmptyString = { type: "string", minLength: 1 } as const;
const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$",
} as const;
const stringArray = { type: "array", uniqueItems: true, items: nonEmptyString } as const;
const fields = { type: "array", minItems: 1, uniqueItems: true, items: nonEmptyString } as const;
const safePath = { type: "string", pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$" } as const;

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "id", "version", "status", "system", "statement", "conditions", "parameters",
    "acceptance_ids", "decision_bindings", "last_change_id", "created_at",
  ],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
    version: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["active", "deprecated"] },
    system: nonEmptyString,
    statement: nonEmptyString,
    conditions: { type: "object" },
    parameters: { type: "object" },
    acceptance_ids: stringArray,
    decision_bindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision_id", "fields"],
        properties: {
          decision_id: { type: "string", pattern: "^DEC-[A-Z0-9-]+$" },
          fields,
        },
      },
    },
    last_change_id: { anyOf: [{ type: "string", pattern: "^CHG-[A-Z0-9-]+$" }, { type: "null" }] },
    created_at: timestamp,
  },
} as const;

const decisionTarget = {
  type: "object",
  additionalProperties: false,
  required: ["rule_id", "rule_version", "fields"],
  properties: {
    rule_id: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
    rule_version: { type: "integer", minimum: 1 },
    fields,
  },
} as const;

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "id", "targets", "decision", "rationale", "rationale_source", "evidence_ids",
    "alternatives", "supersedes", "created_at",
  ],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", pattern: "^DEC-[A-Z0-9-]+$" },
    targets: { type: "array", minItems: 1, items: decisionTarget },
    decision: nonEmptyString,
    rationale: nonEmptyString,
    rationale_source: { type: "string", enum: ["user_statement", "evidence", "unknown"] },
    evidence_ids: stringArray,
    alternatives: {},
    supersedes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision_id", "rule_id", "fields"],
        properties: {
          decision_id: { type: "string", pattern: "^DEC-[A-Z0-9-]+$" },
          rule_id: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
          fields,
        },
      },
    },
    created_at: timestamp,
  },
} as const;

const bindingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "id", "version", "rule_id", "rule_field", "path", "pointer", "value_type", "unit",
    "conditions", "comparator", "environment", "verification_check_id", "created_at",
  ],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", pattern: "^BIND-[A-Z0-9-]+$" },
    version: { type: "integer", minimum: 1 },
    rule_id: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
    rule_field: nonEmptyString,
    path: safePath,
    pointer: { type: "string", pattern: "^(?:/(?:[^~/]|~[01])*)+$" },
    value_type: { type: "string", enum: ["integer", "boolean", "enum"] },
    unit: nonEmptyString,
    conditions: { type: "object" },
    comparator: { const: "exact" },
    environment: nonEmptyString,
    verification_check_id: { type: "string", pattern: "^CHECK-[A-Z0-9-]+$" },
    created_at: timestamp,
  },
} as const;

const relationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "id", "version", "from", "to", "type", "source", "verification",
    "verified_versions", "evidence_ids", "last_verified_at", "created_at",
  ],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", pattern: "^REL-[A-Z0-9-]+$" },
    version: { type: "integer", minimum: 1 },
    from: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
    to: { type: "string", pattern: "^RULE-[A-Z0-9-]+$" },
    type: { type: "string", enum: ["depends_on", "constrained_by", "affects", "conflicts_with"] },
    source: { type: "string", enum: ["explicit", "deterministic", "ai_inferred"] },
    verification: { type: "string", enum: ["verified", "unverified"] },
    verified_versions: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        from: { type: "integer", minimum: 1 },
        to: { type: "integer", minimum: 1 },
      },
    },
    evidence_ids: stringArray,
    last_verified_at: timestamp,
    created_at: timestamp,
  },
} as const;

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "id", "kind", "source", "scope", "content_digest", "created_at"],
  properties: {
    schema_version: { const: 1 },
    id: { type: "string", pattern: "^EVD-[A-Z0-9-]+$" },
    kind: nonEmptyString,
    source: nonEmptyString,
    scope: nonEmptyString,
    content_digest: nonEmptyString,
    created_at: timestamp,
  },
} as const;

const checkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "kind", "required", "runner"],
  properties: {
    id: { type: "string", pattern: "^CHECK-[A-Z0-9-]+$" },
    version: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: ["structure", "parameter", "behavior", "regression", "human"] },
    required: { type: "boolean" },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: safePath, pointer: { type: "string" } },
    },
    expected: { type: ["string", "integer", "boolean"] },
    runner: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["builtin", "command"] },
        name: nonEmptyString,
        executable: nonEmptyString,
        args: { type: "array", items: { type: "string" } },
      },
    },
    timeout_ms: { type: "integer", minimum: 1 },
    environment: nonEmptyString,
  },
} as const;

const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "project_id", "pilot_system", "environment", "pilot_config", "policy_version"],
  properties: {
    schema_version: { const: 1 },
    project_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    pilot_system: nonEmptyString,
    environment: nonEmptyString,
    pilot_config: safePath,
    policy_version: { type: "integer", minimum: 1 },
    extraction_coverage: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "paths"],
      properties: { kind: nonEmptyString, paths: { type: "array", uniqueItems: true, items: safePath } },
    },
    checks: { type: "array", uniqueItems: true, items: checkSchema },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = {
  rules: ajv.compile(ruleSchema),
  decisions: ajv.compile(decisionSchema),
  bindings: ajv.compile(bindingSchema),
  relations: ajv.compile(relationSchema),
  evidence: ajv.compile(evidenceSchema),
};
const validateProject = ajv.compile(projectSchema);

export function validateFormalObject(kind: FormalObjectKind, value: unknown, label: string): void {
  const validate = validators[kind];
  if (!validate(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} does not satisfy the ${kind} schema v1`, {
      errors: validate.errors ?? [],
    });
  }
}

export function validateProjectObject(value: unknown, label = "design/project.yaml"): void {
  if (!validateProject(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} does not satisfy the project schema v1`, {
      errors: validateProject.errors ?? [],
    });
  }
}
