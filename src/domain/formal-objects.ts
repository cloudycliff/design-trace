import { DesignTraceError } from "../core/errors.js";
import type { TreeReader } from "../formal/project-validator.js";
import { parseFrontmatter, parseYamlObject } from "../formal/frontmatter.js";

export interface Rule {
  schema_version: 1;
  id: string;
  version: number;
  status: string;
  system: string;
  statement: string;
  conditions: Record<string, unknown>;
  parameters: Record<string, unknown>;
  decision_bindings: Array<{ decision_id: string; fields: string[] }>;
  last_change_id: string | null;
}

export interface Decision {
  schema_version: 1;
  id: string;
  targets: Array<{ rule_id: string; rule_version: number; fields: string[] }>;
  decision: string;
  rationale: string;
  rationale_source: string;
  evidence_ids: string[];
  alternatives: unknown;
  supersedes: Array<{ decision_id: string; rule_id: string; fields: string[] }>;
  created_at: string;
}

export interface ImplementationBinding {
  schema_version: 1;
  id: string;
  version: number;
  rule_id: string;
  rule_field: string;
  path: string;
  pointer: string;
  value_type: "integer" | "boolean" | "enum";
  unit: string;
  conditions: Record<string, unknown>;
  comparator: "exact";
  environment: string;
  verification_check_id: string;
}

export interface Relation {
  schema_version: 1;
  id: string;
  version: number;
  from: string;
  to: string;
  type: "depends_on" | "constrained_by" | "affects" | "conflicts_with";
  source: "explicit" | "deterministic" | "ai_inferred";
  verification: "verified" | "unverified";
  verified_versions: { from: number; to: number };
  evidence_ids: string[];
}

export interface ProjectDefinition {
  schema_version: 1;
  project_id: string;
  pilot_system: string;
  environment: string;
  pilot_config: string;
  policy_version: number;
  extraction_coverage?: { kind: string; paths: string[] };
  checks?: RegisteredCheck[];
}

export interface RegisteredCheck {
  id: string;
  version: number;
  kind: "structure" | "parameter" | "behavior" | "regression" | "human";
  required: boolean;
  input?: { path: string; pointer?: string };
  expected?: string | number | boolean;
  runner?: { type: "builtin" | "command"; name?: string; executable?: string; args?: string[] };
  timeout_ms?: number;
  environment?: string;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must be an integer`);
  }
  return value as number;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DesignTraceError("INVALID_PROJECT", `${label} must be a string array`);
  }
  return value;
}

export async function loadProjectDefinition(reader: TreeReader): Promise<ProjectDefinition> {
  const raw = parseYamlObject(await reader.readText("design/project.yaml"), "design/project.yaml");
  return raw as unknown as ProjectDefinition;
}

export async function loadFormalObjects(reader: TreeReader): Promise<{
  rules: Rule[];
  decisions: Decision[];
  bindings: ImplementationBinding[];
  relations: Relation[];
  evidenceIds: Set<string>;
}> {
  const files = await reader.listFiles();
  const rules: Rule[] = [];
  const decisions: Decision[] = [];
  const bindings: ImplementationBinding[] = [];
  const relations: Relation[] = [];
  const evidenceIds = new Set<string>();
  const allIds = new Set<string>();

  for (const file of files) {
    const kind = /^design\/(rules|decisions|bindings|relations|evidence)\/[^/]+\.md$/u.exec(file.path)?.[1];
    if (!kind) continue;
    const raw = parseFrontmatter(await reader.readText(file.path), file.path);
    if (raw.schema_version !== 1) {
      throw new DesignTraceError("INVALID_PROJECT", `${file.path} must use schema_version 1`);
    }
    const id = requireString(raw.id, `${file.path}.id`);
    if (allIds.has(id)) throw new DesignTraceError("INVALID_PROJECT", `Duplicate formal object ID: ${id}`);
    allIds.add(id);

    if (kind === "rules") {
      const rawBindings = raw.decision_bindings ?? [];
      if (!Array.isArray(rawBindings)) {
        throw new DesignTraceError("INVALID_PROJECT", `${file.path}.decision_bindings must be an array`);
      }
      rules.push({
        schema_version: 1,
        id,
        version: requireInteger(raw.version, `${file.path}.version`),
        status: requireString(raw.status, `${file.path}.status`),
        system: requireString(raw.system, `${file.path}.system`),
        statement: requireString(raw.statement, `${file.path}.statement`),
        conditions: requireObject(raw.conditions, `${file.path}.conditions`),
        parameters: requireObject(raw.parameters, `${file.path}.parameters`),
        decision_bindings: rawBindings.map((value, index) => {
          const binding = requireObject(value, `${file.path}.decision_bindings[${index}]`);
          return {
            decision_id: requireString(binding.decision_id, `${file.path}.decision_bindings[${index}].decision_id`),
            fields: requireStringArray(binding.fields, `${file.path}.decision_bindings[${index}].fields`),
          };
        }),
        last_change_id: raw.last_change_id === undefined
          ? null
          : requireString(raw.last_change_id, `${file.path}.last_change_id`),
      });
    } else if (kind === "decisions") {
      if (!Array.isArray(raw.targets) || !Array.isArray(raw.supersedes)) {
        throw new DesignTraceError("INVALID_PROJECT", `${file.path} Decision targets and supersedes must be arrays`);
      }
      decisions.push({
        schema_version: 1,
        id,
        targets: raw.targets.map((value, index) => {
          const target = requireObject(value, `${file.path}.targets[${index}]`);
          return {
            rule_id: requireString(target.rule_id, `${file.path}.targets[${index}].rule_id`),
            rule_version: requireInteger(target.rule_version, `${file.path}.targets[${index}].rule_version`),
            fields: requireStringArray(target.fields, `${file.path}.targets[${index}].fields`),
          };
        }),
        decision: requireString(raw.decision, `${file.path}.decision`),
        rationale: requireString(raw.rationale, `${file.path}.rationale`),
        rationale_source: requireString(raw.rationale_source, `${file.path}.rationale_source`),
        evidence_ids: requireStringArray(raw.evidence_ids, `${file.path}.evidence_ids`),
        alternatives: raw.alternatives ?? "unknown",
        supersedes: raw.supersedes.map((value, index) => {
          const superseded = requireObject(value, `${file.path}.supersedes[${index}]`);
          return {
            decision_id: requireString(superseded.decision_id, `${file.path}.supersedes[${index}].decision_id`),
            rule_id: requireString(superseded.rule_id, `${file.path}.supersedes[${index}].rule_id`),
            fields: requireStringArray(superseded.fields, `${file.path}.supersedes[${index}].fields`),
          };
        }),
        created_at: requireString(raw.created_at, `${file.path}.created_at`),
      });
    } else if (kind === "bindings") {
      bindings.push({
        schema_version: 1,
        id,
        version: requireInteger(raw.version, `${file.path}.version`),
        rule_id: requireString(raw.rule_id, `${file.path}.rule_id`),
        rule_field: requireString(raw.rule_field, `${file.path}.rule_field`),
        path: requireString(raw.path, `${file.path}.path`),
        pointer: requireString(raw.pointer, `${file.path}.pointer`),
        value_type: requireString(raw.value_type, `${file.path}.value_type`) as ImplementationBinding["value_type"],
        unit: requireString(raw.unit, `${file.path}.unit`),
        conditions: requireObject(raw.conditions, `${file.path}.conditions`),
        comparator: requireString(raw.comparator, `${file.path}.comparator`) as "exact",
        environment: requireString(raw.environment, `${file.path}.environment`),
        verification_check_id: requireString(raw.verification_check_id, `${file.path}.verification_check_id`),
      });
    } else if (kind === "relations") {
      const versions = requireObject(raw.verified_versions, `${file.path}.verified_versions`);
      relations.push({
        schema_version: 1,
        id,
        version: requireInteger(raw.version, `${file.path}.version`),
        from: requireString(raw.from, `${file.path}.from`),
        to: requireString(raw.to, `${file.path}.to`),
        type: requireString(raw.type, `${file.path}.type`) as Relation["type"],
        source: requireString(raw.source, `${file.path}.source`) as Relation["source"],
        verification: requireString(raw.verification, `${file.path}.verification`) as Relation["verification"],
        verified_versions: {
          from: requireInteger(versions.from, `${file.path}.verified_versions.from`),
          to: requireInteger(versions.to, `${file.path}.verified_versions.to`),
        },
        evidence_ids: requireStringArray(raw.evidence_ids, `${file.path}.evidence_ids`),
      });
    } else {
      evidenceIds.add(id);
    }
  }

  const ruleIds = new Set(rules.map((rule) => rule.id));
  for (const binding of bindings) {
    if (!ruleIds.has(binding.rule_id)) {
      throw new DesignTraceError("INVALID_PROJECT", `Binding ${binding.id} references missing Rule ${binding.rule_id}`);
    }
  }
  for (const relation of relations) {
    if (!ruleIds.has(relation.from) || !ruleIds.has(relation.to)) {
      throw new DesignTraceError("INVALID_PROJECT", `Relation ${relation.id} has a missing endpoint`);
    }
  }
  const decisionIds = new Set(decisions.map((decision) => decision.id));
  for (const rule of rules) {
    for (const binding of rule.decision_bindings) {
      if (!decisionIds.has(binding.decision_id)) {
        throw new DesignTraceError("INVALID_PROJECT", `Rule ${rule.id} references missing Decision ${binding.decision_id}`);
      }
    }
  }
  return { rules, decisions, bindings, relations, evidenceIds };
}
