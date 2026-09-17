import { canonicalJson } from "../core/digest.js";
import type { TreeReader } from "../formal/project-validator.js";
import { loadProjectDefinition, type ImplementationBinding, type Rule } from "./formal-objects.js";

export type ReconciliationStatus = "consistent" | "conflict" | "design_only" | "unknown";

export interface ReconciliationResult {
  rule_id: string;
  rule_version: number;
  binding_id: string;
  binding_version: number;
  status: ReconciliationStatus;
  expected?: unknown;
  observed?: unknown;
  source?: { tree_oid: string; path: string; pointer: string; blob_oid?: string };
  reasons: string[];
}

function fieldValue(root: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

export function jsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").reduce<unknown>((value, rawSegment) => {
    if (value === null || typeof value !== "object") return undefined;
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    return (value as Record<string, unknown>)[segment];
  }, root);
}

export async function reconcileBinding(
  reader: TreeReader,
  rule: Rule,
  binding: ImplementationBinding,
): Promise<ReconciliationResult> {
  const project = await loadProjectDefinition(reader);
  const covered = project.extraction_coverage?.paths.includes(binding.path) ?? false;
  const base = {
    rule_id: rule.id,
    rule_version: rule.version,
    binding_id: binding.id,
    binding_version: binding.version,
  };
  if (!covered) return { ...base, status: "unknown", reasons: ["path_outside_extraction_coverage"] };
  if (binding.rule_id !== rule.id || binding.comparator !== "exact") {
    return { ...base, status: "unknown", reasons: ["unsupported_binding"] };
  }
  if (canonicalJson(binding.conditions) !== canonicalJson(rule.conditions)) {
    return { ...base, status: "unknown", reasons: ["condition_mismatch"] };
  }

  const files = await reader.listFiles();
  if (!files.some((file) => file.path === binding.path)) {
    return { ...base, status: "design_only", reasons: ["authoritative_path_missing"] };
  }
  try {
    const document = JSON.parse(await reader.readText(binding.path)) as unknown;
    const observed = jsonPointer(document, binding.pointer);
    const expected = fieldValue(rule, binding.rule_field);
    const source = {
      tree_oid: reader.treeOid ? await reader.treeOid() : "unknown",
      path: binding.path,
      pointer: binding.pointer,
      ...(reader.blobOid ? { blob_oid: await reader.blobOid(binding.path) } : {}),
    };
    if (observed === undefined) {
      return { ...base, status: "design_only", expected, source, reasons: ["bound_pointer_missing"] };
    }
    const typeMatches =
      (binding.value_type === "integer" && Number.isInteger(observed)) ||
      (binding.value_type === "boolean" && typeof observed === "boolean") ||
      (binding.value_type === "enum" && typeof observed === "string");
    if (!typeMatches) {
      return { ...base, status: "unknown", expected, observed, source, reasons: ["value_type_mismatch"] };
    }
    return {
      ...base,
      status: canonicalJson(expected) === canonicalJson(observed) ? "consistent" : "conflict",
      expected,
      observed,
      source,
      reasons: [],
    };
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      reasons: [`read_or_parse_failed:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
